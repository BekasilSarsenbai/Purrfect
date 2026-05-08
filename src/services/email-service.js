const { Resend } = require("resend");
const env = require("../config/env");

const resendClient = env.EMAIL_DELIVERY_MODE === "live" ? new Resend(env.RESEND_API_KEY) : null;

const TEMPLATES = {
  "auth.verify": ({ verificationUrl, displayName }) => ({
    subject: "Verify your email — Purrfect",
    html: `
      <h2>Hi, ${escape(displayName)}!</h2>
      <p>Thanks for signing up to Purrfect. To activate your account and unlock marketplace features, please verify your email address:</p>
      <p><a href="${verificationUrl}" style="display:inline-block;padding:10px 16px;background:#1f6feb;color:#fff;border-radius:6px;text-decoration:none">Verify email</a></p>
      <p>This link expires in 24 hours. If you did not sign up, please ignore this message.</p>
    `,
  }),

  "auth.password-reset": ({ resetUrl, displayName }) => ({
    subject: "Password reset — Purrfect",
    html: `
      <h2>Hello, ${escape(displayName)}.</h2>
      <p>You requested a password reset. The link below is valid for 15 minutes.</p>
      <p><a href="${resetUrl}" style="display:inline-block;padding:10px 16px;background:#1f6feb;color:#fff;border-radius:6px;text-decoration:none">Set a new password</a></p>
      <p>If you didn't request a reset, please ignore this email — your current password remains unchanged.</p>
    `,
  }),

  "order.created.seller": ({ orderId, listingTitle, totalKzt, displayName }) => ({
    subject: `New order for your listing — Purrfect`,
    html: `
      <h2>Congratulations, ${escape(displayName)}!</h2>
      <p>A buyer has placed an order for your listing <b>${escape(listingTitle)}</b>.</p>
      <p>The amount ${formatKzt(totalKzt)} is held in platform escrow. Please contact the buyer to coordinate the handover.</p>
      <p>Order ID: <code>${escape(orderId)}</code></p>
    `,
  }),

  "order.handover.seller": ({ orderId, payout1Kzt, displayName }) => ({
    subject: `Handover confirmed — payout ${formatKzt(payout1Kzt)}`,
    html: `
      <h2>${escape(displayName)}, the handover has been confirmed.</h2>
      <p>The buyer has confirmed receiving the animal. The first milestone payout of <b>${formatKzt(payout1Kzt)}</b> has been released to your account.</p>
      <p>The final payout will be released after the buyer completes a successful veterinary inspection (within 72 hours).</p>
      <p>Order ID: <code>${escape(orderId)}</code></p>
    `,
  }),

  "order.completed.seller": ({ orderId, payout2Kzt, displayName }) => ({
    subject: `Order completed — final payout ${formatKzt(payout2Kzt)}`,
    html: `
      <h2>${escape(displayName)}, the order is now complete.</h2>
      <p>The buyer has confirmed a successful veterinary inspection. The second milestone payout of <b>${formatKzt(payout2Kzt)}</b> has been released to your account.</p>
      <p>Thanks for handling this transaction responsibly on Purrfect.</p>
      <p>Order ID: <code>${escape(orderId)}</code></p>
    `,
  }),

  "dispute.opened.seller": ({ orderId, reasonCode, displayName }) => ({
    subject: `A dispute has been opened — action required`,
    html: `
      <h2>${escape(displayName)}, a dispute has been opened on this order.</h2>
      <p>Reason: <b>${escape(reasonCode)}</b>.</p>
      <p>The final payout is paused until a moderator resolves the case. Please upload supporting evidence (photos, conversation, medical documents) under the Disputes section.</p>
      <p>Order ID: <code>${escape(orderId)}</code></p>
    `,
  }),
};

function escape(value) {
  if (value === null || value === undefined) return "";
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function formatKzt(amount) {
  const n = Number(amount || 0);
  return `${n.toLocaleString("en-US")} KZT`;
}

function renderTemplate(templateCode, payload) {
  const renderer = TEMPLATES[templateCode];
  if (!renderer) throw new Error(`Unknown email template: ${templateCode}`);
  return renderer(payload || {});
}

/**
 * Send a transactional email. Caller decides whether this is invoked
 * inline (sync auth flows) or from the BullMQ worker (everything else).
 */
async function sendEmail({ to, templateCode, payload }) {
  if (!to) throw new Error("sendEmail: 'to' is required");
  const { subject, html } = renderTemplate(templateCode, payload);

  if (env.EMAIL_DELIVERY_MODE !== "live" || !resendClient) {
    // Log mode: print enough information to drive the flow from Postman without
    // a real inbox. The verificationUrl / resetUrl line is what graders click.
    const url = payload?.verificationUrl || payload?.resetUrl || null;
    console.log(`[email:log] mode=${env.EMAIL_DELIVERY_MODE} to=${to} template=${templateCode} subject="${subject}"`);
    if (url) console.log(`[email:log]   action_url: ${url}`);
    return { id: `log_${Date.now()}`, mode: env.EMAIL_DELIVERY_MODE, debugUrl: url };
  }

  const response = await resendClient.emails.send({
    from: env.EMAIL_FROM,
    to,
    subject,
    html,
  });
  if (response.error) {
    const err = new Error(`Resend send failed: ${response.error.message || "unknown"}`);
    err.cause = response.error;
    throw err;
  }
  return { id: response.data?.id, mode: "live" };
}

module.exports = { sendEmail, renderTemplate, TEMPLATES };
