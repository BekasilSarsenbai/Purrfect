const express = require("express");
const argon2 = require("argon2");
const { z } = require("zod");
const { prisma } = require("../config/prisma");
const { requireAuth } = require("../middleware/auth");
const { ApiError } = require("../utils/errors");

const router = express.Router();

router.get("/me", requireAuth, async (req, res) => {
  return res.status(200).json(req.user);
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

module.exports = router;
