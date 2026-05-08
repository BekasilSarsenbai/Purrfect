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
  ADMIN_EMAIL: z.string().email("ADMIN_EMAIL must be a valid email"),
  ADMIN_PASSWORD: z
    .string()
    .min(8, "ADMIN_PASSWORD must be at least 8 chars")
    .regex(/[A-Z]/, "ADMIN_PASSWORD must include uppercase")
    .regex(/[a-z]/, "ADMIN_PASSWORD must include lowercase")
    .regex(/[0-9]/, "ADMIN_PASSWORD must include digit")
    .regex(/[^A-Za-z0-9]/, "ADMIN_PASSWORD must include special character"),
  ADMIN_DISPLAY_NAME: z.string().min(2).max(100).default("Platform Admin"),
  RESEND_API_KEY: z.string().min(1, "RESEND_API_KEY is required"),
  EMAIL_FROM: z
    .string()
    .min(3)
    .default("Purrfect <onboarding@resend.dev>")
    .describe("Sender header used by Resend; the resend.dev sandbox domain is allowed for dev"),
  APP_BASE_URL: z
    .string()
    .url("APP_BASE_URL must be a valid URL")
    .default("http://localhost:3000")
    .describe("Public URL used in email verification + password reset links"),
  EMAIL_DELIVERY_MODE: z
    .enum(["live", "log"])
    .default("live")
    .describe("'log' = print email to stdout instead of calling Resend (useful in tests / no API key)"),
});

const parsed = envSchema.safeParse(process.env);
if (!parsed.success) {
  const formatted = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
  throw new Error(`Environment validation failed: ${formatted}`);
}

module.exports = parsed.data;
