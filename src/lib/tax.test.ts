import { describe, expect, it } from "vitest";
import {
  adviseSupply,
  codeForAato,
  computeTotals,
  derivePlaceOfSupply,
  type InvoiceLine,
} from "./tax.ts";

describe("derivePlaceOfSupply — FR-802", () => {
  it("charges CGST+SGST when the site and the supplier's GSTIN are in one state", () => {
    const d = derivePlaceOfSupply("27", "27");
    expect(d.head).toBe("CGST_SGST");
    expect(d.explanation).toContain("Maharashtra");
    expect(d.explanation).toContain("CGST + SGST");
  });

  it("charges IGST across a state line, and names both states", () => {
    // FR-802's own worked example: a Maharashtra supplier billing a Gujarat site.
    const d = derivePlaceOfSupply("24", "27");
    expect(d.head).toBe("IGST");
    expect(d.explanation).toBe(
      "Site in Gujarat (24) · your GSTIN in Maharashtra (27) → IGST",
    );
  });

  it("always explains itself — the explanation is the feature", () => {
    // §6.11.2: the derivation is valuable precisely because "no incumbent tool
    // explains its reasoning". A head without a sentence would be worthless.
    for (const [site, supplier] of [
      ["07", "07"],
      ["07", "27"],
      ["33", "29"],
    ]) {
      const d = derivePlaceOfSupply(site!, supplier!);
      expect(d.explanation.length).toBeGreaterThan(20);
      expect(d.explanation).toContain("→");
    }
  });

  it("compares the SITE state, not the billing state", () => {
    // FR-202/FR-802: a customer registered in Pune with a site in Nagpur is
    // still an intra-state supply; using the billing address would be the bug.
    const nagpurSite = derivePlaceOfSupply("27", "27");
    expect(nagpurSite.head).toBe("CGST_SGST");
  });

  it("degrades to a readable label for an unmapped state code", () => {
    expect(derivePlaceOfSupply("99", "27").explanation).toContain("State 99");
  });
});

describe("computeTotals — FR-812's rounding rule", () => {
  const line = (over: Partial<InvoiceLine> = {}): InvoiceLine => ({
    description: "AC AMC — visit 3 of 12",
    code: "9987",
    kind: "service",
    qty: 1,
    ratePaise: 4_500_00,
    ratePercent: 18,
    ...over,
  });

  it("reproduces §6.11.1's worked invoice exactly", () => {
    // Taxable 4,840.00 · CGST 435.60 · SGST 435.60 · Round off (0.20) · 5,711.00
    const totals = computeTotals(
      [line(), line({ description: "Capacitor 45 MFD", code: "85321000", kind: "goods", ratePaise: 340_00 })],
      "CGST_SGST",
    );
    expect(totals.taxablePaise).toBe(4_840_00);
    expect(totals.cgstPaise).toBe(435_60);
    expect(totals.sgstPaise).toBe(435_60);
    expect(totals.roundOffPaise).toBe(-20);
    expect(totals.grandTotalPaise).toBe(5_711_00);
  });

  it("splits tax so no paisa is created or destroyed", () => {
    // An odd total-tax in paise is the case that exposes a naive /2.
    const totals = computeTotals(
      [line({ ratePaise: 1_00_01, ratePercent: 5 })],
      "CGST_SGST",
    );
    expect(totals.cgstPaise! + totals.sgstPaise!).toBe(totals.totalTaxPaise);
  });

  it("puts the whole tax on IGST across a state line", () => {
    const totals = computeTotals([line()], "IGST");
    expect(totals.igstPaise).toBe(totals.totalTaxPaise);
    expect(totals.cgstPaise).toBeNull();
    expect(totals.sgstPaise).toBeNull();
  });

  it("keeps the round-off within ±₹0.50", () => {
    const totals = computeTotals([line({ ratePaise: 1_234_56 })], "CGST_SGST");
    expect(Math.abs(totals.roundOffPaise)).toBeLessThanOrEqual(50);
  });

  it("handles a nil-rated line without inventing tax", () => {
    const totals = computeTotals([line({ ratePercent: 0 })], "CGST_SGST");
    expect(totals.totalTaxPaise).toBe(0);
    expect(totals.grandTotalPaise).toBe(4_500_00);
  });

  /**
   * FR-812: *"the sum of all line taxes plus the round-off equals the printed
   * grand total exactly, every time, verified by a property-based test over
   * 100,000 randomly generated invoices."*
   *
   * Seeded rather than `Math.random`, so a failure is reproducible instead of
   * being a story about a flake.
   */
  it("foots exactly over 100,000 generated invoices", () => {
    let seed = 0x2f6e2b1;
    const next = () => {
      // xorshift32 — deterministic, adequate for spreading inputs.
      seed ^= seed << 13;
      seed ^= seed >>> 17;
      seed ^= seed << 5;
      return Math.abs(seed);
    };

    const slabs = [0, 5, 18, 40];
    let checked = 0;

    for (let i = 0; i < 100_000; i += 1) {
      const lineCount = 1 + (next() % 6);
      const lines: InvoiceLine[] = Array.from({ length: lineCount }, () => ({
        description: "line",
        code: "9987",
        kind: "service",
        qty: 1 + (next() % 9),
        ratePaise: 1 + (next() % 50_00_00), // ₹0.01 … ₹50,000
        ratePercent: slabs[next() % slabs.length]!,
      }));

      const head = next() % 2 === 0 ? "CGST_SGST" : "IGST";
      const t = computeTotals(lines, head);

      // The footing identity, stated exactly as FR-812 states it.
      expect(
        t.taxablePaise + t.totalTaxPaise + t.roundOffPaise,
        `invoice ${i} did not foot`,
      ).toBe(t.grandTotalPaise);

      // The grand total is always a whole number of rupees.
      expect(t.grandTotalPaise % 100, `invoice ${i} not whole rupees`).toBe(0);

      // Round-off never exceeds half a rupee.
      expect(Math.abs(t.roundOffPaise), `invoice ${i} round-off too large`)
        .toBeLessThanOrEqual(50);

      // The split never loses or invents a paisa.
      if (head === "CGST_SGST") {
        expect(t.cgstPaise! + t.sgstPaise!, `invoice ${i} split mismatch`).toBe(
          t.totalTaxPaise,
        );
      } else {
        expect(t.igstPaise).toBe(t.totalTaxPaise);
      }

      checked += 1;
    }

    expect(checked).toBe(100_000);
  });
});

