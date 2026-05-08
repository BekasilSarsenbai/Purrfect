const { Queue, QueueEvents } = require("bullmq");
const env = require("../config/env");

const REDIS_URL = env.REDIS_URL;

function parseRedisUrl(url) {
  const u = new URL(url);
  return {
    host: u.hostname,
    port: Number(u.port || 6379),
    password: u.password || undefined,
    username: u.username || undefined,
    maxRetriesPerRequest: null, // BullMQ contract: must be null on the underlying ioredis
  };
}

const connection = parseRedisUrl(REDIS_URL);

const EMAIL_QUEUE_NAME = "email";

const emailQueue = new Queue(EMAIL_QUEUE_NAME, {
  connection,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: "exponential", delay: 5000 }, // 5s, 25s, 125s
    removeOnComplete: { age: 24 * 60 * 60, count: 1000 }, // keep recent for observability
    removeOnFail: { age: 7 * 24 * 60 * 60 }, // keep failures a week for triage
  },
});

const emailQueueEvents = new QueueEvents(EMAIL_QUEUE_NAME, { connection });

async function enqueueEmail({ to, templateCode, payload, idempotencyKey }) {
  const jobId = idempotencyKey || undefined; // when provided, BullMQ deduplicates
  return emailQueue.add(
    "send",
    { to, templateCode, payload },
    { jobId },
  );
}

async function getEmailQueueStats() {
  const counts = await emailQueue.getJobCounts(
    "active",
    "completed",
    "failed",
    "delayed",
    "waiting",
    "paused",
  );
  return {
    queue: EMAIL_QUEUE_NAME,
    counts,
    workersAttached: (await emailQueue.getWorkers()).map((w) => ({ id: w.id, addr: w.addr || null })),
  };
}

async function closeEmailQueue() {
  await Promise.all([emailQueue.close(), emailQueueEvents.close()]);
}

module.exports = {
  EMAIL_QUEUE_NAME,
  emailQueue,
  emailQueueEvents,
  enqueueEmail,
  getEmailQueueStats,
  closeEmailQueue,
  __redisConnection: connection,
};
