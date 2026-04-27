const request = require("supertest");
const app = require("../../src/app");
const { prisma } = require("../../src/config/prisma");

describe("Auth and RBAC integration", () => {
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

  it("rejects protected route without token and enforces admin role", async () => {
    const noToken = await request(app).get("/users/me");
    expect(noToken.status).toBe(401);

    const registerSeller = await request(app).post("/auth/register").send({
      email: "seller1@test.kz",
      password: "SellerPass!123",
      displayName: "Seller One",
      role: "SELLER",
    });
    expect(registerSeller.status).toBe(201);

    const registerBuyer = await request(app).post("/auth/register").send({
      email: "buyer1@test.kz",
      password: "BuyerPass!123",
      displayName: "Buyer One",
      role: "BUYER",
    });
    expect(registerBuyer.status).toBe(201);

    const buyerLogin = await request(app).post("/auth/login").send({
      email: "buyer1@test.kz",
      password: "BuyerPass!123",
    });
    expect(buyerLogin.status).toBe(200);

    const sellerId = registerSeller.body.user.id;
    const forbidden = await request(app)
      .patch(`/admin/users/${sellerId}/role`)
      .set("Authorization", `Bearer ${buyerLogin.body.accessToken}`)
      .send({ role: "MODERATOR", reason: "test" });
    expect(forbidden.status).toBe(403);
  });
});
