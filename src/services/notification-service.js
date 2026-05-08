/**
 * Centralised emitter for in-app + email notifications.
 *
 * Pattern:
 *   1. Within a Prisma transaction, write the Notification row (in-app inbox).
 *   2. After the transaction commits, push the matching email job to BullMQ.
 *
 * Why split: if email enqueue happened inside the transaction and threw, the DB
 * write would roll back even though the user-facing action succeeded. Conversely,
 * if the DB write failed but we already enqueued, the user would receive an email
 * about a state that doesn't exist. Tx → enqueue keeps these consistent.
 */
const { enqueueEmail } = require("../queues/email-queue");

async function recordInAppNotification(tx, { userId, channel = "IN_APP", templateCode, payloadJson }) {
  return tx.notification.create({
    data: {
      userId,
      channel,
      templateCode,
      payloadJson,
      status: "UNREAD",
    },
  });
}

async function emitEmail({ to, templateCode, payload, idempotencyKey }) {
  if (!to) return null;
  return enqueueEmail({ to, templateCode, payload, idempotencyKey });
}

module.exports = { recordInAppNotification, emitEmail };
