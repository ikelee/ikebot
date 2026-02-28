import { describe, expect, it } from "vitest";
import { classifyImportance } from "./shared.ts";

describe("mail importance classifier", () => {
  it("treats obvious promo signals as not important regardless of FW marker", () => {
    const result = classifyImportance({
      subject: "FW: This week's best deals",
      from: "news@marketing.example.com",
      bodyText:
        "From: Promo Sender Sent: Monday To: me@example.com Subject: Sale now on. Unsubscribe here.",
      hasAttachment: false,
      headers: {
        references: "<a@b>",
      },
    });
    expect(result.importance).toBe("not_important");
    expect(result.reasons).toContain("promo_combined_signals");
  });

  it("keeps forwarded financial messages important", () => {
    const result = classifyImportance({
      subject: "FW: Payment confirmation",
      from: "alerts@bank.example.com",
      bodyText: "Your payment receipt and amount are attached.",
      hasAttachment: false,
      headers: {},
    });
    expect(result.importance).toBe("important");
  });

  it("detects encoded FW subjects and still uses non-forward promo rules", () => {
    const result = classifyImportance({
      subject: "=?utf-8?B?Rlc6IFRoZSB3ZWVrJ3MgYmVzdCBkZWFscw==?=",
      from: "ike_0102@hotmail.com",
      bodyText: "Forwarded message. Unsubscribe for more offers.",
      hasAttachment: false,
      headers: {
        references: "<a@b>",
      },
    });
    expect(result.importance).toBe("not_important");
  });

  it("treats forwarded sender identity as neutral", () => {
    const result = classifyImportance({
      subject: "FW: quick note",
      from: "alerts@bank.example.com",
      bodyText: "Forwarded message from someone. FYI only.",
      hasAttachment: false,
      headers: {},
    });
    expect(result.reasons.some((reason) => reason.startsWith("from:"))).toBe(false);
  });

  it("flags obvious phishing mismatch as not important", () => {
    const result = classifyImportance({
      subject: "Chase security alert - verify your account now",
      from: "alerts@totally-not-chase-security.co",
      bodyText:
        "Urgent action required. Your account is suspended. Click this link to verify your password immediately.",
      hasAttachment: false,
      headers: {},
    });
    expect(result.importance).toBe("not_important");
    expect(result.reasons).toContain("phishing_signal");
  });
});
