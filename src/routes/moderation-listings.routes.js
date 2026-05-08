const express = require("express");
const { z } = require("zod");
const { prisma } = require("../config/prisma");
const { requireAuth, requireRoles } = require("../middleware/auth");
const { parsePagination, buildPagedResponse } = require("../utils/pagination");
const { ApiError } = require("../utils/errors");

const router = express.Router();

const moderationDecisionSchema = z.object({
  note: z.string().max(1000).optional(),
});

const riskFlagSchema = z.object({
  riskScore: z.number().int().min(0).max(100),
  note: z.string().max(1000).optional(),
});

router.get("/listings", requireAuth, requireRoles("MODERATOR", "ADMIN"), async (req, res, next) => {
  try {
    const { limit, cursor } = parsePagination(req.query);
    const status = req.query.status ? String(req.query.status) : "PENDING_REVIEW";

    const data = await prisma.listing.findMany({
      where: { status },
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

router.post("/listings/:listingId/approve", requireAuth, requireRoles("MODERATOR", "ADMIN"), async (req, res, next) => {
  try {
    const listingId = z.string().uuid().parse(req.params.listingId);
    const body = moderationDecisionSchema.parse(req.body);
    const listing = await prisma.listing.findUnique({ where: { id: listingId } });
    if (!listing) throw new ApiError(404, "NOT_FOUND", "Listing not found");
    if (listing.status !== "PENDING_REVIEW") throw new ApiError(409, "CONFLICT", "Listing is not pending review");

    // A listing can only be approved if no document was rejected and no document is still pending.
    const docs = await prisma.listingDocument.findMany({
      where: { listingId },
      include: { verifications: { orderBy: { createdAt: "desc" }, take: 1 } },
    });
    for (const doc of docs) {
      const latest = doc.verifications[0];
      if (!latest || latest.decision !== "APPROVED") {
        throw new ApiError(409, "CONFLICT", "All documents must be APPROVED before publishing the listing");
      }
    }

    const updated = await prisma.$transaction(async (tx) => {
      const changed = await tx.listing.update({
        where: { id: listingId },
        data: { status: "PUBLISHED", publishedAt: new Date() },
      });
      await tx.moderationCase.create({
        data: {
          listingId,
          moderatorId: req.user.id,
          caseType: "LISTING_REVIEW",
          status: "CLOSED_APPROVED",
          decision: "APPROVE",
          decisionNote: body.note || null,
          closedAt: new Date(),
        },
      });
      await tx.auditLog.create({
        data: {
          actorUserId: req.user.id,
          action: "LISTING_APPROVED",
          entityType: "Listing",
          entityId: listingId,
          beforeJson: { status: listing.status },
          afterJson: { status: "PUBLISHED" },
          ipAddress: req.ip,
          userAgent: req.headers["user-agent"] || null,
        },
      });
      return changed;
    });
    return res.status(200).json(updated);
  } catch (error) {
    if (error instanceof z.ZodError) return next(new ApiError(422, "VALIDATION_ERROR", "Validation failed", error.flatten()));
    return next(error);
  }
});

router.post("/listings/:listingId/reject", requireAuth, requireRoles("MODERATOR", "ADMIN"), async (req, res, next) => {
  try {
    const listingId = z.string().uuid().parse(req.params.listingId);
    const body = moderationDecisionSchema.parse(req.body);
    const listing = await prisma.listing.findUnique({ where: { id: listingId } });
    if (!listing) throw new ApiError(404, "NOT_FOUND", "Listing not found");
    if (listing.status !== "PENDING_REVIEW") throw new ApiError(409, "CONFLICT", "Listing is not pending review");

    const updated = await prisma.$transaction(async (tx) => {
      const changed = await tx.listing.update({
        where: { id: listingId },
        data: { status: "REJECTED" },
      });
      await tx.moderationCase.create({
        data: {
          listingId,
          moderatorId: req.user.id,
          caseType: "LISTING_REVIEW",
          status: "CLOSED_REJECTED",
          decision: "REJECT",
          decisionNote: body.note || null,
          closedAt: new Date(),
        },
      });
      await tx.auditLog.create({
        data: {
          actorUserId: req.user.id,
          action: "LISTING_REJECTED",
          entityType: "Listing",
          entityId: listingId,
          beforeJson: { status: listing.status },
          afterJson: { status: "REJECTED" },
          ipAddress: req.ip,
          userAgent: req.headers["user-agent"] || null,
        },
      });
      return changed;
    });
    return res.status(200).json(updated);
  } catch (error) {
    if (error instanceof z.ZodError) return next(new ApiError(422, "VALIDATION_ERROR", "Validation failed", error.flatten()));
    return next(error);
  }
});

router.post("/listings/:listingId/risk-flag", requireAuth, requireRoles("MODERATOR", "ADMIN"), async (req, res, next) => {
  try {
    const listingId = z.string().uuid().parse(req.params.listingId);
    const body = riskFlagSchema.parse(req.body);
    const listing = await prisma.listing.findUnique({ where: { id: listingId } });
    if (!listing) throw new ApiError(404, "NOT_FOUND", "Listing not found");

    const updated = await prisma.$transaction(async (tx) => {
      const changed = await tx.listing.update({
        where: { id: listingId },
        data: { riskScore: body.riskScore },
      });
      // Close any prior OPEN risk flag for this listing first to avoid KPI inflation.
      await tx.moderationCase.updateMany({
        where: { listingId, caseType: "RISK_FLAG", status: "OPEN" },
        data: { status: "CLOSED_SUPERSEDED", closedAt: new Date() },
      });
      await tx.moderationCase.create({
        data: {
          listingId,
          moderatorId: req.user.id,
          caseType: "RISK_FLAG",
          status: "OPEN",
          decisionNote: body.note || `Risk score set to ${body.riskScore}`,
          riskSnapshot: { previousRiskScore: listing.riskScore, nextRiskScore: body.riskScore },
        },
      });
      return changed;
    });
    return res.status(200).json(updated);
  } catch (error) {
    if (error instanceof z.ZodError) return next(new ApiError(422, "VALIDATION_ERROR", "Validation failed", error.flatten()));
    return next(error);
  }
});

router.post("/listings/:listingId/risk-flag/clear", requireAuth, requireRoles("MODERATOR", "ADMIN"), async (req, res, next) => {
  try {
    const listingId = z.string().uuid().parse(req.params.listingId);
    const listing = await prisma.listing.findUnique({ where: { id: listingId } });
    if (!listing) throw new ApiError(404, "NOT_FOUND", "Listing not found");

    const result = await prisma.$transaction(async (tx) => {
      const closed = await tx.moderationCase.updateMany({
        where: { listingId, caseType: "RISK_FLAG", status: "OPEN" },
        data: {
          status: "CLOSED_RESOLVED",
          decision: "CLEARED",
          moderatorId: req.user.id,
          closedAt: new Date(),
        },
      });
      const updated = await tx.listing.update({
        where: { id: listingId },
        data: { riskScore: 0 },
      });
      return { listingId, closedCases: closed.count, currentRiskScore: updated.riskScore };
    });

    return res.status(200).json(result);
  } catch (error) {
    if (error instanceof z.ZodError) return next(new ApiError(422, "VALIDATION_ERROR", "Validation failed", error.flatten()));
    return next(error);
  }
});

router.get("/listings/:listingId/risk-signals", requireAuth, requireRoles("MODERATOR", "ADMIN"), async (req, res, next) => {
  try {
    const listingId = z.string().uuid().parse(req.params.listingId);
    const listing = await prisma.listing.findUnique({ where: { id: listingId } });
    if (!listing) throw new ApiError(404, "NOT_FOUND", "Listing not found");

    const riskCases = await prisma.moderationCase.findMany({
      where: { listingId, caseType: { in: ["RISK_FLAG", "LISTING_REVIEW", "USER_REPORT"] } },
      orderBy: [{ createdAt: "desc" }],
      take: 20,
    });

    return res.status(200).json({
      listingId,
      currentRiskScore: listing.riskScore,
      signals: riskCases.map((c) => ({
        caseId: c.id,
        caseType: c.caseType,
        status: c.status,
        decisionNote: c.decisionNote,
        riskSnapshot: c.riskSnapshot,
        createdAt: c.createdAt,
      })),
    });
  } catch (error) {
    if (error instanceof z.ZodError) return next(new ApiError(422, "VALIDATION_ERROR", "Validation failed", error.flatten()));
    return next(error);
  }
});

router.get("/listings/:listingId/full-context", requireAuth, requireRoles("MODERATOR", "ADMIN"), async (req, res, next) => {
  try {
    const listingId = z.string().uuid().parse(req.params.listingId);
    const listing = await prisma.listing.findUnique({
      where: { id: listingId },
      include: {
        media: { orderBy: { createdAt: "desc" } },
        documents: {
          include: { verifications: { orderBy: { createdAt: "desc" }, take: 5 } },
          orderBy: { createdAt: "desc" },
        },
        moderationCases: { orderBy: { createdAt: "desc" }, take: 20 },
        seller: { select: { id: true, displayName: true, role: true, trustScore: true, createdAt: true } },
      },
    });
    if (!listing) throw new ApiError(404, "NOT_FOUND", "Listing not found");
    return res.status(200).json(listing);
  } catch (error) {
    if (error instanceof z.ZodError) return next(new ApiError(422, "VALIDATION_ERROR", "Validation failed", error.flatten()));
    return next(error);
  }
});

module.exports = router;
