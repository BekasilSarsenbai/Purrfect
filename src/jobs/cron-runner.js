const { Queue } = require("bullmq");
const { __redisConnection } = require("../queues/email-queue");

const CRON_QUEUE_NAME = "cron";

const cronQueue = new Queue(CRON_QUEUE_NAME, {
  connection: __redisConnection,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: "exponential", delay: 30 * 1000 },
    removeOnComplete: { age: 24 * 60 * 60, count: 200 },
    removeOnFail: { age: 7 * 24 * 60 * 60 },
  },
});

/**
 * Repeatable jobs registered on worker boot. Each entry uses a stable jobId
 * via the `repeatable` API so re-deployments don't fan-out duplicates.
 *
 * Cron format reminder (BullMQ uses `cron` library): `m h dom mon dow`.
 */
const RECURRING_JOBS = [
  {
    name: "inspection-deadline-reminder",
    cron: "0 * * * *", // every hour at :00
    description:
      "Find orders in INSPECTION_ACTIVE whose deadline lands inside the next 24h " +
      "and email the buyer once per hour-bucket. Idempotency via {orderId, hourBucket}.",
  },
  {
    name: "stale-verification-cleanup",
    cron: "30 3 * * *", // daily 03:30
    description:
      "Null-out emailVerificationToken{Hash,ExpiresAt} for users where the token expired > 24h ago.",
  },
];

async function runRecurringJobs() {
  for (const { name, cron } of RECURRING_JOBS) {
    await cronQueue.upsertJobScheduler(name, { pattern: cron }, { name, data: { kind: name } });
    console.log(`[cron] scheduled ${name} cron='${cron}'`);
  }
}

module.exports = {
  cronQueue,
  CRON_QUEUE_NAME,
  RECURRING_JOBS,
  runRecurringJobs,
};
