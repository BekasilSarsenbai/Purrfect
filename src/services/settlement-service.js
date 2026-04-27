function calculateSettlement(totalAmount, platformFeePercent) {
  const numericTotal = Number(totalAmount);
  const platformFee = Number(((numericTotal * platformFeePercent) / 100).toFixed(2));
  const sellerNet = numericTotal - platformFee;
  const payout1 = Number((sellerNet / 2).toFixed(2));
  const payout2 = Number((sellerNet - payout1).toFixed(2));

  return {
    totalAmountKzt: numericTotal,
    platformFeeKzt: platformFee,
    payout1Kzt: payout1,
    payout2Kzt: payout2,
  };
}

module.exports = { calculateSettlement };
