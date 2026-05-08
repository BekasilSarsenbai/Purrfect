const argon2 = require("argon2");
const express = require("express");
const { z } = require("zod");
const { prisma } = require("../config/prisma");
const { requireAuth, requireRoles } = require("../middleware/auth");
const { parsePagination, buildPagedResponse } = require("../utils/pagination");
const { ApiError } = require("../utils/errors");
const { getEmailQueueStats } = require("../queues/email-queue");

const router = express.Router();

router.get("/queues/email/stats", requireAuth, requireRoles("ADMIN"), async (req, res, next) => {
  try {
    const stats = await getEmailQueueStats();
    return res.status(200).json(stats);
  } catch (err) {
    return next(err);
  }
});

const strongPassword = z
  .string()
  .min(8)
  .regex(/[A-Z]/, "Must include uppercase")
  .regex(/[a-z]/, "Must include lowercase")
  .regex(/[0-9]/, "Must include digit")
  .regex(/[^A-Za-z0-9]/, "Must include special character");

const createPrivilegedUserSchema = z.object({
  email: z.string().email(),
  password: strongPassword,
  displayName: z.string().min(2).max(100),
  role: z.enum(["MODERATOR", "ADMIN"]),
});

const updateRoleSchema = z.object({
  role: z.enum(["BUYER", "SELLER", "MODERATOR", "ADMIN"]),
  reason: z.string().max(500).optional(),
});

const updateStatusSchema = z.object({
  status: z.enum(["ACTIVE", "SUSPENDED", "DELETED"]),
  reason: z.string().max(500).optional(),
});

const banSchema = z.object({
  reason: z.string().min(5).max(500),
});

const userListQuerySchema = z.object({
  role: z.enum(["BUYER", "SELLER", "MODERATOR", "ADMIN"]).optional(),
  status: z.enum(["ACTIVE", "SUSPENDED", "DELETED"]).optional(),
  q: z.string().min(1).max(120).optional(),
});

const orderListQuerySchema = z.object({
  status: z
    .enum(["CREATED", "FUNDED_100", "HANDOVER_CONFIRMED", "INSPECTION_ACTIVE", "DISPUTED", "COMPLETED", "CANCELLED"])
    .optional(),
  buyerId: z.string().uuid().optional(),
  sellerId: z.string().uuid().optional(),
});

const forceCompleteSchema = z.object({
  reason: z.string().min(5).max(500),
});

const summaryQuerySchema = z.object({
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
});

async function ensureNotLastAdmin(userId, currentRole) {
  if (currentRole !== "ADMIN") return;
  const adminCount = await prisma.user.count({ where: { role: "ADMIN", status: "ACTIVE" } });
  if (adminCount <= 1) {
    throw new ApiError(409, "CONFLICT", "Cannot demote or deactivate the last active admin");
  }
}

router.post("/users", requireAuth, requireRoles("ADMIN"), async (req, res, next) => {
  try {
    const body = createPrivilegedUserSchema.parse(req.body);

    const exists = await prisma.user.findUnique({ where: { email: body.email } });
    if (exists) throw new ApiError(409, "CONFLICT", "Email already in use");

    const passwordHash = await argon2.hash(body.password);

    const created = await prisma.$transaction(async (tx) => {
      const user = await tx.user.create({
        data: {
          email: body.email,
          passwordHash,
          role: body.role,
          displayName: body.displayName,
        },
        select: { id: true, email: true, role: true, status: true, displayName: true, trustScore: true, createdAt: true },
      });
      await tx.auditLog.create({
        data: {
          actorUserId: req.user.id,
          action: "ADMIN_USER_CREATE",
          entityType: "User",
          entityId: user.id,
          beforeJson: null,
          afterJson: { email: user.email, role: user.role, displayName: user.displayName },
          ipAddress: req.ip,
          userAgent: req.headers["user-agent"] || null,
        },
      });
      return user;
    });

    return res.status(201).json(created);
  } catch (error) {
    if (error instanceof z.ZodError) {
      return next(new ApiError(422, "VALIDATION_ERROR", "Validation failed", error.flatten()));
    }
    return next(error);
  }
});

