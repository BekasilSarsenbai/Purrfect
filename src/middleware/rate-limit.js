const { redis } = require("../config/redis");
const env = require("../config/env");

const AUTH_WINDOW_SECONDS = 60;
const AUTH_MAX_REQUESTS = env.NODE_ENV === "test" ? 1000 : 5;

/**
 * Redis sliding-window rate limiter for auth endpoints.
 * Uses a sorted set per IP: members = unique timestamps, scores = epoch-ms.
 * Expired members (outside the window) are pruned on every request.
 * Returns 429 when the in-window count exceeds AUTH_MAX_REQUESTS.
 */
async function authRateLimit(req, res, next) {
  const ip = req.ip || req.connection?.remoteAddress || "unknown";
  const key = `rate:auth:${ip}`;
  const now = Date.now();
  const windowStart = now - AUTH_WINDOW_SECONDS * 1000;

  try {
    const pipeline = redis.pipeline();
    pipeline.zremrangebyscore(key, "-inf", windowStart);
    pipeline.zadd(key, now, `${now}-${Math.random()}`);
    pipeline.zcard(key);
    pipeline.expire(key, AUTH_WINDOW_SECONDS * 2);

    const results = await pipeline.exec();
    const count = results[2][1];

    if (count > AUTH_MAX_REQUESTS) {
      res.set("Retry-After", String(AUTH_WINDOW_SECONDS));
      res.set("X-RateLimit-Limit", String(AUTH_MAX_REQUESTS));
      res.set("X-RateLimit-Remaining", "0");
      return res.status(429).json({
        code: "TOO_MANY_REQUESTS",
        message: "Too many auth attempts. Try again in 1 minute.",
      });
    }

    res.set("X-RateLimit-Limit", String(AUTH_MAX_REQUESTS));
    res.set("X-RateLimit-Remaining", String(Math.max(0, AUTH_MAX_REQUESTS - count)));
    return next();
  } catch (err) {
    // If Redis is unavailable, fail open rather than blocking all auth.
    console.error("Rate limiter Redis error — failing open:", err.message);
    return next();
  }
}

module.exports = { authRateLimit };
