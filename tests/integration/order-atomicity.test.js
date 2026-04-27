const request = require("supertest");
const app = require("../../src/app");
const { prisma } = require("../../src/config/prisma");

async function registerAndLogin({ email, role, displayName }) {
  await request(app).post("/auth/register").send({
    email,
    password: "Str0ngPass!123",
    displayName,
    role,
  });
  const login = await request(app).post("/auth/login").send({
    email,
    password: "Str0ngPass!123",
  });
  return login.body;
}

describe("Order transaction integration", () => {
  beforeAll(async () => {
    await prisma.disputeEvidence.deleteMany();
    await prisma.dispute.deleteMany();
    await prisma.inspection.deleteMany();
    await prisma.payout.deleteMany();
    await prisma.escrowTransaction.deleteMany();
    await prisma.order.deleteMany();
    await prisma.listing.deleteMany();
    await prisma.auditLog.deleteMany();
    await prisma.refreshToken.deleteMany();
    await prisma.user.deleteMany();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("prevents second purchase after first reservation", async () => {
    const seller = await registerAndLogin({
      email: "seller2@test.kz",
      role: "SELLER",
      displayName: "Seller Two",
    });
    const buyerA = await registerAndLogin({
      email: "buyera@test.kz",
      role: "BUYER",
      displayName: "Buyer A",
    });
    const buyerB = await registerAndLogin({
      email: "buyerb@test.kz",
      role: "BUYER",
      displayName: "Buyer B",
    });

    const listingRes = await request(app)
      .post("/listings")
      .set("Authorization", `Bearer ${seller.accessToken}`)
      .send({
        title: "Maine Coon kitten",
        description: "Healthy kitten with documents and vaccines.",
        breed: "Maine Coon",
        gender: "FEMALE",
        birthDate: "2025-11-01",
        vaccinationStatus: "Complete",
        priceKzt: 300000,
        city: "Almaty",
      });
    expect(listingRes.status).toBe(201);

    await prisma.listing.update({
      where: { id: listingRes.body.id },
      data: { status: "PUBLISHED" },
    });

    const firstOrder = await request(app)
      .post("/orders")
      .set("Authorization", `Bearer ${buyerA.accessToken}`)
      .send({ listingId: listingRes.body.id });
    expect(firstOrder.status).toBe(201);

    const secondOrder = await request(app)
      .post("/orders")
      .set("Authorization", `Bearer ${buyerB.accessToken}`)
      .send({ listingId: listingRes.body.id });
    expect(secondOrder.status).toBe(409);

    const txCount = await prisma.escrowTransaction.count({
      where: { orderId: firstOrder.body.id, txType: "ESCROW_HOLD" },
    });
    expect(txCount).toBe(1);
  });
});