router.patch("/users/:userId/role", requireAuth, requireRoles("ADMIN"), async (req, res, next) => {
  try {
    const body = updateRoleSchema.parse(req.body);
    const userId = z.string().uuid().parse(req.params.userId);

    const existing = await prisma.user.findUnique({ where: { id: userId } });
    if (!existing) throw new ApiError(404, "NOT_FOUND", "User not found");

    if (existing.role === "ADMIN" && body.role !== "ADMIN") {
      await ensureNotLastAdmin(userId, existing.role);
    }

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

    if (existing.role === "ADMIN" && existing.status === "ACTIVE" && body.status !== "ACTIVE") {
      await ensureNotLastAdmin(userId, existing.role);
    }

    const updated = await prisma.$transaction(async (tx) => {
      const changed = await tx.user.update({
        where: { id: userId },
        data: { status: body.status },
        select: { id: true, email: true, role: true, status: true, displayName: true, trustScore: true },
      });
      // Suspending or deleting a user revokes all of their sessions.
      if (body.status !== "ACTIVE") {
        await tx.refreshToken.updateMany({
          where: { userId, revokedAt: null },
          data: { revokedAt: new Date() },
        });
      }
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

router.patch("/users/:userId/ban", requireAuth, requireRoles("ADMIN"), async (req, res, next) => {
  try {
    const userId = z.string().uuid().parse(req.params.userId);
    const body = banSchema.parse(req.body);

    const existing = await prisma.user.findUnique({ where: { id: userId } });
    if (!existing) throw new ApiError(404, "NOT_FOUND", "User not found");
    if (existing.status === "DELETED") throw new ApiError(409, "CONFLICT", "Cannot ban a deleted user");
    if (existing.status === "SUSPENDED") throw new ApiError(409, "CONFLICT", "User is already suspended");

    if (existing.role === "ADMIN") {
      await ensureNotLastAdmin(userId, existing.role);
    }

    const updated = await prisma.$transaction(async (tx) => {
      const changed = await tx.user.update({
        where: { id: userId },
        data: { status: "SUSPENDED" },
        select: { id: true, email: true, role: true, status: true, displayName: true, trustScore: true },
      });
      await tx.refreshToken.updateMany({
        where: { userId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      await tx.auditLog.create({
        data: {
          actorUserId: req.user.id,
          action: "ADMIN_BAN_USER",
          entityType: "User",
          entityId: userId,
          beforeJson: { status: existing.status },
          afterJson: { status: "SUSPENDED", reason: body.reason },
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

router.delete("/users/:userId", requireAuth, requireRoles("ADMIN"), async (req, res, next) => {
  try {
    const userId = z.string().uuid().parse(req.params.userId);
    if (userId === req.user.id) {
      throw new ApiError(409, "CONFLICT", "Admin cannot delete their own account through this endpoint");
    }
    const reason = req.query.reason ? String(req.query.reason).slice(0, 500) : null;

    const existing = await prisma.user.findUnique({ where: { id: userId } });
    if (!existing) throw new ApiError(404, "NOT_FOUND", "User not found");
    if (existing.status === "DELETED") throw new ApiError(409, "CONFLICT", "User is already deleted");

    if (existing.role === "ADMIN") {
      await ensureNotLastAdmin(userId, existing.role);
    }

    const inFlight = await prisma.order.count({
      where: {
        OR: [{ buyerId: userId }, { sellerId: userId }],
        status: { in: ["FUNDED_100", "INSPECTION_ACTIVE", "DISPUTED"] },
      },
    });
    if (inFlight > 0) {
      throw new ApiError(409, "CONFLICT", "User has orders in flight; resolve them first");
    }

    const result = await prisma.$transaction(async (tx) => {
      const changed = await tx.user.update({
        where: { id: userId },
        data: {
          status: "DELETED",
          email: `deleted+${userId}@purrfect.invalid`,
          phone: null,
          displayName: "Deleted user",
        },
        select: { id: true, status: true, displayName: true },
      });
      await tx.refreshToken.updateMany({
        where: { userId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      await tx.auditLog.create({
        data: {
          actorUserId: req.user.id,
          action: "ADMIN_DELETE_USER",
          entityType: "User",
          entityId: userId,
          beforeJson: { status: existing.status, role: existing.role },
          afterJson: { status: "DELETED", reason },
          ipAddress: req.ip,
          userAgent: req.headers["user-agent"] || null,
        },
      });
      return changed;
    });

    return res.status(200).json(result);
  } catch (error) {
    if (error instanceof z.ZodError) return next(new ApiError(422, "VALIDATION_ERROR", "Validation failed", error.flatten()));
    return next(error);
  }
});

router.get("/users/:userId", requireAuth, requireRoles("ADMIN"), async (req, res, next) => {
  try {
    const userId = z.string().uuid().parse(req.params.userId);
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        email: true,
        phone: true,
        role: true,
        status: true,
        displayName: true,
        trustScore: true,
        createdAt: true,
        updatedAt: true,
      },
    });
    if (!user) throw new ApiError(404, "NOT_FOUND", "User not found");

    const [
      listingsCount,
      activeListingsCount,
      ordersAsBuyer,
      ordersAsSeller,
      openDisputes,
      activeSessions,
      auditLogsCount,
    ] = await Promise.all([
      prisma.listing.count({ where: { sellerId: userId } }),
      prisma.listing.count({ where: { sellerId: userId, status: { in: ["PUBLISHED", "RESERVED"] } } }),
      prisma.order.count({ where: { buyerId: userId } }),
      prisma.order.count({ where: { sellerId: userId } }),
      prisma.dispute.count({
        where: { openedById: userId, status: { in: ["OPEN", "UNDER_REVIEW"] } },
      }),
      prisma.refreshToken.count({
        where: { userId, revokedAt: null, expiresAt: { gt: new Date() } },
      }),
      prisma.auditLog.count({ where: { actorUserId: userId } }),
    ]);

    return res.status(200).json({
      ...user,
      stats: {
        listingsCount,
        activeListingsCount,
        ordersAsBuyer,
        ordersAsSeller,
        openDisputes,
        activeSessions,
        auditLogsCount,
      },
    });
  } catch (error) {
    if (error instanceof z.ZodError) return next(new ApiError(422, "VALIDATION_ERROR", "Validation failed", error.flatten()));
    return next(error);
  }
});

router.get("/orders/:orderId", requireAuth, requireRoles("ADMIN"), async (req, res, next) => {
  try {
    const orderId = z.string().uuid().parse(req.params.orderId);
    const order = await prisma.order.findUnique({
      where: { id: orderId },
      include: {
        escrowTx: { orderBy: { createdAt: "desc" } },
        payouts: { orderBy: { milestone: "asc" } },
        inspection: true,
        dispute: true,
        listing: { select: { id: true, title: true, status: true, sellerId: true, priceKzt: true } },
        buyer: { select: { id: true, displayName: true, email: true, role: true, status: true } },
      },
    });
    if (!order) throw new ApiError(404, "NOT_FOUND", "Order not found");
    return res.status(200).json(order);
  } catch (error) {
    if (error instanceof z.ZodError) return next(new ApiError(422, "VALIDATION_ERROR", "Validation failed", error.flatten()));
    return next(error);
  }
});

router.get("/users", requireAuth, requireRoles("ADMIN"), async (req, res, next) => {
  try {
    const { limit, cursor } = parsePagination(req.query);
    const filters = userListQuerySchema.parse(req.query);

    const where = {
      ...(filters.role ? { role: filters.role } : {}),
      ...(filters.status ? { status: filters.status } : {}),
      ...(filters.q
        ? {
            OR: [
              { email: { contains: filters.q, mode: "insensitive" } },
              { displayName: { contains: filters.q, mode: "insensitive" } },
            ],
          }
        : {}),
    };

    const data = await prisma.user.findMany({
      where,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: limit + 1,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
      select: {
        id: true,
        email: true,
        role: true,
        status: true,
        displayName: true,
        trustScore: true,
        createdAt: true,
      },
    });

    return res.status(200).json(buildPagedResponse(data, limit));
  } catch (error) {
    if (error instanceof z.ZodError) return next(new ApiError(422, "VALIDATION_ERROR", "Validation failed", error.flatten()));
    return next(error);
  }
});

router.get("/orders", requireAuth, requireRoles("ADMIN"), async (req, res, next) => {
  try {
    const { limit, cursor } = parsePagination(req.query);
    const filters = orderListQuerySchema.parse(req.query);

    const where = {
      ...(filters.status ? { status: filters.status } : {}),
      ...(filters.buyerId ? { buyerId: filters.buyerId } : {}),
      ...(filters.sellerId ? { sellerId: filters.sellerId } : {}),
    };

    const data = await prisma.order.findMany({
      where,
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

router.post("/orders/:orderId/force-complete", requireAuth, requireRoles("ADMIN"), async (req, res, next) => {
  try {
    const orderId = z.string().uuid().parse(req.params.orderId);
    const body = forceCompleteSchema.parse(req.body);

    const updated = await prisma.$transaction(async (tx) => {
      const order = await tx.order.findUnique({ where: { id: orderId } });
      if (!order) throw new ApiError(404, "NOT_FOUND", "Order not found");
      if (order.status === "COMPLETED" || order.status === "CANCELLED") {
        throw new ApiError(409, "CONFLICT", "Order is already in a terminal state");
      }

      const milestone2 = await tx.payout.findUnique({
        where: { orderId_milestone: { orderId, milestone: 2 } },
      });
      const priorPayout2 = await tx.escrowTransaction.count({
        where: { orderId, txType: "PAYOUT_MILESTONE_2" },
      });

      if (!milestone2 || milestone2.status !== "RELEASED") {
        await tx.escrowTransaction.create({
          data: {
            orderId,
            txType: "PAYOUT_MILESTONE_2",
            amountKzt: order.payout2Kzt,
            idempotencyKey: `payout2_force_${orderId}_${priorPayout2}`,
            metadataJson: { adminId: req.user.id, reason: body.reason },
          },
        });
        await tx.payout.update({
          where: { orderId_milestone: { orderId, milestone: 2 } },
          data: { status: "RELEASED", releasedAt: new Date() },
        });
      }

      const next = await tx.order.update({
        where: { id: orderId },
        data: { status: "COMPLETED", completedAt: new Date() },
      });
      await tx.listing.update({ where: { id: order.listingId }, data: { status: "SOLD" } });
      await tx.auditLog.create({
        data: {
          actorUserId: req.user.id,
          action: "ADMIN_FORCE_COMPLETE_ORDER",
          entityType: "Order",
          entityId: orderId,
          beforeJson: { status: order.status },
          afterJson: { status: "COMPLETED", reason: body.reason },
          ipAddress: req.ip,
          userAgent: req.headers["user-agent"] || null,
        },
      });
      return next;
    });

    return res.status(200).json(updated);
  } catch (error) {
    if (error instanceof z.ZodError) return next(new ApiError(422, "VALIDATION_ERROR", "Validation failed", error.flatten()));
    return next(error);
  }
});

router.get("/audit-logs", requireAuth, requireRoles("ADMIN"), async (req, res, next) => {
  try {
    const { limit, cursor } = parsePagination(req.query);
    const action = req.query.action ? String(req.query.action) : undefined;
    const entityType = req.query.entityType ? String(req.query.entityType) : undefined;
    const actorUserId = req.query.actorUserId
      ? z.string().uuid().parse(req.query.actorUserId)
      : undefined;

    const data = await prisma.auditLog.findMany({
      where: {
        ...(action ? { action } : {}),
        ...(entityType ? { entityType } : {}),
        ...(actorUserId ? { actorUserId } : {}),
      },
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

router.get("/financial-summary", requireAuth, requireRoles("ADMIN"), async (req, res, next) => {
  try {
    const { from, to } = summaryQuerySchema.parse(req.query);
    const where = {};
    if (from || to) {
      where.createdAt = {
        ...(from ? { gte: new Date(from) } : {}),
        ...(to ? { lte: new Date(to) } : {}),
      };
    }

    const grouped = await prisma.escrowTransaction.groupBy({
      by: ["txType"],
      where,
      _sum: { amountKzt: true },
      _count: { _all: true },
    });

    const totals = { txTypes: {}, totalAmountKzt: 0, totalCount: 0 };
    for (const g of grouped) {
      const sum = Number(g._sum.amountKzt || 0);
      totals.txTypes[g.txType] = { count: g._count._all, sumKzt: sum };
      totals.totalAmountKzt += sum;
      totals.totalCount += g._count._all;
    }

    const platformFeeSum = await prisma.order.aggregate({
      where: from || to ? { createdAt: where.createdAt } : {},
      _sum: { platformFeeKzt: true },
    });
    totals.platformFeeKzt = Number(platformFeeSum._sum.platformFeeKzt || 0);

    return res.status(200).json({
      window: { from: from || null, to: to || null },
      ...totals,
    });
  } catch (error) {
    if (error instanceof z.ZodError) return next(new ApiError(422, "VALIDATION_ERROR", "Validation failed", error.flatten()));
    return next(error);
  }
});

module.exports = router;
