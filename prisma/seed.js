const argon2 = require("argon2");
const env = require("../src/config/env");
const { prisma, closePrisma } = require("../src/config/prisma");

async function seedAdmin() {
  const passwordHash = await argon2.hash(env.ADMIN_PASSWORD);
  const admin = await prisma.user.upsert({
    where: { email: env.ADMIN_EMAIL },
    update: {
      passwordHash,
      role: "ADMIN",
      status: "ACTIVE",
      displayName: env.ADMIN_DISPLAY_NAME,
    },
    create: {
      email: env.ADMIN_EMAIL,
      passwordHash,
      role: "ADMIN",
      status: "ACTIVE",
      displayName: env.ADMIN_DISPLAY_NAME,
    },
    select: { id: true, email: true, role: true, displayName: true, status: true },
  });
  console.log("Admin seeded:", admin);
}

seedAdmin()
  .catch((err) => {
    console.error("Admin seed failed:", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closePrisma();
  });
