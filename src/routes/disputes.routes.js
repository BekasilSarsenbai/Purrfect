const express = require("express");
const { z } = require("zod");
const { prisma } = require("../config/prisma");
const { requireAuth, requireVerifiedEmail } = require("../middleware/auth");
const { recordInAppNotification, emitEmail } = require("../services/notification-service");
const { parsePagination, buildPagedResponse } = require("../utils/pagination");
const { ApiError } = require("../utils/errors");

const router = express.Router();

const createDisputeSchema = z.object({
  orderId: z.string().uuid(),
  reasonCode: z.enum(["HEALTH_MISMATCH", "FAKE_BREED_DOCS", "NOT_AS_DESCRIBED", "OTHER"]),
  evidenceUrls: z.array(z.string().url()).optional(),
  description: z.string().max(2000).optional(),
});

const addEvidenceSchema = z.object({
  evidenceType: z.enum(["PHOTO", "VIDEO", "PDF_REPORT", "CHAT_SCREENSHOT", "OTHER"]),
  fileUrl: z.string().url(),
  note: z.string().optional(),
});

const commentSchema = z.object({
  text: z.string().min(1).max(2000),
});

const REOPEN_WINDOW_DAYS = 14;

function canAccessDispute(dispute, order, user) {
  return order.buyerId === user.id || order.sellerId === user.id || ["MODERATOR", "ADMIN"].includes(user.role) || dispute.openedById === user.id;
}

router.post("/", requireAuth, requireVerifiedEmail, async (req, res, next) => {
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
        },
      });

      // Description from the buyer/seller is stored as a COMMENT, not as resolutionNote
      // (resolutionNote is reserved for moderator output).
      if (body.description) {
        await tx.disputeEvidence.create({
          data: {
            disputeId: dispute.id,
            uploaderId: req.user.id,
            evidenceType: "COMMENT",
            storageUrl: "comment://internal",
            note: body.description,
          },
        });
      }
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
      await tx.auditLog.create({
        data: {
          actorUserId: req.user.id,
          action: "DISPUTE_OPENED",
          entityType: "Dispute",
          entityId: dispute.id,
          afterJson: { orderId: body.orderId, reasonCode: body.reasonCode },
          ipAddress: req.ip,
          userAgent: req.headers["user-agent"] || null,
        },
      });

      // Notify the *other* side: if seller opened it, ping buyer; otherwise ping seller.
      const counterpartyId = req.user.id === order.sellerId ? order.buyerId : order.sellerId;
      await recordInAppNotification(tx, {
        userId: counterpartyId,
        templateCode: "dispute.opened.seller",
        payloadJson: { orderId: body.orderId, disputeId: dispute.id, reasonCode: body.reasonCode },
      });

      return { dispute, counterpartyId };
    });

    const counterparty = await prisma.user.findUnique({
      where: { id: created.counterpartyId },
      select: { email: true, displayName: true },
    });
    await emitEmail({
      to: counterparty?.email,
      templateCode: "dispute.opened.seller",
      payload: {
        orderId: body.orderId,
        reasonCode: body.reasonCode,
        displayName: counterparty?.displayName || "user",
      },
      idempotencyKey: `notify:dispute-opened:${created.dispute.id}`,
    });

    return res.status(201).json(created.dispute);
  } catch (error) {
    if (error instanceof z.ZodError) return next(new ApiError(422, "VALIDATION_ERROR", "Validation failed", error.flatten()));
    return next(error);
  }
});

