const { prisma } = require("../config/prisma");
const { enqueueEmail } = require("../queues/email-queue");

const REMINDER_WINDOW_HOURS = 24;

/**
 * Buyers in INSPECTION_ACTIVE whose 72h window expires within the next 24h.
 * Idempotency: jobId per (orderId, hour-of-day) — one buyer gets at most one
 * reminder per hour even if the cron fires twice.
 */
async function inspectionDeadlineReminder() {
  const now = new Date();
  const horizon = new Date(now.getTime() + REMINDER_WINDOW_HOURS * 60 * 60 * 1000);

  const orders = await prisma.order.findMany({
    where: {
      status: "INSPECTION_ACTIVE",
      inspectionDeadline: { gte: now, lte: horizon },
    },
    select: {
      id: true,
      payout2Kzt: true,
      buyer: { select: { email: true, displayName: true } },
      listing: { select: { title: true } },
    },
  });

  const hourBucket = `${now.getUTCFullYear()}-${now.getUTCMonth() + 1}-${now.getUTCDate()}-${now.getUTCHours()}`;

  let enqueued = 0;
  for (const order of orders) {
    if (!order.buyer?.email) continue;
    await enqueueEmail({
      to: order.buyer.email,
      templateCode: "order.handover.seller", // reuse: same shape; subject already covers situation
      payload: {
        orderId: order.id,
        payout1Kzt: 0,
        displayName: order.buyer.displayName || "buyer",
      },
      idempotencyKey: `reminder:inspect:${order.id}:${hourBucket}`,
    });
    enqueued += 1;
  }

  return { ordersChecked: orders.length, emailsEnqueued: enqueued, hourBucket };
}

/**
 * Wipe expired email-verification tokens older than 24h after expiry, so the unique
 * index doesn't accumulate dead rows that block re-issuance.
 */
async function staleVerificationCleanup() {
  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const result = await prisma.user.updateMany({
    where: {
      emailVerifiedAt: null,
      emailVerificationExpiresAt: { lt: cutoff },
    },
    data: {
      emailVerificationTokenHash: null,
      emailVerificationExpiresAt: null,
    },
  });
  return { wiped: result.count };
}

const HANDLERS = {
  "inspection-deadline-reminder": inspectionDeadlineReminder,
  "stale-verification-cleanup": staleVerificationCleanup,
};

async function handleCronJob(name, _data) {
  const fn = HANDLERS[name];
  if (!fn) throw new Error(`No handler for cron job: ${name}`);
  return fn();
}

module.exports = { handleCronJob, HANDLERS };
