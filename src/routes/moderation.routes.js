const express = require("express");
const { z } = require("zod");
const { prisma } = require("../config/prisma");
const { requireAuth, requireRoles } = require("../middleware/auth");
const { ApiError } = require("../utils/errors");

const router = express.Router();

const resolveSchema = z.object({
  resolution: z.enum(["REFUND_FULL", "REFUND_PARTIAL", "RELEASE_SELLER"]),
  refundAmountKzt: z.number().positive().optional(),
  note: z.string().optional(),
});

router.get("/disputes", requireAuth, requireRoles("MODERATOR", "ADMIN"), async (req, res, next) => {
  try {
    const limit = Math.min(Number(req.query.limit || 20), 100);
    const cursor = req.query.cursor ? String(req.query.cursor) : null;
    const status = req.query.status ? String(req.query.status) : undefined;
    const where = status ? { status } : { status: { in: ["OPEN", "UNDER_REVIEW"] } };

    const data = await prisma.dispute.findMany({
      where,
      orderBy: [{ openedAt: "desc" }, { id: "desc" }],
      take: limit + 1,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
    });
    const hasNext = data.length > limit;
    const slice = hasNext ? data.slice(0, limit) : data;
    const nextCursor = hasNext ? slice[slice.length - 1].id : null;
    return res.status(200).json({ data: slice, meta: { hasNext, nextCursor } });
  } catch (error) {
    return next(error);
  }
});

router.post("/disputes/:disputeId/resolve", requireAuth, requireRoles("MODERATOR", "ADMIN"), async (req, res, next) => {
  try {
    const disputeId = z.string().uuid().parse(req.params.disputeId);
    const body = resolveSchema.parse(req.body);

    const updated = await prisma.$transaction(async (tx) => {
      const dispute = await tx.dispute.findUnique({ where: { id: disputeId } });
      if (!dispute) throw new ApiError(404, "NOT_FOUND", "Dispute not found");
      if (dispute.status.startsWith("RESOLVED_")) throw new ApiError(409, "CONFLICT", "Dispute already resolved");

      const order = await tx.order.findUnique({ where: { id: dispute.orderId } });
      if (!order) throw new ApiError(404, "NOT_FOUND", "Order not found");

      let nextDisputeStatus = "RESOLVED_RELEASE_SELLER";
      if (body.resolution === "REFUND_FULL") nextDisputeStatus = "RESOLVED_REFUND_FULL";
      if (body.resolution === "REFUND_PARTIAL") nextDisputeStatus = "RESOLVED_REFUND_PARTIAL";

      if (body.resolution === "REFUND_FULL") {
        await tx.escrowTransaction.create({
          data: {
            orderId: order.id,
            txType: "REFUND_FULL",
            amountKzt: order.totalAmountKzt,
            idempotencyKey: `refund_full_${order.id}`,
            metadataJson: { moderatorId: req.user.id },
          },
        });
      } else if (body.resolution === "REFUND_PARTIAL") {
        if (!body.refundAmountKzt) throw new ApiError(422, "VALIDATION_ERROR", "refundAmountKzt is required for partial refund");
        await tx.escrowTransaction.create({
          data: {
            orderId: order.id,
            txType: "REFUND_PARTIAL",
            amountKzt: body.refundAmountKzt,
            idempotencyKey: `refund_partial_${order.id}`,
            metadataJson: { moderatorId: req.user.id },
          },
        });
      } else {
        await tx.escrowTransaction.create({
          data: {
            orderId: order.id,
            txType: "PAYOUT_MILESTONE_2",
            amountKzt: order.payout2Kzt,
            idempotencyKey: `payout2_dispute_${order.id}`,
            metadataJson: { moderatorId: req.user.id },
          },
        });
        await tx.payout.update({
          where: { orderId_milestone: { orderId: order.id, milestone: 2 } },
          data: { status: "RELEASED", releasedAt: new Date() },
        });
      }

      await tx.order.update({
        where: { id: order.id },
        data: { status: "COMPLETED", completedAt: new Date() },
      });

      return tx.dispute.update({
        where: { id: disputeId },
        data: {
          status: nextDisputeStatus,
          moderatorDecision: body.resolution,
          resolutionNote: body.note || null,
          resolvedAt: new Date(),
        },
      });
    });

    return res.status(200).json(updated);
  } catch (error) {
    if (error instanceof z.ZodError) return next(new ApiError(422, "VALIDATION_ERROR", "Validation failed", error.flatten()));
    return next(error);
  }
});

module.exports = router;
