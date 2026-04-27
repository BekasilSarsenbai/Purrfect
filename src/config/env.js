const dotenv = require("dotenv");
const { z } = require("zod");

dotenv.config();

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(3000),
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  JWT_ACCESS_SECRET: z.string().min(32, "JWT_ACCESS_SECRET must be at least 32 chars"),
  JWT_REFRESH_SECRET: z.string().min(32, "JWT_REFRESH_SECRET must be at least 32 chars"),
  JWT_ACCESS_EXPIRES_IN: z.string().default("15m"),
  JWT_REFRESH_EXPIRES_IN: z.string().default("7d"),
  CORS_ORIGINS: z.string().min(1, "CORS_ORIGINS is required"),
  PLATFORM_FEE_PERCENT: z.coerce.number().min(0).max(100).default(5),
  REDIS_URL: z.string().min(1, "REDIS_URL is required"),
});

const parsed = envSchema.safeParse(process.env);
if (!parsed.success) {
  const formatted = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
  throw new Error(`Environment validation failed: ${formatted}`);
}

module.exports = parsed.data;
