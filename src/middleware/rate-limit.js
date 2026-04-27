const rateLimit = require("express-rate-limit");

const authRateLimit = rateLimit({
  windowMs: 60 * 1000,
  limit: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    code: "TOO_MANY_REQUESTS",
    message: "Too many auth attempts. Try again in 1 minute.",
  },
});

module.exports = { authRateLimit };