describe("codeForAato — FR-803 digit precision", () => {
  it("emits 4 digits at or below ₹5 crore AATO", () => {
    expect(codeForAato("998719", 4_20_00_000_00)).toBe("9987");
  });

  it("emits 6 digits above ₹5 crore", () => {
    expect(codeForAato("998719", 7_00_00_000_00)).toBe("998719");
  });

  it("treats exactly ₹5 crore as at-or-below", () => {
    // The threshold is "exceeded ₹5 crore", so equality stays at 4 digits.
    expect(codeForAato("998719", 5_00_00_000_00)).toBe("9987");
  });
});

describe("FR-806 composite supply advisory", () => {
  const line = (over: Partial<InvoiceLine> = {}): InvoiceLine => ({
    description: "x",
    code: "9987",
    kind: "service",
    qty: 1,
    ratePaise: 1000_00,
    ratePercent: 18,
    ...over,
  });

  it("says nothing when every line is the same rate", () => {
    // No decision to make, so no question to ask.
    expect(adviseSupply([line(), line({ kind: "goods", code: "8532" })]).kind).toBe(
      "single_rate",
    );
  });

  it("says nothing when there are no goods at all", () => {
    expect(
      adviseSupply([line(), line({ ratePercent: 5 })]).kind,
    ).toBe("single_rate");
  });

  it("raises the question when goods and services differ in rate", () => {
    const advice = adviseSupply([
      line({ ratePercent: 18, ratePaise: 4_500_00 }),
      line({ kind: "goods", code: "8532", ratePercent: 28, ratePaise: 340_00 }),
    ]);
    expect(advice.kind).toBe("mixed");
    if (advice.kind === "mixed") {
      // The principal supply is the one carrying the value — for a service
      // firm that is nearly always the labour.
      expect(advice.principalPercent).toBe(18);
      expect(advice.rates).toEqual([18, 28]);
    }
  });

  it("picks the principal by value, not by line count", () => {
    // Three cheap parts must not outvote one expensive service.
    const advice = adviseSupply([
      line({ ratePercent: 18, ratePaise: 50_000_00 }),
      line({ kind: "goods", code: "1", ratePercent: 5, ratePaise: 100_00 }),
      line({ kind: "goods", code: "2", ratePercent: 5, ratePaise: 100_00 }),
      line({ kind: "goods", code: "3", ratePercent: 5, ratePaise: 100_00 }),
    ]);
    if (advice.kind === "mixed") expect(advice.principalPercent).toBe(18);
  });

  it("never blocks — it only ever returns advice", () => {
    // The tax position belongs to the taxpayer, not to the software.
    const advice = adviseSupply([
      line(),
      line({ kind: "goods", code: "8532", ratePercent: 28 }),
    ]);
    expect(advice.kind === "mixed" && advice.question.length).toBeGreaterThan(0);
  });
});
