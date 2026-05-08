const express = require("express");
const argon2 = require("argon2");
const { z } = require("zod");
const { prisma } = require("../config/prisma");
const { requireAuth } = require("../middleware/auth");
const { ApiError } = require("../utils/errors");

const router = express.Router();

const PUBLIC_USER_SELECT = {
  id: true,
  displayName: true,
  role: true,
  trustScore: true,
  createdAt: true,
};

const SELF_USER_SELECT = {
  id: true,
  email: true,
  phone: true,
  displayName: true,
  role: true,
  status: true,
  trustScore: true,
  createdAt: true,
  updatedAt: true,
};

router.get("/me", requireAuth, async (req, res, next) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.user.id },
      select: SELF_USER_SELECT,
    });
    if (!user) throw new ApiError(404, "NOT_FOUND", "User not found");
    return res.status(200).json(user);
  } catch (error) {
    return next(error);
  }
});

const updateMeSchema = z
  .object({
    displayName: z.string().min(2).max(100).optional(),
    phone: z
      .string()
      .regex(/^\+?[0-9]{7,15}$/, "Phone must be 7-15 digits, optional leading +")
      .optional(),
  })
  .refine((d) => d.displayName !== undefined || d.phone !== undefined, {
    message: "At least one field (displayName, phone) is required",
  });

router.patch("/me/profile", requireAuth, async (req, res, next) => {
  try {
    const body = updateMeSchema.parse(req.body);

    if (body.phone) {
      const taken = await prisma.user.findFirst({
        where: { phone: body.phone, NOT: { id: req.user.id } },
        select: { id: true },
      });
      if (taken) throw new ApiError(409, "CONFLICT", "Phone is already in use");
    }

    const updated = await prisma.user.update({
      where: { id: req.user.id },
      data: body,
      select: SELF_USER_SELECT,
    });
    return res.status(200).json(updated);
  } catch (error) {
    if (error instanceof z.ZodError) return next(new ApiError(422, "VALIDATION_ERROR", "Validation failed", error.flatten()));
    return next(error);
  }
});

const changePasswordSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: z
    .string()
    .min(8)
    .regex(/[A-Z]/, "Must include uppercase")
    .regex(/[a-z]/, "Must include lowercase")
    .regex(/[0-9]/, "Must include digit")
    .regex(/[^A-Za-z0-9]/, "Must include special character"),
});

router.post("/me/change-password", requireAuth, async (req, res, next) => {
  try {
    const body = changePasswordSchema.parse(req.body);
    const user = await prisma.user.findUnique({ where: { id: req.user.id } });
    if (!user) throw new ApiError(404, "NOT_FOUND", "User not found");

    const isValid = await argon2.verify(user.passwordHash, body.currentPassword);
    if (!isValid) throw new ApiError(401, "UNAUTHORIZED", "Current password is incorrect");

    const newHash = await argon2.hash(body.newPassword);
    await prisma.$transaction([
      prisma.user.update({
        where: { id: req.user.id },
        data: { passwordHash: newHash },
      }),
      prisma.refreshToken.updateMany({
        where: { userId: req.user.id, revokedAt: null },
        data: { revokedAt: new Date() },
      }),
    ]);

    return res.status(200).json({ success: true, message: "Password updated. Please login again." });
  } catch (error) {
    if (error instanceof z.ZodError) return next(new ApiError(422, "VALIDATION_ERROR", "Validation failed", error.flatten()));
    return next(error);
  }
});

router.get("/me/sessions", requireAuth, async (req, res, next) => {
  try {
    const sessions = await prisma.refreshToken.findMany({
      where: { userId: req.user.id },
      orderBy: [{ createdAt: "desc" }],
      select: { id: true, familyId: true, createdAt: true, expiresAt: true, revokedAt: true },
    });
    return res.status(200).json(sessions);
  } catch (error) {
    return next(error);
  }
});

router.delete("/me/sessions/:sessionId", requireAuth, async (req, res, next) => {
  try {
    const sessionId = z.string().uuid().parse(req.params.sessionId);
    const session = await prisma.refreshToken.findUnique({ where: { id: sessionId } });
    if (!session || session.userId !== req.user.id) throw new ApiError(404, "NOT_FOUND", "Session not found");

    await prisma.refreshToken.update({
      where: { id: sessionId },
      data: { revokedAt: new Date() },
    });
    return res.status(200).json({ success: true });
  } catch (error) {
    if (error instanceof z.ZodError) return next(new ApiError(422, "VALIDATION_ERROR", "Validation failed", error.flatten()));
    return next(error);
  }
});

router.get("/me/stats", requireAuth, async (req, res, next) => {
  try {
    const [
      activeListings,
      soldListings,
      buyOrdersTotal,
      sellOrdersTotal,
      completedBuyOrders,
      completedSellOrders,
      openDisputes,
      unreadNotifications,
    ] = await Promise.all([
      prisma.listing.count({ where: { sellerId: req.user.id, status: { in: ["PUBLISHED", "RESERVED"] } } }),
      prisma.listing.count({ where: { sellerId: req.user.id, status: "SOLD" } }),
      prisma.order.count({ where: { buyerId: req.user.id } }),
      prisma.order.count({ where: { sellerId: req.user.id } }),
      prisma.order.count({ where: { buyerId: req.user.id, status: "COMPLETED" } }),
      prisma.order.count({ where: { sellerId: req.user.id, status: "COMPLETED" } }),
      prisma.dispute.count({
        where: {
          openedById: req.user.id,
          status: { in: ["OPEN", "UNDER_REVIEW"] },
        },
      }),
      prisma.notification.count({ where: { userId: req.user.id, status: "UNREAD" } }),
    ]);

    return res.status(200).json({
      trustScore: req.user.trustScore,
      listings: { active: activeListings, sold: soldListings },
      orders: {
        asBuyer: { total: buyOrdersTotal, completed: completedBuyOrders },
        asSeller: { total: sellOrdersTotal, completed: completedSellOrders },
      },
      openDisputes,
      unreadNotifications,
    });
  } catch (error) {
    return next(error);
  }
});

