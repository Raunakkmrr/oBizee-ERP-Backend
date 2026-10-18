import { beforeAll, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
const local = process.env.ERP_CORE_TEST_PG === "local-005a-disposable";
const bin = "/opt/homebrew/opt/postgresql@16/bin/psql";
const args = ["-X","-q","--csv","-v","ON_ERROR_STOP=1","-v","VERBOSITY=verbose","-h","127.0.0.1","-p","55435","-d","erp_platform_005a_test"];
const a = { tenantId: randomUUID(), id: randomUUID(), name: "Test actor A" };
const b = { tenantId: randomUUID(), id: randomUUID(), name: "Test actor B" };
const branchA = randomUUID(), branchB = randomUUID();
vi.mock("../db/client.ts", async () => {
  const { AsyncLocalStorage } = await import("node:async_hooks");
  const { PgDialect } = await import("drizzle-orm/pg-core");
  const { execFileSync } = await import("node:child_process");
  const tenant = new AsyncLocalStorage<string>();
  function literal(value: unknown) {
    if (value === null) return "NULL";
    if (typeof value === "number") return String(value);
    return "'" + String(value).replaceAll("'","''") + "'";
  }
  return { adminDb: {}, withTenant: <T>(id: string, work: () => T) => tenant.run(id, work),
    db: { execute: async (query: Parameters<InstanceType<typeof PgDialect>["sqlToQuery"]>[0]) => {
      if (process.env.ERP_CORE_TEST_PG !== "local-005a-disposable") throw new Error("Local test disabled");
      if (!tenant.getStore()) throw new Error("Unscoped test query");
      const prepared = new PgDialect().sqlToQuery(query);
      const text = prepared.sql.replace(/\$(\d+)/g, (_, index) => literal(prepared.params[Number(index)-1]));
      let output: string;
      try {
        output = execFileSync("/opt/homebrew/opt/postgresql@16/bin/psql",
          ["-X","-q","--csv","-v","ON_ERROR_STOP=1","-v","VERBOSITY=verbose","-h","127.0.0.1","-p","55435","-d","erp_platform_005a_test"],
          { input: "BEGIN; SET LOCAL ROLE app_runtime; SET LOCAL app.tenant_id = " +
            literal(tenant.getStore()) + "; " + text + "; COMMIT;", encoding: "utf8", stdio:["pipe","pipe","pipe"] });
      } catch(error) {
        const failure = error as Error & { stderr?: Buffer | string; code?: string };
        failure.code = String(failure.stderr).match(/ERROR:\s+(\d{5}):/)?.[1] ?? "UNKNOWN";
        throw failure;
      }
      const lines = output.trim().split("\n").filter(Boolean);
      if (!lines.length) return { rows: [] };
      const cells = (line: string) => (line.match(/("(?:[^"]|"")*"|[^,]*)(,|$)/g) ?? [])
        .filter(Boolean).map(value => value.replace(/,$/,"").replace(/^"(.*)"$/,'$1').replaceAll('""','"'));
      const headers = cells(lines[0]!);
      return { rows: lines.slice(1).map(line => Object.fromEntries(cells(line).map((value, index) =>
        [headers[index], headers[index] === "allowed" ? value === "t" :
          ["customers","openJobs"].includes(headers[index]!) ? Number(value) : value || null]))) };
    } } };
});
import { createCustomer, readCustomers, readWorkspace } from "./workspace.ts";
import { accountAllowed } from "./store.ts";
function owner(input: string) { return execFileSync(bin,args,{input,encoding:"utf8",stdio:["pipe","pipe","pipe"]}); }
beforeAll(() => {
  if (!local) return;
  const marker = owner("SELECT current_database()").trim();
  if (!marker.endsWith("erp_platform_005a_test")) throw new Error("Not disposable DB");
  owner(`
    INSERT INTO tenants(id,business_name,legal_name) VALUES
      ('${a.tenantId}','Unit company A','Unit company A'),('${b.tenantId}','Unit company B','Unit company B') ON CONFLICT DO NOTHING;
    INSERT INTO branches(id,tenant_id,name,state_code) VALUES
      ('${branchA}','${a.tenantId}','Branch A','27'),('${branchB}','${b.tenantId}','Branch B','27') ON CONFLICT DO NOTHING;
    INSERT INTO users(id,tenant_id,name,email,role,active) VALUES
      ('${a.id}','${a.tenantId}','Test actor A','a@disposable.invalid','technician',true),
      ('${b.id}','${b.tenantId}','Test actor B','b@disposable.invalid','readonly_ca',true) ON CONFLICT DO NOTHING;
  `);
});
const input = { id: randomUUID(), branchId: branchA,
  name: "Test customer A", customerType: "BUSINESS" as const, billingStateCode: "27",
  addressLine1: "Unit test address", locality: "Unit locality", city: "Unit city", pincode: "400001" };
describe.skipIf(!local)("real PostgreSQL baseline/RLS contract (disposable unit test only)", () => {
  it("fails closed on absent/closed/expired tenant state and accepts only current active or live trial state", async () => {
    expect(await accountAllowed(a.tenantId)).toBe(false);
    owner(`INSERT INTO platform_plans(code,name,modules,allowances,monthly_price_paise,trial_days,active)
      VALUES('CORE_TEST','Disposable test','[]','{}',0,14,true) ON CONFLICT DO NOTHING;
      INSERT INTO tenant_lifecycle(tenant_id,status,changed_by) VALUES('${a.tenantId}','ACTIVE','unit-test');
      INSERT INTO tenant_subscriptions(tenant_id,plan_code,status,trial_ends_at)
      VALUES('${a.tenantId}','CORE_TEST','TRIAL',now()+interval '1 day');`);
    expect(await accountAllowed(a.tenantId)).toBe(true);
    owner("UPDATE tenant_subscriptions SET trial_ends_at=now()-interval '1 day' WHERE tenant_id='" + a.tenantId + "'");
    expect(await accountAllowed(a.tenantId)).toBe(false);
    owner("UPDATE tenant_subscriptions SET status='ACTIVE' WHERE tenant_id='" + a.tenantId + "'");
    expect(await accountAllowed(a.tenantId)).toBe(true);
    owner("UPDATE tenant_lifecycle SET status='CLOSED' WHERE tenant_id='" + a.tenantId + "'");
    expect(await accountAllowed(a.tenantId)).toBe(false);
  });
  it("runs the actual 0073 atomic customer function, primary site and original actor audit", async () => {
    const created = await createCustomer(a,input);
    expect(created?.created).toBe(true);
    expect(await createCustomer(a,input)).toEqual({ id: created!.id, created: false });
    expect(owner("SELECT count(*) FROM customers WHERE tenant_id='" + a.tenantId + "'").trim()).toBe("count\n1");
    expect(owner("SELECT count(*) FROM sites WHERE tenant_id='" + a.tenantId + "'").trim()).toBe("count\n1");
    expect(owner("SELECT count(*) FROM audit_entries WHERE actor_user_id='" + a.id + "'").trim()).toBe("count\n2");
  });
  it("rejects foreign-tenant branch injection, address duplicate and changed idempotent payload without orphans", async () => {
    expect(await createCustomer(a,{ ...input, id: randomUUID(), branchId: branchB })).toBeNull();
    expect(await createCustomer(a,{ ...input, id: randomUUID() })).toBeNull();
    expect(await createCustomer(a,{ ...input, name:"Changed name", addressLine1:"Different address" })).toBeNull();
    expect(owner("SELECT count(*) FROM customers WHERE tenant_id='" + a.tenantId + "'").trim()).toBe("count\n1");
  });
  it("isolates directory, company, counts and UUID retries between two real RLS tenant contexts", async () => {
    const other = await createCustomer(b,{ ...input, branchId: branchB, name:"Test customer B", id:randomUUID() });
    expect(other?.created).toBe(true);
    for (const [actor,branch] of [[a,branchA],[b,branchB]] as const) {
      owner("INSERT INTO jobs(tenant_id,branch_id,job_number,customer_id,site_id,service_type) " +
        "SELECT '" + actor.tenantId + "','" + branch + "','UNIT-JOB',c.id,s.id,'Unit service' " +
        "FROM customers c JOIN sites s ON s.customer_id=c.id WHERE c.tenant_id='" + actor.tenantId + "'");
    }
    expect((await readCustomers(a,0)).items.map(row => row.name)).toEqual(["Test customer A"]);
    expect((await readCustomers(b,0)).items.map(row => row.name)).toEqual(["Test customer B"]);
    for (const actor of [a,b]) {
      const data = await readWorkspace(actor);
      expect(data?.company.id).toBe(actor.tenantId); expect(data?.counts.customers).toBe(1);
      expect(data?.branches.map(row => row.id)).toEqual([actor === a ? branchA : branchB]);
      expect(data?.counts.openJobs).toBe(1);
      expect(data?.jobs.map(row => row.customer)).toEqual([actor === a ? "Test customer A" : "Test customer B"]);
    }
  });
  it("database denies absent tenant and foreign tenant INSERT even without handler filters", () => {
    expect(owner("SET ROLE app_runtime; SELECT count(*) FROM customers; RESET ROLE;").trim()).toBe("count\n0");
    expect(() => owner("BEGIN; SET LOCAL ROLE app_runtime; SET LOCAL app.tenant_id='" + a.tenantId +
      "'; INSERT INTO customers(tenant_id,name,customer_type,billing_state_code) VALUES('" +
      b.tenantId + "','Foreign','BUSINESS','27'); COMMIT;")).toThrow();
  });
});
