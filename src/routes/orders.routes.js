const crypto = require("crypto");
const express = require("express");
const { z } = require("zod");
const env = require("../config/env");
const { prisma } = require("../config/prisma");
const { requireAuth, requireRoles, requireVerifiedEmail } = require("../middleware/auth");
const { calculateSettlement } = require("../services/settlement-service");
const { parsePagination, buildPagedResponse } = require("../utils/pagination");
const { ApiError } = require("../utils/errors");
const { recordInAppNotification, emitEmail } = require("../services/notification-service");

const router = express.Router();

const createOrderSchema = z.object({
  listingId: z.string().uuid(),
  idempotencyKey: z.string().min(8).max(120).optional(),
});

router.post("/", requireAuth, requireVerifiedEmail, requireRoles("BUYER"), async (req, res, next) => {
  try {
    const body = createOrderSchema.parse(req.body);

    // COMPLEXITY_REQ_1: milestone escrow settlement with atomic transactional writes.
    // Concurrency guard via Prisma ORM compare-and-swap: updateMany flips the listing
    // PUBLISHED -> RESERVED in one atomic SQL UPDATE. If two buyers race, only one
    // UPDATE matches a PUBLISHED row; the other gets count=0 and is rejected. No raw SQL,
    // no SELECT FOR UPDATE — equivalent to a row-level write lock at the storage engine.
    const order = await prisma.$transaction(async (tx) => {
      const reserved = await tx.listing.updateMany({
        where: { id: body.listingId, status: "PUBLISHED" },
        data: { status: "RESERVED" },
      });

      if (reserved.count === 0) {
        const exists = await tx.listing.findUnique({
          where: { id: body.listingId },
          select: { id: true, sellerId: true, status: true },
        });
        if (!exists) throw new ApiError(404, "NOT_FOUND", "Listing not found");
        throw new ApiError(409, "CONFLICT", "Listing is not available for order");
      }

      const listing = await tx.listing.findUniqueOrThrow({
        where: { id: body.listingId },
        select: { id: true, sellerId: true, priceKzt: true },
      });

      if (listing.sellerId === req.user.id) {
        throw new ApiError(409, "CONFLICT", "Cannot order own listing");
      }

      const settlement = calculateSettlement(listing.priceKzt, env.PLATFORM_FEE_PERCENT);

      const createdOrder = await tx.order.create({
        data: {
          listingId: listing.id,
          buyerId: req.user.id,
          sellerId: listing.sellerId,
          status: "FUNDED_100",
          totalAmountKzt: settlement.totalAmountKzt,
          platformFeeKzt: settlement.platformFeeKzt,
          payout1Kzt: settlement.payout1Kzt,
          payout2Kzt: settlement.payout2Kzt,
          fundedAt: new Date(),
        },
      });

      await tx.escrowTransaction.create({
        data: {
          orderId: createdOrder.id,
          txType: "ESCROW_HOLD",
          amountKzt: settlement.totalAmountKzt,
          idempotencyKey: body.idempotencyKey || `escrow_${crypto.randomUUID()}`,
          metadataJson: { listingId: listing.id, buyerId: req.user.id },
        },
      });

      await tx.payout.createMany({
        data: [
          { orderId: createdOrder.id, milestone: 1, amountKzt: settlement.payout1Kzt, status: "FROZEN" },
          { orderId: createdOrder.id, milestone: 2, amountKzt: settlement.payout2Kzt, status: "FROZEN" },
        ],
      });

      await recordInAppNotification(tx, {
        userId: listing.sellerId,
        templateCode: "order.created.seller",
        payloadJson: { orderId: createdOrder.id, totalKzt: Number(settlement.totalAmountKzt) },
      });

      return { createdOrder, sellerId: listing.sellerId, totalKzt: Number(settlement.totalAmountKzt) };
    });

    // Post-commit side effect: queue email after the DB transaction succeeded.
    const seller = await prisma.user.findUnique({
      where: { id: order.sellerId },
      select: { email: true, displayName: true },
    });
    const listingTitle = (await prisma.listing.findUnique({
      where: { id: order.createdOrder.listingId },
      select: { title: true },
    }))?.title;
    await emitEmail({
      to: seller?.email,
      templateCode: "order.created.seller",
      payload: {
        orderId: order.createdOrder.id,
        listingTitle: listingTitle || "(unknown listing)",
        totalKzt: order.totalKzt,
        displayName: seller?.displayName || "seller",
      },
      idempotencyKey: `notify:order-created:${order.createdOrder.id}`,
    });

    return res.status(201).json(order.createdOrder);
  } catch (error) {
    if (error instanceof z.ZodError) {
      return next(new ApiError(422, "VALIDATION_ERROR", "Validation failed", error.flatten()));
    }
    return next(error);
  }
});

