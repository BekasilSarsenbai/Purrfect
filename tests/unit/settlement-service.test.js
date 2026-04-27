const { calculateSettlement } = require("../../src/services/settlement-service");

describe("calculateSettlement", () => {
  it("splits seller net into two milestones evenly for round amounts", () => {
    const result = calculateSettlement(250000, 5);
    expect(result).toEqual({
      totalAmountKzt: 250000,
      platformFeeKzt: 12500,
      payout1Kzt: 118750,
      payout2Kzt: 118750,
    });
  });

  it("payout1 + payout2 always equals total minus platform fee", () => {
    const cases = [
      [300000, 5],
      [75000, 3],
      [1234567, 7],
      [50000, 10],
    ];
    for (const [total, feePercent] of cases) {
      const r = calculateSettlement(total, feePercent);
      const sellerNet = Number((r.totalAmountKzt - r.platformFeeKzt).toFixed(2));
      expect(Number((r.payout1Kzt + r.payout2Kzt).toFixed(2))).toBeCloseTo(sellerNet, 1);
    }
  });

  it("platform fee is correct percentage of total", () => {
    const r = calculateSettlement(100000, 10);
    expect(r.platformFeeKzt).toBe(10000);
    expect(r.totalAmountKzt).toBe(100000);
  });

  it("handles zero fee percent (seller keeps everything)", () => {
    const r = calculateSettlement(200000, 0);
    expect(r.platformFeeKzt).toBe(0);
    expect(r.payout1Kzt + r.payout2Kzt).toBe(200000);
  });

  it("accepts Decimal-like string/number from Prisma and coerces correctly", () => {
    const r = calculateSettlement("150000.00", 5);
    expect(r.totalAmountKzt).toBe(150000);
    expect(r.platformFeeKzt).toBe(7500);
  });
});
