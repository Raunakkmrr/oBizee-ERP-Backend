import { eq } from "drizzle-orm";
import { db } from "./client.ts";
import {
  branches,
  customers,
  rateRows,
  seriesCounters,
  sites,
  tenants,
  users,
  vendors,
} from "./schema.ts";
import { hashPassword } from "../auth/password.ts";

/**
 * A tenant to develop against — the same firm the web app's fixtures describe.
 *
 * Not random data. Every row here exists to exercise a rule that would
 * otherwise only be exercised in production:
 *
 * - Shakti Industries has sites in **two states**, so the same customer bills
 *   CGST+SGST from one and IGST from the other.
 * - Sunrise Apartments RWA is registered in **Haryana** against a Delhi
 *   branch — a permanently interstate customer.
 * - Mrs Deshpande has **no GSTIN**, which is the common household case.
 * - Verma Electricals is **unregistered and an individual**, so their bills
 *   attract reverse charge *and* §194C at 1% rather than 2%.
 * - Metro Refrigeration is a **trading** Udyam registration, which the MSMED
 *   payment timeline excludes — the case people get wrong.
 * - Counters start mid-year at 440/149/6, so the first document this issues is
 *   0441, not a suspiciously round 0001.
 *
 * Idempotent: re-running finds the tenant by legal name and does nothing.
 */
const LEGAL_NAME = "Shakti Cooling Systems Pvt Ltd";

