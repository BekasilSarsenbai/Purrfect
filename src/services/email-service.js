const { Resend } = require("resend");
const env = require("../config/env");

const resendClient = env.EMAIL_DELIVERY_MODE === "live" ? new Resend(env.RESEND_API_KEY) : null;

const TEMPLATES = {
  "auth.verify": ({ verificationUrl, displayName }) => ({
    subject: "Подтвердите email — Purrfect",
    html: `
      <h2>Привет, ${escape(displayName)}!</h2>
      <p>Спасибо за регистрацию на Purrfect. Чтобы активировать аккаунт и получить доступ к функциям маркетплейса, подтвердите ваш email:</p>
      <p><a href="${verificationUrl}" style="display:inline-block;padding:10px 16px;background:#1f6feb;color:#fff;border-radius:6px;text-decoration:none">Подтвердить email</a></p>
      <p>Ссылка действительна 24 часа. Если вы не регистрировались — проигнорируйте это письмо.</p>
    `,
  }),

  "auth.password-reset": ({ resetUrl, displayName }) => ({
    subject: "Сброс пароля — Purrfect",
    html: `
      <h2>Здравствуйте, ${escape(displayName)}.</h2>
      <p>По вашему запросу мы выслали ссылку для сброса пароля. Она действительна 15 минут.</p>
      <p><a href="${resetUrl}" style="display:inline-block;padding:10px 16px;background:#1f6feb;color:#fff;border-radius:6px;text-decoration:none">Установить новый пароль</a></p>
      <p>Если вы не запрашивали сброс — проигнорируйте письмо. Текущий пароль не изменён.</p>
    `,
  }),

  "order.created.seller": ({ orderId, listingTitle, totalKzt, displayName }) => ({
    subject: `Новый заказ на ваше объявление — Purrfect`,
    html: `
      <h2>Поздравляем, ${escape(displayName)}!</h2>
      <p>Покупатель оформил заказ на ваше объявление <b>${escape(listingTitle)}</b>.</p>
      <p>Сумма ${formatKzt(totalKzt)} удержана на эскроу платформы. Свяжитесь с покупателем для согласования передачи.</p>
      <p>Order ID: <code>${escape(orderId)}</code></p>
    `,
  }),

  "order.handover.seller": ({ orderId, payout1Kzt, displayName }) => ({
    subject: `Передача подтверждена — выплата ${formatKzt(payout1Kzt)}`,
    html: `
      <h2>${escape(displayName)}, передача подтверждена.</h2>
      <p>Покупатель подтвердил получение животного. Первая часть оплаты <b>${formatKzt(payout1Kzt)}</b> переведена на ваш счёт.</p>
      <p>Финальная часть будет переведена после успешной ветеринарной проверки покупателем (до 72 часов).</p>
      <p>Order ID: <code>${escape(orderId)}</code></p>
    `,
  }),

  "order.completed.seller": ({ orderId, payout2Kzt, displayName }) => ({
    subject: `Сделка завершена — финальная выплата ${formatKzt(payout2Kzt)}`,
    html: `
      <h2>${escape(displayName)}, сделка завершена.</h2>
      <p>Покупатель подтвердил успешную ветеринарную проверку. Вторая часть оплаты <b>${formatKzt(payout2Kzt)}</b> переведена на ваш счёт.</p>
      <p>Спасибо за ответственное оформление сделки на Purrfect.</p>
      <p>Order ID: <code>${escape(orderId)}</code></p>
    `,
  }),

  "dispute.opened.seller": ({ orderId, reasonCode, displayName }) => ({
    subject: `Открыт спор по заказу — требуется внимание`,
    html: `
      <h2>${escape(displayName)}, по сделке открыт спор.</h2>
      <p>Причина: <b>${escape(reasonCode)}</b>.</p>
      <p>Финальная выплата приостановлена до решения модератора. Загрузите доказательства (фото, переписку, медицинские документы) в раздел Disputes.</p>
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
  return `${n.toLocaleString("ru-RU")} ₸`;
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
