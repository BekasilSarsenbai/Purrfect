const crypto = require("crypto");
const express = require("express");
const { z } = require("zod");
const env = require("../config/env");
const { prisma } = require("../config/prisma");
const { requireAuth, requireRoles } = require("../middleware/auth");
const { calculateSettlement } = require("../services/settlement-service");
const { ApiError } = require("../utils/errors");

const router = express.Router();

const createOrderSchema = z.object({
  listingId: z.string().uuid(),
  idempotencyKey: z.string().min(8).max(120).optional(),
});

router.post("/", requireAuth, requireRoles("BUYER"), async (req, res, next) => {
  try {
    const body = createOrderSchema.parse(req.body);

    const listing = await prisma.listing.findUnique({ where: { id: body.listingId } });
    if (!listing) throw new ApiError(404, "NOT_FOUND", "Listing not found");
    if (listing.status !== "PUBLISHED") throw new ApiError(409, "CONFLICT", "Listing is not available for order");
    if (listing.sellerId === req.user.id) throw new ApiError(409, "CONFLICT", "Cannot order own listing");
    const settlement = calculateSettlement(listing.priceKzt, env.PLATFORM_FEE_PERCENT);

    // COMPLEXITY_REQ_1: milestone escrow settlement with atomic transactional writes.
    const order = await prisma.$transaction(async (tx) => {
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
          amountKzt: listing.priceKzt,
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

      await tx.listing.update({ where: { id: listing.id }, data: { status: "RESERVED" } });

      return createdOrder;
    });

    return res.status(201).json(order);
  } catch (error) {
    if (error instanceof z.ZodError) {
      return next(new ApiError(422, "VALIDATION_ERROR", "Validation failed", error.flatten()));
    }
    return next(error);
  }
});

router.post("/:orderId/handover-confirm", requireAuth, requireRoles("BUYER"), async (req, res, next) => {
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

      return nextOrder;
    });

    return res.status(200).json(updated);
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
    const limit = Math.min(Number(req.query.limit || 20), 100);
    const cursor = req.query.cursor ? String(req.query.cursor) : null;

    const where = req.user.role === "BUYER" ? { buyerId: req.user.id } : { sellerId: req.user.id };
    const data = await prisma.order.findMany({
      where,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: limit + 1,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
    });

    const hasNext = data.length > limit;
    const slice = hasNext ? data.slice(0, limit) : data;
    const nextCursor = hasNext ? slice[slice.length - 1].id : null;

    return res.status(200).json({
      data: slice,
      meta: { hasNext, nextCursor },
    });
  } catch (error) {
    return next(error);
  }
});

module.exports = router;
