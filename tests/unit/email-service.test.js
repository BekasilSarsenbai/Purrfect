const { renderTemplate, TEMPLATES } = require("../../src/services/email-service");

describe("email-service.renderTemplate", () => {
  it("registers all required transactional templates", () => {
    const required = [
      "auth.verify",
      "auth.password-reset",
      "order.created.seller",
      "order.handover.seller",
      "order.completed.seller",
      "dispute.opened.seller",
    ];
    for (const code of required) {
      expect(TEMPLATES[code]).toBeDefined();
    }
  });

  it("renders verification email with subject and link", () => {
    const out = renderTemplate("auth.verify", {
      verificationUrl: "https://app.example/auth/verify-email?token=abc",
      displayName: "Sarsen",
    });
    expect(out.subject).toMatch(/Verify your email/);
    expect(out.html).toContain("https://app.example/auth/verify-email?token=abc");
    expect(out.html).toContain("Sarsen");
  });

  it("escapes HTML in user-controlled fields", () => {
    const out = renderTemplate("order.created.seller", {
      orderId: "1",
      listingTitle: "<script>alert(1)</script>",
      totalKzt: 100,
      displayName: "<b>Bob</b>",
    });
    expect(out.html).not.toContain("<script>alert(1)</script>");
    expect(out.html).toContain("&lt;script&gt;");
    expect(out.html).not.toMatch(/<b>Bob<\/b>/);
  });

  it("formats KZT amounts with thousands separator and currency", () => {
    const out = renderTemplate("order.handover.seller", {
      orderId: "1",
      payout1Kzt: 118750,
      displayName: "Seller",
    });
    expect(out.subject).toContain("118,750");
    expect(out.subject).toContain("KZT");
  });

  it("throws on unknown template code", () => {
    expect(() => renderTemplate("does.not.exist", {})).toThrow(/Unknown email template/);
  });
});
