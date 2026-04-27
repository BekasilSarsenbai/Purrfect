const app = require("./app");
const env = require("./config/env");
const { closePrisma } = require("./config/prisma");

const server = app.listen(env.PORT, () => {
  console.log(`Purrfect API listening on port ${env.PORT}`);
});

async function shutdown(signal) {
  console.log(`Received ${signal}. Graceful shutdown...`);
  server.close(async () => {
    await closePrisma();
    process.exit(0);
  });
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
