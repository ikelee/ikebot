import { describe, expect, it } from "vitest";
import { cleanOcrText, extractDeterministicSpendingsFromOcr } from "./intake-workflow.js";

describe("finance intake deterministic parser", () => {
  it("cleans OCR UI noise while preserving transaction lines", () => {
    const cleaned = cleanOcrText(
      [
        "Transactions",
        "Pay It",
        "Feb 22, 2026",
        "OSAKA MARKETPLACE $85.26 >",
        "Home Membership Offers Account",
      ].join("\n"),
    );
    expect(cleaned).toContain("Feb 22, 2026");
    expect(cleaned).toContain("OSAKA MARKETPLACE $85.26 >");
    expect(cleaned).not.toContain("Pay It");
    expect(cleaned).not.toContain("Home Membership Offers Account");
  });

  it("extracts deterministic spendings from common OCR card-list patterns", () => {
    const text = [
      "American Express Gold Card",
      "February 23",
      "Continental Club $93.81 >",
      "Dining « Eek L...9381",
      "KLIKA BOCAS DEL TORO $23.01 >",
      "Lodging « Hosuk L...1358",
      "Feb 22, 2026",
      "OSAKA MARKETPLACE $85.26",
    ].join("\n");
    const rows = extractDeterministicSpendingsFromOcr({
      ocrText: text,
      sourceRef: "sample.png",
    });
    expect(rows.length).toBeGreaterThanOrEqual(3);
    expect(rows.some((r) => r.merchant?.includes("Continental Club") && r.amount === 93.81)).toBe(
      true,
    );
    expect(rows.some((r) => r.merchant?.includes("OSAKA MARKETPLACE") && r.amount === 85.26)).toBe(
      true,
    );
    expect(rows.some((r) => r.ownership === "not_mine" && r.spender === "Hosuk Lee")).toBe(true);
    expect(rows.every((r) => r.sourceRef === "sample.png")).toBe(true);
    expect(rows.every((r) => r.source === "amex")).toBe(true);
  });

  it("does not leak non-owner hints to subsequent transactions", () => {
    const text = [
      "February 23",
      "LA NETA CARIBE $20.00 >",
      "Dining « Hosuk L...1358",
      "Amazon $26.82 >",
      "Merchandise « Eek L...9381",
    ].join("\n");
    const rows = extractDeterministicSpendingsFromOcr({
      ocrText: text,
      sourceRef: "sample.png",
    });
    const laNeta = rows.find((r) => r.merchant?.includes("LA NETA CARIBE"));
    const amazon = rows.find((r) => r.merchant?.toLowerCase().includes("amazon"));
    expect(laNeta?.ownership).toBe("not_mine");
    expect(amazon?.ownership).toBe("mine");
  });

  it("ignores negative payment transactions while keeping positive spend", () => {
    const text = [
      "Feb 24, 2026",
      "AUTOPAY PAYMENT -$500.00",
      "Payment Thank You -$45.12",
      "OSAKA MARKETPLACE $85.26",
    ].join("\n");
    const rows = extractDeterministicSpendingsFromOcr({
      ocrText: text,
      sourceRef: "sample.png",
    });
    expect(rows.some((r) => (r.description ?? "").includes("-$500.00"))).toBe(false);
    expect(rows.some((r) => (r.description ?? "").includes("-$45.12"))).toBe(false);
    expect(rows.some((r) => r.merchant?.includes("OSAKA MARKETPLACE") && r.amount === 85.26)).toBe(
      true,
    );
  });

  it("normalizes month/day dates to current year", () => {
    const text = ["American Express", "February 23", "Continental Club $93.81 >"].join("\n");
    const rows = extractDeterministicSpendingsFromOcr({
      ocrText: text,
      sourceRef: "sample.png",
    });
    const year = new Date().getFullYear();
    expect(rows[0]?.date).toBe(`${year}-02-23`);
  });

  it("defaults ownership to mine when OCR has no clear owner hint", () => {
    const text = ["Chase Total Checking", "Feb 23, 2026", "Amazon $26.82 >"].join("\n");
    const rows = extractDeterministicSpendingsFromOcr({
      ocrText: text,
      sourceRef: "sample.png",
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.ownership).toBe("mine");
  });
});
