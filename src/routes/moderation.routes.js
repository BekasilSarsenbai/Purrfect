const express = require("express");
const { z } = require("zod");
const { prisma } = require("../config/prisma");
const { requireAuth, requireRoles } = require("../middleware/auth");
const { parsePagination, buildPagedResponse } = require("../utils/pagination");
const { ApiError } = require("../utils/errors");

const router = express.Router();

const resolveSchema = z.object({
  resolution: z.enum(["REFUND_FULL", "REFUND_PARTIAL", "RELEASE_SELLER"]),
  refundAmountKzt: z.number().positive().optional(),
  note: z.string().max(2000).optional(),
});

const closeCaseSchema = z.object({
  decision: z.string().min(1).max(50),
  decisionNote: z.string().max(2000).optional(),
});

router.get("/cases", requireAuth, requireRoles("MODERATOR", "ADMIN"), async (req, res, next) => {
  try {
    const { limit, cursor } = parsePagination(req.query);
    const status = req.query.status ? String(req.query.status) : undefined;
    const caseType = req.query.caseType ? String(req.query.caseType) : undefined;

    const data = await prisma.moderationCase.findMany({
      where: { ...(status ? { status } : {}), ...(caseType ? { caseType } : {}) },
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

router.get("/cases/:caseId", requireAuth, requireRoles("MODERATOR", "ADMIN"), async (req, res, next) => {
  try {
    const caseId = z.string().uuid().parse(req.params.caseId);
    const modCase = await prisma.moderationCase.findUnique({ where: { id: caseId } });
    if (!modCase) throw new ApiError(404, "NOT_FOUND", "Moderation case not found");
    return res.status(200).json(modCase);
  } catch (error) {
    if (error instanceof z.ZodError) return next(new ApiError(422, "VALIDATION_ERROR", "Validation failed", error.flatten()));
    return next(error);
  }
});

router.patch("/cases/:caseId/close", requireAuth, requireRoles("MODERATOR", "ADMIN"), async (req, res, next) => {
  try {
    const caseId = z.string().uuid().parse(req.params.caseId);
    const body = closeCaseSchema.parse(req.body);

    const modCase = await prisma.moderationCase.findUnique({ where: { id: caseId } });
    if (!modCase) throw new ApiError(404, "NOT_FOUND", "Moderation case not found");
    if (modCase.status && modCase.status.startsWith("CLOSED")) {
      throw new ApiError(409, "CONFLICT", "Case is already closed");
    }

    const updated = await prisma.$transaction(async (tx) => {
      const closed = await tx.moderationCase.update({
        where: { id: caseId },
        data: {
          status: "CLOSED_RESOLVED",
          decision: body.decision,
          decisionNote: body.decisionNote || null,
          moderatorId: req.user.id,
          closedAt: new Date(),
        },
      });
      await tx.auditLog.create({
        data: {
          actorUserId: req.user.id,
          action: "MODERATION_CASE_CLOSED",
          entityType: "ModerationCase",
          entityId: caseId,
          beforeJson: { status: modCase.status },
          afterJson: { status: "CLOSED_RESOLVED", decision: body.decision },
          ipAddress: req.ip,
          userAgent: req.headers["user-agent"] || null,
        },
      });
      return closed;
    });

    return res.status(200).json(updated);
  } catch (error) {
    if (error instanceof z.ZodError) return next(new ApiError(422, "VALIDATION_ERROR", "Validation failed", error.flatten()));
    return next(error);
  }
});

router.get("/disputes", requireAuth, requireRoles("MODERATOR", "ADMIN"), async (req, res, next) => {
  try {
    // COMPLEXITY_REQ_4: fraud/risk moderation queue with status-based triage.
    const { limit, cursor } = parsePagination(req.query);
    const status = req.query.status ? String(req.query.status) : undefined;
    const where = status ? { status } : { status: { in: ["OPEN", "UNDER_REVIEW"] } };

    const data = await prisma.dispute.findMany({
      where,
      orderBy: [{ openedAt: "desc" }, { id: "desc" }],
      take: limit + 1,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
    });
    return res.status(200).json(buildPagedResponse(data, limit));
  } catch (error) {
    if (error instanceof z.ZodError) return next(new ApiError(422, "VALIDATION_ERROR", "Validation failed", error.flatten()));
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

      // Idempotency keys include a counter of prior refund attempts so a reopen+resolve cycle does not collide.
      const priorRefunds = await tx.escrowTransaction.count({
        where: { orderId: order.id, txType: { in: ["REFUND_FULL", "REFUND_PARTIAL"] } },
      });
      const priorPayout2 = await tx.escrowTransaction.count({
        where: { orderId: order.id, txType: "PAYOUT_MILESTONE_2" },
      });

      const milestone1 = await tx.payout.findUnique({
        where: { orderId_milestone: { orderId: order.id, milestone: 1 } },
      });
      const milestone2 = await tx.payout.findUnique({
        where: { orderId_milestone: { orderId: order.id, milestone: 2 } },
      });

      let nextDisputeStatus = "RESOLVED_RELEASE_SELLER";
      if (body.resolution === "REFUND_FULL") nextDisputeStatus = "RESOLVED_REFUND_FULL";
      if (body.resolution === "REFUND_PARTIAL") nextDisputeStatus = "RESOLVED_REFUND_PARTIAL";

      if (body.resolution === "REFUND_FULL") {
        // If milestone 1 was already released, we cannot refund the full total — the seller has it.
        const fullTotal = Number(order.totalAmountKzt);
        const alreadyReleased = milestone1?.status === "RELEASED" ? Number(order.payout1Kzt) : 0;
        const refundable = Number((fullTotal - alreadyReleased).toFixed(2));
        await tx.escrowTransaction.create({
          data: {
            orderId: order.id,
            txType: "REFUND_FULL",
            amountKzt: refundable,
            idempotencyKey: `refund_full_${order.id}_${priorRefunds}`,
            metadataJson: { moderatorId: req.user.id, alreadyReleasedMilestone1: alreadyReleased },
          },
        });
      } else if (body.resolution === "REFUND_PARTIAL") {
        if (!body.refundAmountKzt) {
          throw new ApiError(422, "VALIDATION_ERROR", "refundAmountKzt is required for partial refund");
        }
        if (body.refundAmountKzt > Number(order.totalAmountKzt)) {
          throw new ApiError(422, "VALIDATION_ERROR", "refundAmountKzt cannot exceed totalAmountKzt");
        }
        await tx.escrowTransaction.create({
          data: {
            orderId: order.id,
            txType: "REFUND_PARTIAL",
            amountKzt: body.refundAmountKzt,
            idempotencyKey: `refund_partial_${order.id}_${priorRefunds}`,
            metadataJson: { moderatorId: req.user.id },
          },
        });
      } else {
        // RELEASE_SELLER — pay out milestone 2 if it has not been released yet.
        if (milestone2?.status !== "RELEASED") {
          await tx.escrowTransaction.create({
            data: {
              orderId: order.id,
              txType: "PAYOUT_MILESTONE_2",
              amountKzt: order.payout2Kzt,
              idempotencyKey: `payout2_dispute_${order.id}_${priorPayout2}`,
              metadataJson: { moderatorId: req.user.id },
            },
          });
          await tx.payout.update({
            where: { orderId_milestone: { orderId: order.id, milestone: 2 } },
            data: { status: "RELEASED", releasedAt: new Date() },
          });
        }
      }

      await tx.order.update({
        where: { id: order.id },
        data: { status: "COMPLETED", completedAt: new Date() },
      });

      const result = await tx.dispute.update({
        where: { id: disputeId },
        data: {
          status: nextDisputeStatus,
          moderatorDecision: body.resolution,
          resolutionNote: body.note || null,
          resolvedAt: new Date(),
        },
      });

      await tx.auditLog.create({
        data: {
          actorUserId: req.user.id,
          action: "DISPUTE_RESOLVED",
          entityType: "Dispute",
          entityId: disputeId,
          beforeJson: { status: dispute.status },
          afterJson: { status: nextDisputeStatus, resolution: body.resolution, refundAmountKzt: body.refundAmountKzt || null },
          ipAddress: req.ip,
          userAgent: req.headers["user-agent"] || null,
        },
      });

      return result;
    });

    return res.status(200).json(updated);
  } catch (error) {
    if (error instanceof z.ZodError) return next(new ApiError(422, "VALIDATION_ERROR", "Validation failed", error.flatten()));
    return next(error);
  }
});

module.exports = router;
