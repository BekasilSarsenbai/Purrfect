const express = require("express");
const { z } = require("zod");
const { prisma } = require("../config/prisma");
const { requireAuth } = require("../middleware/auth");
const { ApiError } = require("../utils/errors");

const router = express.Router();

async function getAccessibleOrder(orderId, user) {
  const order = await prisma.order.findUnique({ where: { id: orderId } });
  if (!order) throw new ApiError(404, "NOT_FOUND", "Order not found");
  const isOwner = order.buyerId === user.id || order.sellerId === user.id;
  const isStaff = ["MODERATOR", "ADMIN"].includes(user.role);
  if (!isOwner && !isStaff) throw new ApiError(403, "FORBIDDEN", "No access to this order");
  return order;
}

router.get("/:orderId/transactions", requireAuth, async (req, res, next) => {
  try {
    const orderId = z.string().uuid().parse(req.params.orderId);
    await getAccessibleOrder(orderId, req.user);
    const tx = await prisma.escrowTransaction.findMany({
      where: { orderId },
      orderBy: [{ createdAt: "asc" }],
    });
    return res.status(200).json(tx);
  } catch (error) {
    if (error instanceof z.ZodError) return next(new ApiError(422, "VALIDATION_ERROR", "Validation failed", error.flatten()));
    return next(error);
  }
});

router.get("/:orderId/payouts", requireAuth, async (req, res, next) => {
  try {
    const orderId = z.string().uuid().parse(req.params.orderId);
    await getAccessibleOrder(orderId, req.user);
    const payouts = await prisma.payout.findMany({
      where: { orderId },
      orderBy: [{ milestone: "asc" }],
    });
    return res.status(200).json(payouts);
  } catch (error) {
    if (error instanceof z.ZodError) return next(new ApiError(422, "VALIDATION_ERROR", "Validation failed", error.flatten()));
    return next(error);
  }
});

router.get("/:orderId/timeline", requireAuth, async (req, res, next) => {
  try {
    const orderId = z.string().uuid().parse(req.params.orderId);
    const order = await getAccessibleOrder(orderId, req.user);
    const inspection = await prisma.inspection.findUnique({ where: { orderId } });
    const dispute = await prisma.dispute.findUnique({ where: { orderId } });

    const timeline = [
      { event: "ORDER_CREATED", at: order.createdAt, status: "CREATED" },
      order.fundedAt ? { event: "ESCROW_FUNDED", at: order.fundedAt, status: "FUNDED_100" } : null,
      order.handoverAt ? { event: "HANDOVER_CONFIRMED", at: order.handoverAt, status: "INSPECTION_ACTIVE" } : null,
      inspection?.submittedAt ? { event: "INSPECTION_SUBMITTED", at: inspection.submittedAt, status: inspection.status } : null,
      dispute?.openedAt ? { event: "DISPUTE_OPENED", at: dispute.openedAt, status: dispute.status } : null,
      order.completedAt ? { event: "ORDER_COMPLETED", at: order.completedAt, status: "COMPLETED" } : null,
    ].filter(Boolean);

    return res.status(200).json({
      orderId: order.id,
      currentStatus: order.status,
      timeline,
    });
  } catch (error) {
    if (error instanceof z.ZodError) return next(new ApiError(422, "VALIDATION_ERROR", "Validation failed", error.flatten()));
    return next(error);
  }
});

router.get("/:orderId/audit", requireAuth, async (req, res, next) => {
  try {
    const orderId = z.string().uuid().parse(req.params.orderId);
    await getAccessibleOrder(orderId, req.user);

    const [orderLogs, disputeLogs, paymentLogs] = await Promise.all([
      prisma.auditLog.findMany({
        where: { entityType: "Order", entityId: orderId },
        orderBy: [{ createdAt: "desc" }],
      }),
      prisma.auditLog.findMany({
        where: { entityType: "Dispute", afterJson: { path: ["orderId"], equals: orderId } },
        orderBy: [{ createdAt: "desc" }],
      }),
      prisma.escrowTransaction.findMany({
        where: { orderId },
        orderBy: [{ createdAt: "desc" }],
      }),
    ]);

    return res.status(200).json({
      orderLogs,
      relatedDisputeLogs: disputeLogs,
      financialTransactions: paymentLogs,
    });
  } catch (error) {
    if (error instanceof z.ZodError) return next(new ApiError(422, "VALIDATION_ERROR", "Validation failed", error.flatten()));
    return next(error);
  }
});

module.exports = router;
