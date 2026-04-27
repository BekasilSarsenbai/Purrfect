const express = require("express");
const { z } = require("zod");
const { prisma } = require("../config/prisma");
const { requireAuth } = require("../middleware/auth");
const { ApiError } = require("../utils/errors");

const router = express.Router();

const createDisputeSchema = z.object({
  orderId: z.string().uuid(),
  reasonCode: z.enum(["HEALTH_MISMATCH", "FAKE_BREED_DOCS", "NOT_AS_DESCRIBED", "OTHER"]),
  evidenceUrls: z.array(z.string().url()).optional(),
  description: z.string().optional(),
});

const addEvidenceSchema = z.object({
  evidenceType: z.enum(["PHOTO", "VIDEO", "PDF_REPORT", "CHAT_SCREENSHOT", "OTHER"]),
  fileUrl: z.string().url(),
  note: z.string().optional(),
});

function canAccessDispute(dispute, order, user) {
  return order.buyerId === user.id || order.sellerId === user.id || ["MODERATOR", "ADMIN"].includes(user.role) || dispute.openedById === user.id;
}

router.post("/", requireAuth, async (req, res, next) => {
  try {
    const body = createDisputeSchema.parse(req.body);
    const order = await prisma.order.findUnique({ where: { id: body.orderId } });
    if (!order) throw new ApiError(404, "NOT_FOUND", "Order not found");
    const involved = order.buyerId === req.user.id || order.sellerId === req.user.id;
    if (!involved) throw new ApiError(403, "FORBIDDEN", "No access to order");
    if (!["INSPECTION_ACTIVE", "DISPUTED"].includes(order.status)) {
      throw new ApiError(409, "CONFLICT", "Order is not disputable in current status");
    }

    const existing = await prisma.dispute.findUnique({ where: { orderId: body.orderId } });
    if (existing) throw new ApiError(409, "CONFLICT", "Dispute already exists for order");

    // COMPLEXITY_REQ_3: evidence-driven dispute engine with linked evidence records.
    const created = await prisma.$transaction(async (tx) => {
      const dispute = await tx.dispute.create({
        data: {
          orderId: body.orderId,
          openedById: req.user.id,
          reasonCode: body.reasonCode,
          status: "OPEN",
          resolutionNote: body.description || null,
        },
      });
      if (body.evidenceUrls?.length) {
        await tx.disputeEvidence.createMany({
          data: body.evidenceUrls.map((url) => ({
            disputeId: dispute.id,
            uploaderId: req.user.id,
            evidenceType: "OTHER",
            storageUrl: url,
          })),
        });
      }
      await tx.order.update({ where: { id: body.orderId }, data: { status: "DISPUTED" } });
      return dispute;
    });

    return res.status(201).json(created);
  } catch (error) {
    if (error instanceof z.ZodError) return next(new ApiError(422, "VALIDATION_ERROR", "Validation failed", error.flatten()));
    return next(error);
  }
});