router.get("/me/notifications", requireAuth, async (req, res, next) => {
  try {
    const querySchema = z.object({
      limit: z.coerce.number().int().min(1).max(100).default(20),
      cursor: z.string().uuid().optional(),
      status: z.enum(["UNREAD", "READ", "FAILED"]).optional(),
    });
    const { limit, cursor, status } = querySchema.parse(req.query);

    const data = await prisma.notification.findMany({
      where: { userId: req.user.id, ...(status ? { status } : {}) },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: limit + 1,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
      select: {
        id: true,
        channel: true,
        templateCode: true,
        payloadJson: true,
        status: true,
        createdAt: true,
      },
    });

    const hasNext = data.length > limit;
    const slice = hasNext ? data.slice(0, limit) : data;
    const nextCursor = hasNext ? slice[slice.length - 1].id : null;
    return res.status(200).json({ data: slice, meta: { hasNext, nextCursor } });
  } catch (error) {
    if (error instanceof z.ZodError) return next(new ApiError(422, "VALIDATION_ERROR", "Validation failed", error.flatten()));
    return next(error);
  }
});

router.patch("/me/notifications/:notificationId/read", requireAuth, async (req, res, next) => {
  try {
    const notificationId = z.string().uuid().parse(req.params.notificationId);
    const notification = await prisma.notification.findUnique({ where: { id: notificationId } });
    if (!notification || notification.userId !== req.user.id) {
      throw new ApiError(404, "NOT_FOUND", "Notification not found");
    }
    if (notification.status === "READ") {
      return res.status(200).json({ success: true, alreadyRead: true });
    }
    await prisma.notification.update({
      where: { id: notificationId },
      data: { status: "READ" },
    });
    return res.status(200).json({ success: true });
  } catch (error) {
    if (error instanceof z.ZodError) return next(new ApiError(422, "VALIDATION_ERROR", "Validation failed", error.flatten()));
    return next(error);
  }
});

router.post("/me/notifications/mark-all-read", requireAuth, async (req, res, next) => {
  try {
    const result = await prisma.notification.updateMany({
      where: { userId: req.user.id, status: "UNREAD" },
      data: { status: "READ" },
    });
    return res.status(200).json({ success: true, updated: result.count });
  } catch (error) {
    return next(error);
  }
});

router.post("/me/account/delete", requireAuth, async (req, res, next) => {
  try {
    const bodySchema = z.object({
      password: z.string().min(1),
      reason: z.string().max(500).optional(),
    });
    const body = bodySchema.parse(req.body);

    const user = await prisma.user.findUnique({ where: { id: req.user.id } });
    if (!user) throw new ApiError(404, "NOT_FOUND", "User not found");
    const valid = await argon2.verify(user.passwordHash, body.password);
    if (!valid) throw new ApiError(401, "UNAUTHORIZED", "Password is incorrect");

    const openOrders = await prisma.order.count({
      where: {
        OR: [{ buyerId: req.user.id }, { sellerId: req.user.id }],
        status: { in: ["FUNDED_100", "INSPECTION_ACTIVE", "DISPUTED"] },
      },
    });
    if (openOrders > 0) {
      throw new ApiError(409, "CONFLICT", "Cannot delete account while orders are still in flight");
    }

    await prisma.$transaction([
      prisma.user.update({
        where: { id: req.user.id },
        data: {
          status: "DELETED",
          email: `deleted+${req.user.id}@purrfect.invalid`,
          phone: null,
          displayName: "Deleted user",
        },
      }),
      prisma.refreshToken.updateMany({
        where: { userId: req.user.id, revokedAt: null },
        data: { revokedAt: new Date() },
      }),
      prisma.auditLog.create({
        data: {
          actorUserId: req.user.id,
          action: "USER_SELF_DELETE",
          entityType: "User",
          entityId: req.user.id,
          afterJson: { reason: body.reason || null },
          ipAddress: req.ip,
          userAgent: req.headers["user-agent"] || null,
        },
      }),
    ]);
    return res.status(200).json({ success: true });
  } catch (error) {
    if (error instanceof z.ZodError) return next(new ApiError(422, "VALIDATION_ERROR", "Validation failed", error.flatten()));
    return next(error);
  }
});

router.get("/:userId", requireAuth, async (req, res, next) => {
  try {
    const userId = z.string().uuid().parse(req.params.userId);
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: PUBLIC_USER_SELECT,
    });
    if (!user) throw new ApiError(404, "NOT_FOUND", "User not found");

    const [activeListings, completedSales] = await Promise.all([
      prisma.listing.count({ where: { sellerId: userId, status: "PUBLISHED" } }),
      prisma.order.count({ where: { sellerId: userId, status: "COMPLETED" } }),
    ]);

    return res.status(200).json({ ...user, activeListings, completedSales });
  } catch (error) {
    if (error instanceof z.ZodError) return next(new ApiError(422, "VALIDATION_ERROR", "Validation failed", error.flatten()));
    return next(error);
  }
});

module.exports = router;
