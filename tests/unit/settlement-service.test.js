const { calculateSettlement } = require("../../src/services/settlement-service");

describe("calculateSettlement", () => {
  it("splits seller net into two milestones", () => {
    const result = calculateSettlement(250000, 5);
    expect(result).toEqual({
      totalAmountKzt: 250000,
      platformFeeKzt: 12500,
      payout1Kzt: 118750,
      payout2Kzt: 118750,
    });
  });
});
