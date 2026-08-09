import { and, eq } from "drizzle-orm";
import { db } from "./client.ts";
import {
  assets,
  branches,
  parts,
  stockLocations,
  stockMovements,
  contacts,
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

/**
 * Contacts and assets for the seeded sites.
 *
 * Split out and guarded because `seed()` used to return the moment it found
 * the tenant, so anything added to it afterwards never reached a database
 * that had already been seeded once. The whole-tenant early return made the
 * seed idempotent and un-extendable at the same time; each section now checks
 * for itself.
 */
export async function ensureContactsAndAssets(tenantId: string): Promise<void> {
  const [existing] = await db
    .select({ id: contacts.id })
    .from(contacts)
    .where(eq(contacts.tenantId, tenantId))
    .limit(1);
  if (existing) return;

  const siteRows = await db
    .select({ id: sites.id, label: sites.label })
    .from(sites)
    .where(eq(sites.tenantId, tenantId));
  const site = (label: string) => siteRows.find((s) => s.label === label)!.id;

  /*
    A site with no contact is a site nobody can be called about, and the
    collections list and the job card both read this. One primary per site,
    because "who do I ring" must have exactly one answer.
  */
  const contactRows: (typeof contacts.$inferInsert)[] = [
    { tenantId, siteId: site("Okhla plant"), name: "Ravi Kulkarni", phoneE164: "919811034567", whatsappE164: "919811034567", roleLabel: "SITE_INCHARGE", isPrimary: true },
    { tenantId, siteId: site("Okhla plant"), name: "Anita Rao", phoneE164: "919811034568", whatsappE164: null, roleLabel: "ACCOUNTS", isPrimary: false },
    { tenantId, siteId: site("Nagpur unit"), name: "Sanjay Pawar", phoneE164: "919822011234", whatsappE164: "919822011234", roleLabel: "SITE_INCHARGE", isPrimary: true },
    { tenantId, siteId: site("Tower B"), name: "Col. R. Menon (Retd.)", phoneE164: "919810022334", whatsappE164: "919810022334", roleLabel: "OWNER", isPrimary: true },
    { tenantId, siteId: site("Residence"), name: "Mrs. Deshpande", phoneE164: "919810099887", whatsappE164: null, roleLabel: "OWNER", isPrimary: true },
    { tenantId, siteId: site("Main block"), name: "Dr. S. Deshmukh", phoneE164: "919811077120", whatsappE164: null, roleLabel: "OWNER", isPrimary: true },
    { tenantId, siteId: site("Main block"), name: "Farid Ansari", phoneE164: "919811077121", whatsappE164: "919811077121", roleLabel: "SITE_INCHARGE", isPrimary: false },
  ];
  await db.insert(contacts).values(contactRows);

  /*
    The equipment the visits are actually about. Two cases worth having:
    a unit **under warranty** (the invoice must not charge for the part) and
    one flagged **repeat failure** (the third visit in a year is a different
    conversation from the first).
  */
  const assetRows: (typeof assets.$inferInsert)[] = [
    { tenantId, siteId: site("Okhla plant"), assetType: "Chiller", make: "Voltas", model: "VCS-120", serialNumber: "VC120-88213", locationInSite: "Utility block, roof", condition: "NEEDS_ATTENTION", warrantyExpiry: "2027-02-08", repeatFailure: true },
    { tenantId, siteId: site("Okhla plant"), assetType: "Cold room", make: "Blue Star", model: "CR-40", serialNumber: "BSCR-40-2211", locationInSite: "Despatch bay", condition: "GOOD", warrantyExpiry: null, repeatFailure: false },
    { tenantId, siteId: site("Nagpur unit"), assetType: "Deep freezer", make: "Vestfrost", model: "DF-500", serialNumber: null, locationInSite: "Stores", condition: "CRITICAL", warrantyExpiry: null, repeatFailure: false },
    { tenantId, siteId: site("Tower B"), assetType: "Water purifier", make: "Ion Exchange", model: "RO-2000", serialNumber: "IX-RO-77120", locationInSite: "Basement pump room", condition: "GOOD", warrantyExpiry: "2026-11-30", repeatFailure: false },
    { tenantId, siteId: site("Residence"), assetType: "Refrigerator", make: "LG", model: "GL-T422", serialNumber: "LG422-90112", locationInSite: "Kitchen", condition: "NEEDS_ATTENTION", warrantyExpiry: null, repeatFailure: false },
    { tenantId, siteId: site("Main block"), assetType: "Chiller", make: "Carrier", model: "30XA-252", serialNumber: "CA30-55210", locationInSite: "Plant room, basement", condition: "GOOD", warrantyExpiry: "2028-03-31", repeatFailure: false },
  ];
  await db.insert(assets).values(assetRows);

}

/**
 * A store, two vans, and enough movement to exercise §6.14.
 *
 * Deliberately includes each of the three exceptions, because a stock screen
 * whose exception list is always empty has never been looked at properly:
 *
 * - a **negative balance** on a van, from a part fitted that was never issued;
 * - an **issue with no challan**, which Rule 55 wants a document for;
 * - and `job_parts` carries a name that is in no catalogue, which is the
 *   **uncatalogued** case — a part bought again every month because nothing
 *   knows it exists.
 */
export async function ensureStock(tenantId: string, branchId: string): Promise<void> {
  /*
    Adds what is missing rather than refusing when anything exists.

    The ledger is insert-only — the trigger refuses a DELETE, which is the
    point — so this fixture cannot be torn down and rebuilt. It has to be able
    to extend an existing one instead, or a part added here later can never
    reach a database that has already been seeded once.
  */
  const already = await db
    .select({ name: parts.name })
    .from(parts)
    .where(eq(parts.tenantId, tenantId));
  const have = new Set(already.map((row) => row.name));

  const technicians = await db
    .select({ id: users.id, name: users.name })
    .from(users)
    .where(and(eq(users.tenantId, tenantId), eq(users.role, "technician")));

  const [kirloskar] = await db
    .select({ id: vendors.id })
    .from(vendors)
    .where(eq(vendors.tenantId, tenantId))
    .limit(1);

  const wanted = [
      { tenantId, name: "Capacitor 40uF", code: "85321000", unit: "no", reorderLevel: 10, preferredVendorId: kirloskar?.id ?? null, unitCostPaise: 45_000 },
      { tenantId, name: "Oil filter", code: "84212300", unit: "no", reorderLevel: 6, preferredVendorId: kirloskar?.id ?? null, unitCostPaise: 62_000 },
      { tenantId, name: "Contactor 32A", code: "85364900", unit: "no", reorderLevel: 4, preferredVendorId: kirloskar?.id ?? null, unitCostPaise: 1_35_000 },
      { tenantId, name: "R32 refrigerant", code: "38247800", unit: "kg", reorderLevel: 20, preferredVendorId: kirloskar?.id ?? null, unitCostPaise: 78_000 },
      /*
        The one that is always nearly out.

        Every firm has one, and a reorder list with nothing on it is a screen
        nobody has tested against real stock — the same "passing on zero rows"
        the board fixture exists to prevent.
      */
      { tenantId, name: "Fan motor 1/4 HP", code: "84145930", unit: "no", reorderLevel: 5, preferredVendorId: kirloskar?.id ?? null, unitCostPaise: 4_20_000 },
  ];

  const fresh = wanted.filter((row) => !have.has(row.name));
  if (fresh.length > 0) await db.insert(parts).values(fresh);

  const catalogue = await db
    .select({ id: parts.id, name: parts.name })
    .from(parts)
    .where(eq(parts.tenantId, tenantId));
  const part = (name: string) => catalogue.find((p) => p.name === name)!.id;

  // Only the parts just catalogued get an opening history.
  const isNew = (name: string) => fresh.some((row) => row.name === name);

  const existingPlaces = await db
    .select({ id: stockLocations.id, name: stockLocations.name, kind: stockLocations.kind })
    .from(stockLocations)
    .where(eq(stockLocations.tenantId, tenantId));

  const places = existingPlaces.length > 0 ? existingPlaces : await db
    .insert(stockLocations)
    .values([
      { tenantId, name: "Nehru Place store", kind: "STORE" as const, branchId },
      ...technicians.slice(0, 2).map((t) => ({
        tenantId,
        // §6.14: named by whose it is, because that is who you ring.
        name: `${t.name.split(" ")[0]}'s van`,
        kind: "VAN" as const,
        technicianId: t.id,
        branchId,
      })),
    ])
    .returning({ id: stockLocations.id, name: stockLocations.name, kind: stockLocations.kind });
  const store = places.find((p) => p.kind === "STORE")!.id;
  const vans = places.filter((p) => p.kind === "VAN");

  const moves: (typeof stockMovements.$inferInsert)[] = [
    // Bought in.
    { tenantId, partId: part("Capacitor 40uF"), kind: "RECEIPT", toLocationId: store, qty: 40 },
    { tenantId, partId: part("Oil filter"), kind: "RECEIPT", toLocationId: store, qty: 24 },
    { tenantId, partId: part("Contactor 32A"), kind: "RECEIPT", toLocationId: store, qty: 12 },
    { tenantId, partId: part("R32 refrigerant"), kind: "RECEIPT", toLocationId: store, qty: 60 },
    // Loaded out, with a challan.
    { tenantId, partId: part("Capacitor 40uF"), kind: "ISSUE_TO_VAN", fromLocationId: store, toLocationId: vans[0]!.id, qty: 8, challanNumber: "DC/26-27/0011" },
    { tenantId, partId: part("Oil filter"), kind: "ISSUE_TO_VAN", fromLocationId: store, toLocationId: vans[0]!.id, qty: 6, challanNumber: "DC/26-27/0012" },
    // And once without — Rule 55's exception, on the screen rather than refused.
    { tenantId, partId: part("R32 refrigerant"), kind: "ISSUE_TO_VAN", fromLocationId: store, toLocationId: vans[1]?.id ?? vans[0]!.id, qty: 15 },
    // Fitted on jobs.
    { tenantId, partId: part("Capacitor 40uF"), kind: "CONSUME", fromLocationId: vans[0]!.id, qty: 5 },
    { tenantId, partId: part("Oil filter"), kind: "CONSUME", fromLocationId: vans[0]!.id, qty: 4 },
    { tenantId, partId: part("R32 refrigerant"), kind: "CONSUME", fromLocationId: vans[1]?.id ?? vans[0]!.id, qty: 12 },
    // Left over, brought back.
    { tenantId, partId: part("Capacitor 40uF"), kind: "RETURN_TO_STORE", fromLocationId: vans[0]!.id, toLocationId: store, qty: 2 },
    /*
      A contactor fitted from a van it was never issued to. The van goes to −2,
      which is the negative-balance exception: either the issue was never
      recorded, or the part came from somewhere nobody wrote down.
    */
    { tenantId, partId: part("Contactor 32A"), kind: "CONSUME", fromLocationId: vans[0]!.id, qty: 2 },
    // Bought six, fitted four: two left against a level of five.
    { tenantId, partId: part("Fan motor 1/4 HP"), kind: "RECEIPT", toLocationId: store, qty: 6 },
    { tenantId, partId: part("Fan motor 1/4 HP"), kind: "CONSUME", fromLocationId: store, qty: 4 },
  ];
  // Movements only for parts this run introduced; history is never rewritten.
  const additions = moves.filter((move) =>
    catalogue.some((p) => p.id === move.partId && isNew(p.name)),
  );
  if (additions.length > 0) await db.insert(stockMovements).values(additions);
}

export async function seed(): Promise<string> {
  const [existing] = await db
    .select({ id: tenants.id })
    .from(tenants)
    .where(eq(tenants.legalName, LEGAL_NAME))
    .limit(1);

  if (existing) {
    await ensureContactsAndAssets(existing.id);
    const [branch] = await db
      .select({ id: branches.id })
      .from(branches)
      .where(eq(branches.tenantId, existing.id))
      .limit(1);
    if (branch) await ensureStock(existing.id, branch.id);
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

  await ensureContactsAndAssets(tenantId);

  await db.insert(vendors).values([
    { tenantId, name: "Kirloskar Spares Depot", gstin: "07AAACK1234F1Z9", stateCode: "07", pan: "AAACK1234F", panType: "COMPANY_FIRM_OTHER", msmeClass: "SMALL", udyamNumber: "UDYAM-DL-03-0012345", udyamActivity: "MANUFACTURING", hasWrittenAgreement: true, paymentTermsDays: 30 },
    // Unregistered and an individual: reverse charge, and §194C at 1%.
    { tenantId, name: "Verma Electricals", gstin: null, stateCode: "07", pan: "ABCPV7788K", panType: "INDIVIDUAL_HUF", msmeClass: "MICRO", udyamNumber: "UDYAM-DL-03-0099887", udyamActivity: "SERVICE", hasWrittenAgreement: false, paymentTermsDays: 15 },
    // Trading — no MSMED clock, which is the case people get wrong.
    { tenantId, name: "Metro Refrigeration Traders", gstin: "07AAFCM5566P1ZR", stateCode: "07", pan: "AAFCM5566P", panType: "COMPANY_FIRM_OTHER", msmeClass: "SMALL", udyamNumber: "UDYAM-DL-03-0044556", udyamActivity: "TRADING", hasWrittenAgreement: true, paymentTermsDays: 45 },
  ]);

  await ensureStock(tenantId, branchId);

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
