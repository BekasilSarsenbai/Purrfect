const express = require("express");
const { z } = require("zod");
const { prisma } = require("../config/prisma");
const { requireAuth, requireRoles } = require("../middleware/auth");
const { ApiError } = require("../utils/errors");

const router = express.Router();

const updateRoleSchema = z.object({
  role: z.enum(["BUYER", "SELLER", "MODERATOR", "ADMIN"]),
  reason: z.string().max(500).optional(),
});

const updateStatusSchema = z.object({
  status: z.enum(["ACTIVE", "SUSPENDED", "DELETED"]),
  reason: z.string().max(500).optional(),
});

router.patch("/users/:userId/role", requireAuth, requireRoles("ADMIN"), async (req, res, next) => {
  try {
    const body = updateRoleSchema.parse(req.body);
    const userId = z.string().uuid().parse(req.params.userId);

    const existing = await prisma.user.findUnique({ where: { id: userId } });
    if (!existing) throw new ApiError(404, "NOT_FOUND", "User not found");

    const updated = await prisma.$transaction(async (tx) => {
      const changed = await tx.user.update({
        where: { id: userId },
        data: { role: body.role },
        select: { id: true, email: true, role: true, displayName: true, trustScore: true },
      });

      await tx.auditLog.create({
        data: {
          actorUserId: req.user.id,
          action: "ADMIN_ROLE_UPDATE",
          entityType: "User",
          entityId: userId,
          beforeJson: { role: existing.role },
          afterJson: { role: body.role, reason: body.reason || null },
          ipAddress: req.ip,
          userAgent: req.headers["user-agent"] || null,
        },
      });
      return changed;
    });

    return res.status(200).json(updated);
  } catch (error) {
    if (error instanceof z.ZodError) {
      return next(new ApiError(422, "VALIDATION_ERROR", "Validation failed", error.flatten()));
    }
    return next(error);
  }
});

router.patch("/users/:userId/status", requireAuth, requireRoles("ADMIN"), async (req, res, next) => {
  try {
    // COMPLEXITY_REQ_5: trust-aware policy enforcement through admin account controls.
    const body = updateStatusSchema.parse(req.body);
    const userId = z.string().uuid().parse(req.params.userId);
    const existing = await prisma.user.findUnique({ where: { id: userId } });
    if (!existing) throw new ApiError(404, "NOT_FOUND", "User not found");

    const updated = await prisma.$transaction(async (tx) => {
      const changed = await tx.user.update({
        where: { id: userId },
        data: { status: body.status },
        select: { id: true, email: true, role: true, status: true, displayName: true, trustScore: true },
      });
      await tx.auditLog.create({
        data: {
          actorUserId: req.user.id,
          action: "ADMIN_STATUS_UPDATE",
          entityType: "User",
          entityId: userId,
          beforeJson: { status: existing.status },
          afterJson: { status: body.status, reason: body.reason || null },
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

router.get("/audit-logs", requireAuth, requireRoles("ADMIN"), async (req, res, next) => {
  try {
    const limit = Math.min(Number(req.query.limit || 20), 100);
    const cursor = req.query.cursor ? String(req.query.cursor) : null;
    const action = req.query.action ? String(req.query.action) : undefined;

    const data = await prisma.auditLog.findMany({
      where: action ? { action } : undefined,
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

router.get("/dashboard-kpis", requireAuth, requireRoles("ADMIN"), async (req, res, next) => {
  try {
    const [usersTotal, listingsPublished, disputesOpen, ordersCompleted, activeRiskFlags] = await Promise.all([
      prisma.user.count({ where: { status: "ACTIVE" } }),
      prisma.listing.count({ where: { status: "PUBLISHED" } }),
      prisma.dispute.count({ where: { status: { in: ["OPEN", "UNDER_REVIEW"] } } }),
      prisma.order.count({ where: { status: "COMPLETED" } }),
      prisma.moderationCase.count({ where: { caseType: "RISK_FLAG", status: "OPEN" } }),
    ]);

    return res.status(200).json({
      usersTotal,
      listingsPublished,
      disputesOpen,
      ordersCompleted,
      activeRiskFlags,
    });
  } catch (error) {
    return next(error);
  }
});

module.exports = router;
