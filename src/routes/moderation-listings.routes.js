const express = require("express");
const { z } = require("zod");
const { prisma } = require("../config/prisma");
const { requireAuth, requireRoles } = require("../middleware/auth");
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
    const limit = Math.min(Number(req.query.limit || 20), 100);
    const cursor = req.query.cursor ? String(req.query.cursor) : null;
    const status = req.query.status ? String(req.query.status) : "PENDING_REVIEW";

    const data = await prisma.listing.findMany({
      where: { status },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
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

router.post("/listings/:listingId/approve", requireAuth, requireRoles("MODERATOR", "ADMIN"), async (req, res, next) => {
  try {
    const listingId = z.string().uuid().parse(req.params.listingId);
    const body = moderationDecisionSchema.parse(req.body);
    const listing = await prisma.listing.findUnique({ where: { id: listingId } });
    if (!listing) throw new ApiError(404, "NOT_FOUND", "Listing not found");
    if (listing.status !== "PENDING_REVIEW") throw new ApiError(409, "CONFLICT", "Listing is not pending review");

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

router.get("/listings/:listingId/risk-signals", requireAuth, requireRoles("MODERATOR", "ADMIN"), async (req, res, next) => {
  try {
    const listingId = z.string().uuid().parse(req.params.listingId);
    const listing = await prisma.listing.findUnique({ where: { id: listingId } });
    if (!listing) throw new ApiError(404, "NOT_FOUND", "Listing not found");

    const riskCases = await prisma.moderationCase.findMany({
      where: { listingId, caseType: { in: ["RISK_FLAG", "LISTING_REVIEW"] } },
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

module.exports = router;