router.post("/:orderId/handover-confirm", requireAuth, requireVerifiedEmail, requireRoles("BUYER"), async (req, res, next) => {
  try {
    const orderId = z.string().uuid().parse(req.params.orderId);

    // COMPLEXITY_REQ_2: veterinary inspection gate starts 72h deadline on handover.
    const updated = await prisma.$transaction(async (tx) => {
      const order = await tx.order.findUnique({ where: { id: orderId } });
      if (!order) throw new ApiError(404, "NOT_FOUND", "Order not found");
      if (order.buyerId !== req.user.id) throw new ApiError(403, "FORBIDDEN", "Order does not belong to current user");
      if (order.status !== "FUNDED_100") throw new ApiError(409, "CONFLICT", "Order cannot be handed over in current status");

      const inspectionDeadline = new Date(Date.now() + 72 * 60 * 60 * 1000);
      const firstPayoutIdempotency = `payout1_${order.id}`;

      const nextOrder = await tx.order.update({
        where: { id: orderId },
        data: {
          status: "INSPECTION_ACTIVE",
          handoverAt: new Date(),
          inspectionDeadline,
        },
      });

      await tx.escrowTransaction.create({
        data: {
          orderId: order.id,
          txType: "PAYOUT_MILESTONE_1",
          amountKzt: order.payout1Kzt,
          idempotencyKey: firstPayoutIdempotency,
          metadataJson: { milestone: 1 },
        },
      });

      await tx.payout.update({
        where: { orderId_milestone: { orderId: order.id, milestone: 1 } },
        data: { releasedAt: new Date(), status: "RELEASED" },
      });

      await tx.inspection.upsert({
        where: { orderId: order.id },
        create: {
          orderId: order.id,
          buyerId: order.buyerId,
          status: "PENDING",
          deadlineAt: inspectionDeadline,
        },
        update: {
          status: "PENDING",
          deadlineAt: inspectionDeadline,
        },
      });

      await recordInAppNotification(tx, {
        userId: order.sellerId,
        templateCode: "order.handover.seller",
        payloadJson: { orderId: order.id, payout1Kzt: Number(order.payout1Kzt) },
      });

      return { nextOrder, sellerId: order.sellerId, payout1Kzt: Number(order.payout1Kzt) };
    });

    const seller = await prisma.user.findUnique({
      where: { id: updated.sellerId },
      select: { email: true, displayName: true },
    });
    await emitEmail({
      to: seller?.email,
      templateCode: "order.handover.seller",
      payload: {
        orderId: updated.nextOrder.id,
        payout1Kzt: updated.payout1Kzt,
        displayName: seller?.displayName || "seller",
      },
      idempotencyKey: `notify:handover:${updated.nextOrder.id}`,
    });

    return res.status(200).json(updated.nextOrder);
  } catch (error) {
    if (error instanceof z.ZodError) {
      return next(new ApiError(422, "VALIDATION_ERROR", "Validation failed", error.flatten()));
    }
    return next(error);
  }
});

router.get("/:orderId", requireAuth, async (req, res, next) => {
  try {
    const orderId = z.string().uuid().parse(req.params.orderId);
    const order = await prisma.order.findUnique({ where: { id: orderId } });
    if (!order) throw new ApiError(404, "NOT_FOUND", "Order not found");

    const isOwner = order.buyerId === req.user.id || order.sellerId === req.user.id;
    const isStaff = ["MODERATOR", "ADMIN"].includes(req.user.role);
    if (!isOwner && !isStaff) throw new ApiError(403, "FORBIDDEN", "No access to this order");

    return res.status(200).json(order);
  } catch (error) {
    if (error instanceof z.ZodError) return next(new ApiError(422, "VALIDATION_ERROR", "Validation failed", error.flatten()));
    return next(error);
  }
});

router.post("/:orderId/cancel", requireAuth, async (req, res, next) => {
  try {
    const orderId = z.string().uuid().parse(req.params.orderId);

    const updated = await prisma.$transaction(async (tx) => {
      const order = await tx.order.findUnique({ where: { id: orderId } });
      if (!order) throw new ApiError(404, "NOT_FOUND", "Order not found");
      const isOwner = order.buyerId === req.user.id || order.sellerId === req.user.id;
      if (!isOwner) throw new ApiError(403, "FORBIDDEN", "No access to this order");
      if (order.status !== "FUNDED_100") throw new ApiError(409, "CONFLICT", "Order cannot be cancelled now");

      await tx.escrowTransaction.create({
        data: {
          orderId,
          txType: "REFUND_FULL",
          amountKzt: order.totalAmountKzt,
          idempotencyKey: `cancel_refund_${orderId}`,
          metadataJson: { actorUserId: req.user.id },
        },
      });

      await tx.listing.update({
        where: { id: order.listingId },
        data: { status: "PUBLISHED" },
      });

      return tx.order.update({
        where: { id: orderId },
        data: { status: "CANCELLED" },
      });
    });
    return res.status(200).json(updated);
  } catch (error) {
    if (error instanceof z.ZodError) return next(new ApiError(422, "VALIDATION_ERROR", "Validation failed", error.flatten()));
    return next(error);
  }
});

router.get("/", requireAuth, async (req, res, next) => {
  try {
    const { limit, cursor } = parsePagination(req.query);

    let where = {};
    if (req.user.role === "BUYER") where = { buyerId: req.user.id };
    else if (req.user.role === "SELLER") where = { sellerId: req.user.id };
    else where = { OR: [{ buyerId: req.user.id }, { sellerId: req.user.id }] };

    const data = await prisma.order.findMany({
      where,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: limit + 1,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
    });

    return res.status(200).json(buildPagedResponse(data, limit));
  } catch (error) {
    if (error instanceof z.ZodError) return next(new ApiError(422, "VALIDATION_ERROR", "Validation failed", error.flatten()));
    return next(error);
  }
});

module.exports = router;
