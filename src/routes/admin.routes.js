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

module.exports = router;
