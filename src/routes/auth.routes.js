const crypto = require("crypto");
const argon2 = require("argon2");
const express = require("express");
const { z } = require("zod");
const env = require("../config/env");
const { prisma } = require("../config/prisma");
const { redis } = require("../config/redis");
const { authRateLimit } = require("../middleware/rate-limit");
const { requireAuth } = require("../middleware/auth");
const { ApiError } = require("../utils/errors");
const {
  signAccessToken,
  signRefreshToken,
  verifyRefreshToken,
  hashToken,
} = require("../services/token-service");
const { enqueueEmail } = require("../queues/email-queue");

const VERIFICATION_TTL_HOURS = 24;

const router = express.Router();

const strongPassword = z
  .string()
  .min(8)
  .regex(/[A-Z]/, "Must include uppercase")
  .regex(/[a-z]/, "Must include lowercase")
  .regex(/[0-9]/, "Must include digit")
  .regex(/[^A-Za-z0-9]/, "Must include special character");

const registerSchema = z.object({
  email: z.string().email(),
  password: strongPassword,
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

const forgotPasswordSchema = z.object({
  email: z.string().email(),
});

const resetPasswordSchema = z.object({
  token: z.string().min(16).max(256),
  newPassword: strongPassword,
});

const PASSWORD_RESET_TTL_SECONDS = 15 * 60;

function parseExpiresToDate(secondsFromNow) {
  return new Date(Date.now() + secondsFromNow * 1000);
}

router.post("/register", authRateLimit, async (req, res, next) => {
  try {
    const body = registerSchema.parse(req.body);

    const exists = await prisma.user.findUnique({ where: { email: body.email } });
    if (exists) throw new ApiError(409, "CONFLICT", "Email already in use");

    const passwordHash = await argon2.hash(body.password);

    const verificationToken = crypto.randomBytes(32).toString("hex");
    const verificationTokenHash = hashToken(verificationToken);
    const verificationExpiresAt = new Date(Date.now() + VERIFICATION_TTL_HOURS * 60 * 60 * 1000);

    const user = await prisma.user.create({
      data: {
        email: body.email,
        passwordHash,
        role: body.role,
        displayName: body.displayName,
        emailVerificationTokenHash: verificationTokenHash,
        emailVerificationExpiresAt: verificationExpiresAt,
      },
      select: {
        id: true,
        email: true,
        role: true,
        displayName: true,
        trustScore: true,
        emailVerifiedAt: true,
      },
    });

    const familyId = crypto.randomUUID();
    const jti = crypto.randomUUID();
    const accessToken = signAccessToken({ sub: user.id, role: user.role });
    const refreshToken = signRefreshToken({ sub: user.id, role: user.role, familyId, jti });
    const decodedRefresh = verifyRefreshToken(refreshToken);

    await prisma.refreshToken.create({
      data: {
        userId: user.id,
        tokenHash: hashToken(refreshToken),
        familyId,
        expiresAt: parseExpiresToDate(decodedRefresh.exp - decodedRefresh.iat),
      },
    });

    // Side-effect after the DB write: queue the verification email asynchronously
    // so the API response is not blocked by the 3rd-party provider.
    await enqueueEmail({
      to: user.email,
      templateCode: "auth.verify",
      payload: {
        verificationUrl: `${env.APP_BASE_URL}/auth/verify-email?token=${verificationToken}`,
        displayName: user.displayName,
      },
      idempotencyKey: `verify-email:${user.id}:initial`,
    });

    return res.status(201).json({ accessToken, refreshToken, user });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return next(new ApiError(422, "VALIDATION_ERROR", "Validation failed", error.flatten()));
    }
    return next(error);
  }
});

const verifyEmailSchema = z.object({
  token: z.string().min(16).max(256),
});

const resendVerificationSchema = z.object({
  email: z.string().email(),
});

router.post("/verify-email", async (req, res, next) => {
  try {
    // Token may arrive in body OR query (link click) — accept both.
    const tokenInput = req.body?.token || req.query?.token;
    const { token } = verifyEmailSchema.parse({ token: tokenInput });
    const tokenHash = hashToken(token);

    const user = await prisma.user.findUnique({
      where: { emailVerificationTokenHash: tokenHash },
      select: { id: true, emailVerifiedAt: true, emailVerificationExpiresAt: true },
    });

    if (!user) throw new ApiError(401, "UNAUTHORIZED", "Verification token is invalid");
    if (user.emailVerifiedAt) {
      return res.status(200).json({ success: true, alreadyVerified: true });
    }
    if (!user.emailVerificationExpiresAt || user.emailVerificationExpiresAt < new Date()) {
      throw new ApiError(401, "UNAUTHORIZED", "Verification token expired");
    }

    await prisma.user.update({
      where: { id: user.id },
      data: {
        emailVerifiedAt: new Date(),
        emailVerificationTokenHash: null,
        emailVerificationExpiresAt: null,
      },
    });

    return res.status(200).json({ success: true });
  } catch (error) {
    if (error instanceof z.ZodError) return next(new ApiError(422, "VALIDATION_ERROR", "Validation failed", error.flatten()));
    return next(error);
  }
});

router.post("/resend-verification", authRateLimit, async (req, res, next) => {
  try {
    const { email } = resendVerificationSchema.parse(req.body);

    // Always return 200 to avoid leaking which emails exist.
    const baseResponse = {
      success: true,
      message: "If the email exists and needs verification, a new link has been sent.",
    };

    const user = await prisma.user.findUnique({
      where: { email },
      select: { id: true, displayName: true, email: true, emailVerifiedAt: true, status: true },
    });

    if (!user || user.status !== "ACTIVE" || user.emailVerifiedAt) {
      return res.status(200).json(baseResponse);
    }

    const newToken = crypto.randomBytes(32).toString("hex");
    const newHash = hashToken(newToken);
    const newExpiresAt = new Date(Date.now() + VERIFICATION_TTL_HOURS * 60 * 60 * 1000);

    await prisma.user.update({
      where: { id: user.id },
      data: {
        emailVerificationTokenHash: newHash,
        emailVerificationExpiresAt: newExpiresAt,
      },
    });

    await enqueueEmail({
      to: user.email,
      templateCode: "auth.verify",
      payload: {
        verificationUrl: `${env.APP_BASE_URL}/auth/verify-email?token=${newToken}`,
        displayName: user.displayName,
      },
      idempotencyKey: `verify-email:${user.id}:${newHash.slice(0, 12)}`,
    });

    return res.status(200).json(baseResponse);
  } catch (error) {
    if (error instanceof z.ZodError) return next(new ApiError(422, "VALIDATION_ERROR", "Validation failed", error.flatten()));
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
    const jti = crypto.randomUUID();
    const accessToken = signAccessToken({ sub: user.id, role: user.role });
    const refreshToken = signRefreshToken({ sub: user.id, role: user.role, familyId, jti });
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
    if (!tokenRecord) {
      throw new ApiError(401, "UNAUTHORIZED", "Refresh token is invalid");
    }

    // Reuse detection: if token was already revoked but somebody is trying to use it,
    // somebody has a copy. Kill the entire session family to be safe.
    if (tokenRecord.revokedAt) {
      await prisma.refreshToken.updateMany({
        where: { familyId: tokenRecord.familyId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      throw new ApiError(401, "UNAUTHORIZED", "Refresh token reuse detected; entire session family revoked");
    }
    if (tokenRecord.expiresAt < new Date()) {
      throw new ApiError(401, "UNAUTHORIZED", "Refresh token expired");
    }

    const user = await prisma.user.findUnique({ where: { id: payload.sub } });
    if (!user || user.status !== "ACTIVE") {
      throw new ApiError(401, "UNAUTHORIZED", "User is not active");
    }

    const newAccessToken = signAccessToken({ sub: user.id, role: user.role });
    const newJti = crypto.randomUUID();
    const newRefreshToken = signRefreshToken({ sub: user.id, role: user.role, familyId: payload.familyId, jti: newJti });
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

router.post("/logout-all", requireAuth, async (req, res, next) => {
  try {
    await prisma.refreshToken.updateMany({
      where: { userId: req.user.id, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    return res.status(200).json({ success: true });
  } catch (error) {
    return next(error);
  }
});

router.post("/forgot-password", authRateLimit, async (req, res, next) => {
  try {
    const { email } = forgotPasswordSchema.parse(req.body);
    const user = await prisma.user.findUnique({ where: { email } });

    // Always respond 200 so attackers cannot enumerate registered emails.
    const baseResponse = {
      success: true,
      message: "If the email is registered, a password reset link has been sent.",
    };

    if (user && user.status === "ACTIVE") {
      const token = crypto.randomBytes(32).toString("hex");
      const tokenHash = hashToken(token);
      await redis.set(`pwreset:${tokenHash}`, user.id, "EX", PASSWORD_RESET_TTL_SECONDS);
      await enqueueEmail({
        to: user.email,
        templateCode: "auth.password-reset",
        payload: {
          resetUrl: `${env.APP_BASE_URL}/auth/reset-password?token=${token}`,
          displayName: user.displayName,
        },
        idempotencyKey: `pwreset:${user.id}:${tokenHash.slice(0, 12)}`,
      });
    }

    return res.status(200).json(baseResponse);
  } catch (error) {
    if (error instanceof z.ZodError) {
      return next(new ApiError(422, "VALIDATION_ERROR", "Validation failed", error.flatten()));
    }
    return next(error);
  }
});

router.post("/reset-password", authRateLimit, async (req, res, next) => {
  try {
    const body = resetPasswordSchema.parse(req.body);
    const tokenHash = hashToken(body.token);
    const userId = await redis.get(`pwreset:${tokenHash}`);
    if (!userId) throw new ApiError(401, "UNAUTHORIZED", "Reset token is invalid or expired");

    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user || user.status !== "ACTIVE") throw new ApiError(401, "UNAUTHORIZED", "Account is not active");

    const newHash = await argon2.hash(body.newPassword);
    await prisma.$transaction([
      prisma.user.update({ where: { id: user.id }, data: { passwordHash: newHash } }),
      prisma.refreshToken.updateMany({
        where: { userId: user.id, revokedAt: null },
        data: { revokedAt: new Date() },
      }),
    ]);
    await redis.del(`pwreset:${tokenHash}`);

    return res.status(200).json({ success: true, message: "Password reset. Please login again." });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return next(new ApiError(422, "VALIDATION_ERROR", "Validation failed", error.flatten()));
    }
    return next(error);
  }
});

module.exports = router;
