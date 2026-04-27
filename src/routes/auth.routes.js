const crypto = require("crypto");
const argon2 = require("argon2");
const express = require("express");
const { z } = require("zod");
const { prisma } = require("../config/prisma");
const { authRateLimit } = require("../middleware/rate-limit");
const { ApiError } = require("../utils/errors");
const {
  signAccessToken,
  signRefreshToken,
  verifyRefreshToken,
  hashToken,
} = require("../services/token-service");

const router = express.Router();

const registerSchema = z.object({
  email: z.string().email(),
  password: z
    .string()
    .min(8)
    .regex(/[A-Z]/, "Must include uppercase")
    .regex(/[a-z]/, "Must include lowercase")
    .regex(/[0-9]/, "Must include digit")
    .regex(/[^A-Za-z0-9]/, "Must include special character"),
  displayName: z.string().min(2).max(100),
  role: z.enum(["BUYER", "SELLER"]),
});

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

const refreshSchema = z.object({
  refreshToken: z.string().min(1),
});

function parseExpiresToDate(secondsFromNow) {
  return new Date(Date.now() + secondsFromNow * 1000);
}

router.post("/register", authRateLimit, async (req, res, next) => {
  try {
    const body = registerSchema.parse(req.body);

    const exists = await prisma.user.findUnique({ where: { email: body.email } });
    if (exists) throw new ApiError(409, "CONFLICT", "Email already in use");

    const passwordHash = await argon2.hash(body.password);
    const user = await prisma.user.create({
      data: {
        email: body.email,
        passwordHash,
        role: body.role,
        displayName: body.displayName,
      },
      select: { id: true, email: true, role: true, displayName: true, trustScore: true },
    });

    const familyId = crypto.randomUUID();
    const accessToken = signAccessToken({ sub: user.id, role: user.role });
    const refreshToken = signRefreshToken({ sub: user.id, role: user.role, familyId });
    const decodedRefresh = verifyRefreshToken(refreshToken);

    await prisma.refreshToken.create({
      data: {
        userId: user.id,
        tokenHash: hashToken(refreshToken),
        familyId,
        expiresAt: parseExpiresToDate(decodedRefresh.exp - decodedRefresh.iat),
      },
    });

    return res.status(201).json({ accessToken, refreshToken, user });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return next(new ApiError(422, "VALIDATION_ERROR", "Validation failed", error.flatten()));
    }
    return next(error);
  }
});

router.post("/login", authRateLimit, async (req, res, next) => {
  try {
    const body = loginSchema.parse(req.body);
    const user = await prisma.user.findUnique({ where: { email: body.email } });
    if (!user) throw new ApiError(401, "UNAUTHORIZED", "Invalid email or password");

    const valid = await argon2.verify(user.passwordHash, body.password);
    if (!valid) throw new ApiError(401, "UNAUTHORIZED", "Invalid email or password");
    if (user.status !== "ACTIVE") throw new ApiError(401, "UNAUTHORIZED", "User is not active");

    const familyId = crypto.randomUUID();
    const accessToken = signAccessToken({ sub: user.id, role: user.role });
    const refreshToken = signRefreshToken({ sub: user.id, role: user.role, familyId });
    const decodedRefresh = verifyRefreshToken(refreshToken);

    await prisma.refreshToken.create({
      data: {
        userId: user.id,
        tokenHash: hashToken(refreshToken),
        familyId,
        expiresAt: parseExpiresToDate(decodedRefresh.exp - decodedRefresh.iat),
      },
    });

    return res.status(200).json({
      accessToken,
      refreshToken,
      user: {
        id: user.id,
        email: user.email,
        role: user.role,
        displayName: user.displayName,
        trustScore: user.trustScore,
      },
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return next(new ApiError(422, "VALIDATION_ERROR", "Validation failed", error.flatten()));
    }
    return next(error);
  }
});

router.post("/refresh", async (req, res, next) => {
  try {
    const { refreshToken } = refreshSchema.parse(req.body);
    const payload = verifyRefreshToken(refreshToken);
    const incomingHash = hashToken(refreshToken);

    const tokenRecord = await prisma.refreshToken.findUnique({ where: { tokenHash: incomingHash } });
    if (!tokenRecord || tokenRecord.revokedAt || tokenRecord.expiresAt < new Date()) {
      throw new ApiError(401, "UNAUTHORIZED", "Refresh token is invalid or revoked");
    }

    const user = await prisma.user.findUnique({ where: { id: payload.sub } });
    if (!user || user.status !== "ACTIVE") {
      throw new ApiError(401, "UNAUTHORIZED", "User is not active");
    }

    const newAccessToken = signAccessToken({ sub: user.id, role: user.role });
    const newRefreshToken = signRefreshToken({ sub: user.id, role: user.role, familyId: payload.familyId });
    const decodedNewRefresh = verifyRefreshToken(newRefreshToken);

    await prisma.$transaction([
      prisma.refreshToken.update({
        where: { tokenHash: incomingHash },
        data: { revokedAt: new Date() },
      }),
      prisma.refreshToken.create({
        data: {
          userId: user.id,
          familyId: payload.familyId,
          tokenHash: hashToken(newRefreshToken),
          expiresAt: parseExpiresToDate(decodedNewRefresh.exp - decodedNewRefresh.iat),
        },
      }),
    ]);

    return res.status(200).json({
      accessToken: newAccessToken,
      refreshToken: newRefreshToken,
      user: {
        id: user.id,
        email: user.email,
        role: user.role,
        displayName: user.displayName,
        trustScore: user.trustScore,
      },
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return next(new ApiError(422, "VALIDATION_ERROR", "Validation failed", error.flatten()));
    }
    return next(error);
  }
});

router.post("/logout", async (req, res, next) => {
  try {
    const { refreshToken } = refreshSchema.parse(req.body);
    const incomingHash = hashToken(refreshToken);
    const existing = await prisma.refreshToken.findUnique({ where: { tokenHash: incomingHash } });

    if (existing) {
      await prisma.refreshToken.update({
        where: { tokenHash: incomingHash },
        data: { revokedAt: new Date() },
      });
    }

    return res.status(200).json({ success: true });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return next(new ApiError(422, "VALIDATION_ERROR", "Validation failed", error.flatten()));
    }
    return next(error);
  }
});

module.exports = router;
