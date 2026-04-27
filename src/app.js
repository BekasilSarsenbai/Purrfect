const cors = require("cors");
const express = require("express");
const helmet = require("helmet");
const morgan = require("morgan");
const swaggerUi = require("swagger-ui-express");
const YAML = require("yamljs");
const env = require("./config/env");
const authRoutes = require("./routes/auth.routes");
const usersRoutes = require("./routes/users.routes");
const listingsRoutes = require("./routes/listings.routes");
const ordersRoutes = require("./routes/orders.routes");
const inspectionsRoutes = require("./routes/inspections.routes");
const disputesRoutes = require("./routes/disputes.routes");
const moderationRoutes = require("./routes/moderation.routes");
const adminRoutes = require("./routes/admin.routes");
const { errorHandler, notFoundHandler } = require("./middleware/error-handler");

const app = express();
const allowedOrigins = env.CORS_ORIGINS.split(",").map((origin) => origin.trim());
const openapiDocument = YAML.load(`${process.cwd()}/openapi.yaml`);

app.use(helmet());
app.use(morgan("dev"));
app.use(express.json());
app.use(
  cors({
    origin(origin, callback) {
      if (!origin) return callback(null, true);
      if (allowedOrigins.includes(origin)) return callback(null, true);
      return callback(new Error("CORS origin is not allowed"), false);
    },
    credentials: true,
  }),
);

app.get("/health", (req, res) => {
  return res.status(200).json({ status: "ok" });
});

app.use("/docs", swaggerUi.serve, swaggerUi.setup(openapiDocument));
app.use("/auth", authRoutes);
app.use("/users", usersRoutes);
app.use("/listings", listingsRoutes);
app.use("/orders", ordersRoutes);
app.use("/orders", inspectionsRoutes);
app.use("/disputes", disputesRoutes);
app.use("/moderation", moderationRoutes);
app.use("/admin", adminRoutes);
app.use(notFoundHandler);
app.use(errorHandler);

module.exports = app;
