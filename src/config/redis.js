const Redis = require("ioredis");
const env = require("./env");

const redis = new Redis(env.REDIS_URL, {
  maxRetriesPerRequest: 3,
  lazyConnect: false,
  enableReadyCheck: true,
});

redis.on("error", (err) => {
  console.error("Redis connection error:", err.message);
});

redis.on("connect", () => {
  if (process.env.NODE_ENV !== "test") {
    console.log("Redis connected");
  }
});

async function closeRedis() {
  await redis.quit();
}

module.exports = { redis, closeRedis };