export async function seed(): Promise<string> {
  const [existing] = await db
    .select({ id: tenants.id })
    .from(tenants)
    .where(eq(tenants.legalName, LEGAL_NAME))
    .limit(1);

  if (existing) {
    console.log(`tenant already seeded: ${existing.id}`);
    return existing.id;
  }

  const [tenant] = await db
    .insert(tenants)
    .values({
      businessName: "Shakti Cooling",
      legalName: LEGAL_NAME,
      // Below ₹5 crore, so HSN codes stay at 4 digits (FR-803).
      aatoPaise: 4_20_00_000_00,
      taxScheme: "REGULAR",
      regionalLanguage: "hi",
      toggles: { technicianSeesPrices: false, coordinatorCanBill: true },
    })
    .returning();
  const tenantId = tenant!.id;

  const [branch] = await db
    .insert(branches)
    .values({
      tenantId,
      name: "Nehru Place",
      gstin: "07AABCS1429B1ZX",
      stateCode: "07",
      jobSeriesPrefix: "J",
      invoiceSeriesPrefix: "SVC",
    })
    .returning();
  const branchId = branch!.id;

  const password = await hashPassword("obizee-dev-2026");
  await db.insert(users).values([
    { tenantId, branchId, name: "Manish Agarwal", email: "manish@shakticooling.test", passwordHash: password, role: "owner" },
    { tenantId, branchId, name: "Priya Sharma", email: "priya@shakticooling.test", passwordHash: password, role: "coordinator" },
    { tenantId, branchId, name: "Suresh Gupta", email: "suresh@shakticooling.test", passwordHash: password, role: "accountant" },
    { tenantId, branchId, name: "M. K. Rao & Associates", email: "ca@mkrao.test", passwordHash: password, role: "readonly_ca" },
    // Field staff sign in by phone. No password at all — the column is null.
    { tenantId, branchId, name: "Ramesh Yadav", phoneE164: "919820012345", role: "technician", level: "senior", skills: ["AC", "Refrigeration"], localities: ["Okhla Phase II", "Saket"] },
    { tenantId, branchId, name: "Lakshminarayanan Subramaniam", phoneE164: "919820022345", role: "technician", level: "standard", skills: ["AC"], localities: ["Vasant Kunj"] },
    { tenantId, branchId, name: "Imran Qureshi", phoneE164: "919820033345", role: "technician", level: "apprentice", skills: [], localities: [] },
    { tenantId, branchId, name: "Nisha Bhatt", phoneE164: "919820044345", role: "marketing", level: "senior" },
  ]);

  const inserted = await db
    .insert(customers)
    .values([
      { tenantId, name: "Shakti Industries", customerType: "BUSINESS", gstin: "27AABCS1234M1Z5", billingStateCode: "27", creditDays: 30 },
      { tenantId, name: "Sunrise Apartments RWA", customerType: "BUSINESS", gstin: "06AABCS1234M1Z5", billingStateCode: "06", creditDays: 15 },
      { tenantId, name: "Mrs. Deshpande", customerType: "INDIVIDUAL", gstin: null, billingStateCode: "07", creditDays: 0 },
      { tenantId, name: "Deshmukh Hospital", customerType: "BUSINESS", gstin: "07AACCD5512K1ZP", billingStateCode: "07", creditDays: 45 },
    ])
    .returning({ id: customers.id, name: customers.name });

  const byName = new Map(inserted.map((c) => [c.name, c.id]));

  await db.insert(sites).values([
    // Two states, one customer — the case the tax head turns on.
    { tenantId, customerId: byName.get("Shakti Industries")!, label: "Okhla plant", addressLine1: "Plot 14, MIDC Phase II", locality: "Okhla Phase II", city: "New Delhi", stateCode: "07", pincode: "110020", landmark: "Opposite the transformer yard", accessNotes: "Gate pass at the security cabin." },
    { tenantId, customerId: byName.get("Shakti Industries")!, label: "Nagpur unit", addressLine1: "Survey 88, Butibori MIDC", locality: "Butibori", city: "Nagpur", stateCode: "27", pincode: "441122", landmark: "Behind the water tank", accessNotes: null },
    { tenantId, customerId: byName.get("Sunrise Apartments RWA")!, label: "Tower B", addressLine1: "Tower B, Sector 44", locality: "Sector 44", city: "Gurugram", stateCode: "06", pincode: "122003", landmark: "Behind the community centre", accessNotes: null },
    { tenantId, customerId: byName.get("Mrs. Deshpande")!, label: "Residence", addressLine1: "B-42, Vasant Kunj", locality: "Vasant Kunj", city: "New Delhi", stateCode: "07", pincode: "110070", landmark: "Behind the DDA market, green gate", accessNotes: "Dog on premises. Ring before entering." },
    { tenantId, customerId: byName.get("Deshmukh Hospital")!, label: "Main block", addressLine1: "Press Enclave Marg", locality: "Saket", city: "New Delhi", stateCode: "07", pincode: "110017", landmark: "Opposite Select Citywalk, gate 3", accessNotes: "Generator room via the basement ramp." },
  ]);

  await db.insert(vendors).values([
    { tenantId, name: "Kirloskar Spares Depot", gstin: "07AAACK1234F1Z9", stateCode: "07", pan: "AAACK1234F", panType: "COMPANY_FIRM_OTHER", msmeClass: "SMALL", udyamNumber: "UDYAM-DL-03-0012345", udyamActivity: "MANUFACTURING", hasWrittenAgreement: true, paymentTermsDays: 30 },
    // Unregistered and an individual: reverse charge, and §194C at 1%.
    { tenantId, name: "Verma Electricals", gstin: null, stateCode: "07", pan: "ABCPV7788K", panType: "INDIVIDUAL_HUF", msmeClass: "MICRO", udyamNumber: "UDYAM-DL-03-0099887", udyamActivity: "SERVICE", hasWrittenAgreement: false, paymentTermsDays: 15 },
    // Trading — no MSMED clock, which is the case people get wrong.
    { tenantId, name: "Metro Refrigeration Traders", gstin: "07AAFCM5566P1ZR", stateCode: "07", pan: "AAFCM5566P", panType: "COMPANY_FIRM_OTHER", msmeClass: "SMALL", udyamNumber: "UDYAM-DL-03-0044556", udyamActivity: "TRADING", hasWrittenAgreement: true, paymentTermsDays: 45 },
  ]);

  await db.insert(rateRows).values([
    { tenantId, code: "9987", description: "Maintenance, repair and installation services", ratePercent: 18, effectiveFrom: "2017-07-01", note: "GST introduction — Notification 11/2017-CT(R)" },
    { tenantId, code: "85321000", description: "Fixed capacitors, mains", ratePercent: 28, effectiveFrom: "2017-07-01", note: "The 28% slab, as it stood before the 2025 rationalisation" },
    { tenantId, code: "85321000", description: "Fixed capacitors, mains", ratePercent: 18, effectiveFrom: "2025-09-22", note: "Rate rationalisation — the 28% slab was withdrawn" },
    { tenantId, code: "84212300", description: "Oil and fuel filters for engines", ratePercent: 18, effectiveFrom: "2017-07-01", note: "Parts consumed on generator AMCs" },
  ]);

  // Mid-year, as a live tenant would be.
  await db.insert(seriesCounters).values([
    { tenantId, branchId, docType: "job", financialYear: 2026, lastIssued: 440 },
    { tenantId, branchId, docType: "invoice", financialYear: 2026, lastIssued: 149 },
    { tenantId, branchId, docType: "receipt_voucher", financialYear: 2026, lastIssued: 6 },
  ]);

  console.log(`seeded tenant ${tenantId}`);
  console.log("  office sign-in: manish@shakticooling.test / obizee-dev-2026");
  console.log("  field sign-in:  9820012345 + OTP 123456");
  return tenantId;
}

if (import.meta.filename === process.argv[1]) {
  await seed();
}