router.get("/", requireAuth, async (req, res, next) => {
  try {
    const { limit, cursor } = parsePagination(req.query);
    const status = req.query.status
      ? z
          .enum(["OPEN", "UNDER_REVIEW", "RESOLVED_REFUND_FULL", "RESOLVED_REFUND_PARTIAL", "RESOLVED_RELEASE_SELLER", "REJECTED"])
          .parse(req.query.status)
      : undefined;

    let where = status ? { status } : {};
    if (!["MODERATOR", "ADMIN"].includes(req.user.role)) {
      where = {
        ...where,
        OR: [{ openedById: req.user.id }, { order: { buyerId: req.user.id } }, { order: { sellerId: req.user.id } }],
      };
    }

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

router.post("/:disputeId/evidence", requireAuth, requireVerifiedEmail, async (req, res, next) => {
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
    const { limit, cursor } = parsePagination(req.query);

    const dispute = await prisma.dispute.findUnique({ where: { id: disputeId } });
    if (!dispute) throw new ApiError(404, "NOT_FOUND", "Dispute not found");
    const order = await prisma.order.findUnique({ where: { id: dispute.orderId } });
    if (!order || !canAccessDispute(dispute, order, req.user)) throw new ApiError(403, "FORBIDDEN", "No access to dispute");

    const data = await prisma.disputeEvidence.findMany({
      where: { disputeId, evidenceType: { not: "COMMENT" } },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: limit + 1,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
    });

    const paged = buildPagedResponse(data, limit);
    return res.status(200).json({
      ...paged,
      data: paged.data.map((e) => ({ ...e, fileUrl: e.storageUrl })),
    });
  } catch (error) {
    if (error instanceof z.ZodError) return next(new ApiError(422, "VALIDATION_ERROR", "Validation failed", error.flatten()));
    return next(error);
  }
});

router.post("/:disputeId/comments", requireAuth, requireVerifiedEmail, async (req, res, next) => {
  try {
    const disputeId = z.string().uuid().parse(req.params.disputeId);
    const { text } = commentSchema.parse(req.body);
    const dispute = await prisma.dispute.findUnique({ where: { id: disputeId } });
    if (!dispute) throw new ApiError(404, "NOT_FOUND", "Dispute not found");
    const order = await prisma.order.findUnique({ where: { id: dispute.orderId } });
    if (!order || !canAccessDispute(dispute, order, req.user)) throw new ApiError(403, "FORBIDDEN", "No access to dispute");

    const created = await prisma.disputeEvidence.create({
      data: {
        disputeId,
        uploaderId: req.user.id,
        evidenceType: "COMMENT",
        storageUrl: "comment://internal",
        note: text,
      },
    });
    return res.status(201).json({
      id: created.id,
      disputeId,
      authorId: req.user.id,
      text,
      createdAt: created.createdAt,
    });
  } catch (error) {
    if (error instanceof z.ZodError) return next(new ApiError(422, "VALIDATION_ERROR", "Validation failed", error.flatten()));
    return next(error);
  }
});

router.get("/:disputeId/comments", requireAuth, async (req, res, next) => {
  try {
    const disputeId = z.string().uuid().parse(req.params.disputeId);
    const { limit, cursor } = parsePagination(req.query);

    const dispute = await prisma.dispute.findUnique({ where: { id: disputeId } });
    if (!dispute) throw new ApiError(404, "NOT_FOUND", "Dispute not found");
    const order = await prisma.order.findUnique({ where: { id: dispute.orderId } });
    if (!order || !canAccessDispute(dispute, order, req.user)) throw new ApiError(403, "FORBIDDEN", "No access to dispute");

    const data = await prisma.disputeEvidence.findMany({
      where: { disputeId, evidenceType: "COMMENT" },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      take: limit + 1,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
    });

    const paged = buildPagedResponse(data, limit);
    return res.status(200).json({
      ...paged,
      data: paged.data.map((e) => ({
        id: e.id,
        disputeId,
        authorId: e.uploaderId,
        text: e.note,
        createdAt: e.createdAt,
      })),
    });
  } catch (error) {
    if (error instanceof z.ZodError) return next(new ApiError(422, "VALIDATION_ERROR", "Validation failed", error.flatten()));
    return next(error);
  }
});

router.post("/:disputeId/reopen", requireAuth, requireVerifiedEmail, async (req, res, next) => {
  try {
    const disputeId = z.string().uuid().parse(req.params.disputeId);
    const dispute = await prisma.dispute.findUnique({ where: { id: disputeId } });
    if (!dispute) throw new ApiError(404, "NOT_FOUND", "Dispute not found");
    const order = await prisma.order.findUnique({ where: { id: dispute.orderId } });
    if (!order || !canAccessDispute(dispute, order, req.user)) throw new ApiError(403, "FORBIDDEN", "No access to dispute");
    if (!dispute.status.startsWith("RESOLVED_")) throw new ApiError(409, "CONFLICT", "Only resolved disputes can be reopened");

    if (dispute.resolvedAt) {
      const ageMs = Date.now() - new Date(dispute.resolvedAt).getTime();
      if (ageMs > REOPEN_WINDOW_DAYS * 24 * 60 * 60 * 1000) {
        throw new ApiError(409, "CONFLICT", `Reopen window of ${REOPEN_WINDOW_DAYS} days has expired`);
      }
    }

    const updated = await prisma.$transaction(async (tx) => {
      const nextDispute = await tx.dispute.update({
        where: { id: disputeId },
        data: {
          status: "UNDER_REVIEW",
          resolvedAt: null,
        },
      });
      await tx.order.update({
        where: { id: dispute.orderId },
        data: { status: "DISPUTED", completedAt: null },
      });
      await tx.disputeEvidence.create({
        data: {
          disputeId,
          uploaderId: req.user.id,
          evidenceType: "COMMENT",
          storageUrl: "comment://internal",
          note: `[REOPENED by ${req.user.id}]`,
        },
      });
      await tx.auditLog.create({
        data: {
          actorUserId: req.user.id,
          action: "DISPUTE_REOPENED",
          entityType: "Dispute",
          entityId: disputeId,
          ipAddress: req.ip,
          userAgent: req.headers["user-agent"] || null,
        },
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
