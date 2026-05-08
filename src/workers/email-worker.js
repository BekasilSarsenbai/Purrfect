const { Worker } = require("bullmq");
const env = require("../config/env");
const { EMAIL_QUEUE_NAME, __redisConnection } = require("../queues/email-queue");
const { sendEmail } = require("../services/email-service");
const { CRON_QUEUE_NAME, runRecurringJobs } = require("../jobs/cron-runner");
const { handleCronJob } = require("../jobs/cron-handlers");

const emailWorker = new Worker(
  EMAIL_QUEUE_NAME,
  async (job) => {
    const { to, templateCode, payload } = job.data;
    return sendEmail({ to, templateCode, payload });
  },
  {
    connection: __redisConnection,
    concurrency: 5,
  },
);

emailWorker.on("completed", (job, result) => {
  console.log(`[worker:email] job=${job.id} template=${job.data?.templateCode} status=completed result=${JSON.stringify(result)}`);
});

emailWorker.on("failed", (job, err) => {
  console.error(`[worker:email] job=${job?.id} template=${job?.data?.templateCode} status=failed attempts=${job?.attemptsMade} err=${err?.message}`);
});

emailWorker.on("error", (err) => {
  console.error(`[worker:email] worker error: ${err?.message}`);
});

const cronWorker = new Worker(
  CRON_QUEUE_NAME,
  async (job) => {
    return handleCronJob(job.name, job.data);
  },
  {
    connection: __redisConnection,
    concurrency: 1, // cron jobs are not load-sensitive
  },
);

cronWorker.on("completed", (job, result) => {
  console.log(`[worker:cron] job=${job.name} status=completed result=${JSON.stringify(result)}`);
});
cronWorker.on("failed", (job, err) => {
  console.error(`[worker:cron] job=${job?.name} status=failed err=${err?.message}`);
});

console.log(`[worker] started email+cron, email-mode=${env.EMAIL_DELIVERY_MODE}, concurrency=5+1`);

// Schedule recurring jobs (cron) — repeatable entries are upserted into BullMQ on boot.
runRecurringJobs().catch((err) => console.error(`[worker:cron] bootstrap failed: ${err?.message}`));

async function shutdown(signal) {
  console.log(`[worker] received ${signal}, draining...`);
  await Promise.all([emailWorker.close(), cronWorker.close()]);
  process.exit(0);
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
