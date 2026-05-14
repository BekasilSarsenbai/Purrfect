const { enqueueEmail } = require("../queues/email-queue");

async function emitEmail({ to, templateCode, payload, idempotencyKey }) {
  if (!to) return null;
  return enqueueEmail({ to, templateCode, payload, idempotencyKey });
}

module.exports = { emitEmail };