router.get("/", requireAuth, async (req, res, next) => {
  try {
    const limit = Math.min(Number(req.query.limit || 20), 100);
    const cursor = req.query.cursor ? String(req.query.cursor) : null;
    const status = req.query.status ? String(req.query.status) : undefined;

    let where = status ? { status } : {};
    if (!["MODERATOR", "ADMIN"].includes(req.user.role)) {
      where = { ...where, OR: [{ openedById: req.user.id }, { order: { buyerId: req.user.id } }, { order: { sellerId: req.user.id } }] };
    }

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

router.get("/:disputeId", requireAuth, async (req, res, next) => {
  try {
    const disputeId = z.string().uuid().parse(req.params.disputeId);
    const dispute = await prisma.dispute.findUnique({ where: { id: disputeId } });
    if (!dispute) throw new ApiError(404, "NOT_FOUND", "Dispute not found");
    const order = await prisma.order.findUnique({ where: { id: dispute.orderId } });
    if (!order || !canAccessDispute(dispute, order, req.user)) throw new ApiError(403, "FORBIDDEN", "No access to dispute");
    return res.status(200).json(dispute);
  } catch (error) {
    if (error instanceof z.ZodError) return next(new ApiError(422, "VALIDATION_ERROR", "Validation failed", error.flatten()));
    return next(error);
  }
});

router.post("/:disputeId/evidence", requireAuth, async (req, res, next) => {
  try {
    const disputeId = z.string().uuid().parse(req.params.disputeId);
    const body = addEvidenceSchema.parse(req.body);
    const dispute = await prisma.dispute.findUnique({ where: { id: disputeId } });
    if (!dispute) throw new ApiError(404, "NOT_FOUND", "Dispute not found");
    const order = await prisma.order.findUnique({ where: { id: dispute.orderId } });
    if (!order || !canAccessDispute(dispute, order, req.user)) throw new ApiError(403, "FORBIDDEN", "No access to dispute");

    const evidence = await prisma.disputeEvidence.create({
      data: {
        disputeId,
        uploaderId: req.user.id,
        evidenceType: body.evidenceType,
        storageUrl: body.fileUrl,
        note: body.note || null,
      },
    });
    return res.status(201).json({
      id: evidence.id,
      disputeId: evidence.disputeId,
      uploaderId: evidence.uploaderId,
      evidenceType: evidence.evidenceType,
      fileUrl: evidence.storageUrl,
      note: evidence.note,
      createdAt: evidence.createdAt,
    });
  } catch (error) {
    if (error instanceof z.ZodError) return next(new ApiError(422, "VALIDATION_ERROR", "Validation failed", error.flatten()));
    return next(error);
  }
});

router.get("/:disputeId/evidence", requireAuth, async (req, res, next) => {
  try {
    const disputeId = z.string().uuid().parse(req.params.disputeId);
    const limit = Math.min(Number(req.query.limit || 20), 100);
    const cursor = req.query.cursor ? String(req.query.cursor) : null;

    const dispute = await prisma.dispute.findUnique({ where: { id: disputeId } });
    if (!dispute) throw new ApiError(404, "NOT_FOUND", "Dispute not found");
    const order = await prisma.order.findUnique({ where: { id: dispute.orderId } });
    if (!order || !canAccessDispute(dispute, order, req.user)) throw new ApiError(403, "FORBIDDEN", "No access to dispute");

    const data = await prisma.disputeEvidence.findMany({
      where: { disputeId },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: limit + 1,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
    });
    const hasNext = data.length > limit;
    const slice = hasNext ? data.slice(0, limit) : data;
    const nextCursor = hasNext ? slice[slice.length - 1].id : null;
    return res.status(200).json({
      data: slice.map((e) => ({ ...e, fileUrl: e.storageUrl })),
      meta: { hasNext, nextCursor },
    });
  } catch (error) {
    if (error instanceof z.ZodError) return next(new ApiError(422, "VALIDATION_ERROR", "Validation failed", error.flatten()));
    return next(error);
  }
});

router.post("/:disputeId/reopen", requireAuth, async (req, res, next) => {
  try {
    const disputeId = z.string().uuid().parse(req.params.disputeId);
    const dispute = await prisma.dispute.findUnique({ where: { id: disputeId } });
    if (!dispute) throw new ApiError(404, "NOT_FOUND", "Dispute not found");
    const order = await prisma.order.findUnique({ where: { id: dispute.orderId } });
    if (!order || !canAccessDispute(dispute, order, req.user)) throw new ApiError(403, "FORBIDDEN", "No access to dispute");
    if (!dispute.status.startsWith("RESOLVED_")) throw new ApiError(409, "CONFLICT", "Only resolved disputes can be reopened");

    const updated = await prisma.$transaction(async (tx) => {
      const nextDispute = await tx.dispute.update({
        where: { id: disputeId },
        data: {
          status: "UNDER_REVIEW",
          resolvedAt: null,
          resolutionNote: `${dispute.resolutionNote || ""}\n[REOPENED by ${req.user.id} at ${new Date().toISOString()}]`.trim(),
        },
      });
      await tx.order.update({
        where: { id: dispute.orderId },
        data: { status: "DISPUTED", completedAt: null },
      });
      return nextDispute;
    });

    return res.status(200).json(updated);
  } catch (error) {
    if (error instanceof z.ZodError) return next(new ApiError(422, "VALIDATION_ERROR", "Validation failed", error.flatten()));
    return next(error);
  }
});

module.exports = router;
