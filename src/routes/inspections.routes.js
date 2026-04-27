const express = require("express");
const { z } = require("zod");
const { prisma } = require("../config/prisma");
const { requireAuth, requireRoles } = require("../middleware/auth");
const { ApiError } = require("../utils/errors");

const router = express.Router();

const submitInspectionSchema = z.object({
  clinicName: z.string().min(2),
  reportUrl: z.string().url(),
  outcome: z.enum(["PASSED", "FAILED"]),
  notes: z.string().optional(),
});

async function getOrderForBuyer(orderId, userId) {
  const order = await prisma.order.findUnique({ where: { id: orderId } });
  if (!order) throw new ApiError(404, "NOT_FOUND", "Order not found");
  if (order.buyerId !== userId) throw new ApiError(403, "FORBIDDEN", "Order does not belong to buyer");
  return order;
}

router.post("/:orderId/inspection", requireAuth, requireRoles("BUYER"), async (req, res, next) => {
  try {
    const orderId = z.string().uuid().parse(req.params.orderId);
    const body = submitInspectionSchema.parse(req.body);
    const order = await getOrderForBuyer(orderId, req.user.id);
    if (order.status !== "INSPECTION_ACTIVE") throw new ApiError(409, "CONFLICT", "Inspection is not active");
    if (!order.inspectionDeadline || order.inspectionDeadline < new Date()) throw new ApiError(409, "CONFLICT", "Inspection window expired");

    const inspection = await prisma.inspection.upsert({
      where: { orderId },
      create: {
        orderId,
        buyerId: req.user.id,
        status: body.outcome,
        clinicName: body.clinicName,
        reportUrl: body.reportUrl,
        notes: body.notes || null,
        submittedAt: new Date(),
        deadlineAt: order.inspectionDeadline,
      },
      update: {
        status: body.outcome,
        clinicName: body.clinicName,
        reportUrl: body.reportUrl,
        notes: body.notes || null,
        submittedAt: new Date(),
      },
    });

    return res.status(200).json(inspection);
  } catch (error) {
    if (error instanceof z.ZodError) return next(new ApiError(422, "VALIDATION_ERROR", "Validation failed", error.flatten()));
    return next(error);
  }
});

router.get("/:orderId/inspection", requireAuth, async (req, res, next) => {
  try {
    const orderId = z.string().uuid().parse(req.params.orderId);
    const order = await prisma.order.findUnique({ where: { id: orderId } });
    if (!order) throw new ApiError(404, "NOT_FOUND", "Order not found");
    const isBuyer = order.buyerId === req.user.id;
    const isSeller = order.sellerId === req.user.id;
    const isStaff = ["MODERATOR", "ADMIN"].includes(req.user.role);
    if (!isBuyer && !isSeller && !isStaff) throw new ApiError(403, "FORBIDDEN", "No access to inspection");

    const inspection = await prisma.inspection.findUnique({ where: { orderId } });
    if (!inspection) throw new ApiError(404, "NOT_FOUND", "Inspection not found");
    return res.status(200).json(inspection);
  } catch (error) {
    if (error instanceof z.ZodError) return next(new ApiError(422, "VALIDATION_ERROR", "Validation failed", error.flatten()));
    return next(error);
  }
});

router.post("/:orderId/inspection/approve", requireAuth, requireRoles("BUYER"), async (req, res, next) => {
  try {
    const orderId = z.string().uuid().parse(req.params.orderId);
    // COMPLEXITY_REQ_5: inspection-gated final payout release — milestone 2 is only
    // disbursed after the buyer explicitly approves a PASSED veterinary inspection.
    // The entire state transition (order COMPLETED + listing SOLD + payout released +
    // escrow ledger entry) is atomic: all succeed or all roll back.
    const result = await prisma.$transaction(async (tx) => {
      const order = await tx.order.findUnique({ where: { id: orderId } });
      if (!order) throw new ApiError(404, "NOT_FOUND", "Order not found");
      if (order.buyerId !== req.user.id) throw new ApiError(403, "FORBIDDEN", "Order does not belong to buyer");
      if (order.status !== "INSPECTION_ACTIVE") throw new ApiError(409, "CONFLICT", "Order is not in inspection state");

      const inspection = await tx.inspection.findUnique({ where: { orderId } });
      if (!inspection || inspection.status !== "PASSED") throw new ApiError(409, "CONFLICT", "Inspection is not approved");

      await tx.escrowTransaction.create({
        data: {
          orderId,
          txType: "PAYOUT_MILESTONE_2",
          amountKzt: order.payout2Kzt,
          idempotencyKey: `payout2_${orderId}`,
          metadataJson: { milestone: 2 },
        },
      });
      await tx.payout.update({
        where: { orderId_milestone: { orderId, milestone: 2 } },
        data: { status: "RELEASED", releasedAt: new Date() },
      });

      const updated = await tx.order.update({
        where: { id: orderId },
        data: { status: "COMPLETED", completedAt: new Date() },
      });
      await tx.listing.update({ where: { id: order.listingId }, data: { status: "SOLD" } });
      return updated;
    });
    return res.status(200).json(result);
  } catch (error) {
    if (error instanceof z.ZodError) return next(new ApiError(422, "VALIDATION_ERROR", "Validation failed", error.flatten()));
    return next(error);
  }
});

module.exports = router;
