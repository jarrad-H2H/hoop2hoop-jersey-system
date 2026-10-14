// Test for the orders/create "safety net" (flagUnallocatedLines): a sale of a require_widget club's
// product that arrives with no allocator data must be recorded as an 'unmatched' pre-order row and
// flagged — and legitimate orders must be left alone. Uses an in-memory fake database; no network.
// Run: npx tsx scripts/test-allocator-safety-net.ts
import { flagUnallocatedLines } from "../api/shopify/orders-create";

let pass = 0, fail = 0;
const ok = (c: boolean, m: string) => { if (c) { pass++; console.log("  ✓ " + m); } else { fail++; console.log("  ✗ FAIL: " + m); } };

const LOGAN = "75c9d5db-3607-4896-9f37-f61f23baf84d";
const GC = "gc-club";
const MALE = "10489007833387";
const MAP = [
  { shopify_product_id: MALE, club_id: LOGAN, product_type: "mens", bundle_jersey_property: "Logan Thunder Rep Base Playing Jersey - MALE" },
  { shopify_product_id: "999", club_id: GC, product_type: "mens", bundle_jersey_property: null },
];
const CLUBS = [
  { id: LOGAN, name: "Logan Thunder Rep", active_preorder_season: "2026/2027", widget_config: { require_widget: true } },
  { id: GC, name: "Gold Coast Rep", active_preorder_season: "2026-2027", widget_config: { require_yob: true } },
];

function fakeDb(opts: { existingUnmatched?: number; clubs?: any[] } = {}) {
  const inserted: any[] = [];
  const events: any[] = [];
  const clubs = opts.clubs ?? CLUBS;
  const db: any = {
    inserted, events,
    from(table: string) {
      const q: any = {
        _table: table, _filters: {} as Record<string, any>, _count: false,
        select(_cols: string, o?: any) { q._count = !!o?.count; return q; },
        in(col: string, vals: any[]) {
          const src = table === "shopify_product_club_map" ? MAP : clubs;
          const key = table === "shopify_product_club_map" ? "shopify_product_id" : "id";
          q._result = { data: src.filter((r: any) => vals.includes(r[key])), error: null };
          return q;
        },
        eq(col: string, v: any) { q._filters[col] = v; return q; },
        insert(rows: any) {
          if (table === "webhook_events") { events.push(rows); return Promise.resolve({ error: null }); }
          inserted.push(...(Array.isArray(rows) ? rows : [rows]));
          return Promise.resolve({ error: null });
        },
        then(res: any, rej: any) {
          const out = q._count ? { count: opts.existingUnmatched ?? 0, error: null } : q._result;
          return Promise.resolve(out).then(res, rej);
        },
      };
      return q;
    },
  };
  return db;
}

const jamesLine = (id: number, shorts: string) => ({
  id, product_id: MALE, quantity: 1,
  properties: [
    { name: "Logan Thunder Rep Base Playing Jersey - MALE", value: "YXS" },
    { name: "Logan Thunder Base Rep Shorts - MALE", value: shorts },
    { name: "_bundle_selection", value: `YXS <> ${shorts}` },
    { name: "Logan Thunder Rep Athletes Only", value: "I understand..." },
  ],
});
const componentLines = [
  { id: 3, product_id: 10488928796971, quantity: 1, properties: [] },
  { id: 4, product_id: 10488850383147, quantity: 1, properties: [] },
];
const base = { orderId: "18980824088875", orderNumber: "H2H2412581", nowIso: "2026-10-06T02:06:51Z" };
const james = { customer: { first_name: "james", last_name: "deng" } } as any;

(async () => {
  console.log("\n1. James Deng order (2 packs, no allocator data) is caught");
  {
    const db = fakeDb();
    const n = await flagUnallocatedLines({ supabase: db, payload: james, lineItems: [jamesLine(1, "3XS"), jamesLine(2, "2XS"), ...componentLines], skipUnits: 0, ...base });
    ok(n === 2, `flagged 2 units (got ${n})`);
    ok(db.inserted.length === 2, "2 unmatched rows recorded");
    const r = db.inserted[0];
    ok(r.club_id === LOGAN && r.season === "2026/2027" && r.product_type === "mens", "right club, season and product");
    ok(r.status === "unmatched" && r.assigned_number === null && r.jersey_name === null, "unmatched, no number, no jersey name guessed");
    ok(r.size === "YXS" && r.shopify_order_id === base.orderId && r.order_number === base.orderNumber && !!r.paid_at, "size and order details attached");
    ok(r.first_name === "james" && r.last_name === "deng", "buyer name recorded for identification");
    ok(r.age_group === undefined, "no age group set (left for you to assign)");
    ok(db.inserted[0].shopify_line_item_id === "1" && db.inserted[1].shopify_line_item_id === "2", "each pack tied to its own order line");
    ok(db.events.some((e: any) => /Allocator bypass/.test(e.message) && e.level === "warn"), "logged as a warning");
  }

  console.log("\n2. Legitimate orders are left alone");
  {
    const db = fakeDb();
    const legit = { ...jamesLine(1, "M"), properties: [...(jamesLine(1, "M").properties), { name: "_h2h_preorder_request_id", value: "abc" }, { name: "_h2h_prealloc_jersey_number", value: "7" }] };
    ok((await flagUnallocatedLines({ supabase: db, payload: james, lineItems: [legit, ...componentLines], skipUnits: 0, ...base })) === 0 && db.inserted.length === 0, "line with allocator data → nothing recorded");
    const ordinary = [{ id: 9, product_id: 123, quantity: 2, properties: [] }];
    ok((await flagUnallocatedLines({ supabase: db, payload: james, lineItems: ordinary, skipUnits: 0, ...base })) === 0 && db.inserted.length === 0, "ordinary product (not mapped) → nothing recorded");
    const gc = [{ id: 10, product_id: 999, quantity: 1, properties: [] }];
    ok((await flagUnallocatedLines({ supabase: db, payload: james, lineItems: gc, skipUnits: 0, ...base })) === 0 && db.inserted.length === 0, "club without require_widget (Gold Coast) → untouched");
  }

  console.log("\n3. Edge cases");
  {
    let db = fakeDb();
    ok((await flagUnallocatedLines({ supabase: db, payload: james, lineItems: [jamesLine(1, "3XS")], skipUnits: 1, ...base })) === 0 && db.inserted.length === 0, "cart-attribute fallback already linked this single pack → not double-counted");
    db = fakeDb();
    ok((await flagUnallocatedLines({ supabase: db, payload: james, lineItems: [jamesLine(1, "3XS"), jamesLine(2, "2XS")], skipUnits: 1, ...base })) === 1 && db.inserted.length === 1, "fallback covered one of two packs → only the other is flagged");
    db = fakeDb({ existingUnmatched: 1 });
    ok((await flagUnallocatedLines({ supabase: db, payload: james, lineItems: [jamesLine(1, "3XS")], skipUnits: 0, ...base })) === 0 && db.inserted.length === 0, "webhook retry → no duplicate row");
    db = fakeDb();
    const q2 = { ...jamesLine(1, "3XS"), quantity: 2 };
    ok((await flagUnallocatedLines({ supabase: db, payload: james, lineItems: [q2], skipUnits: 0, ...base })) === 2 && db.inserted.length === 2, "quantity 2 → 2 rows");
    db = fakeDb({ clubs: [{ ...CLUBS[0], active_preorder_season: null }, CLUBS[1]] });
    const n = await flagUnallocatedLines({ supabase: db, payload: james, lineItems: [jamesLine(1, "3XS")], skipUnits: 0, ...base });
    ok(n === 1 && db.inserted.length === 0 && db.events.some((e: any) => e.level === "error"), "club with no active season → can't create a row, but still flagged + logged as an error");
    db = fakeDb();
    await flagUnallocatedLines({ supabase: db, payload: { shipping_address: { first_name: "Sam", last_name: "Lee" } } as any, lineItems: [jamesLine(1, "3XS")], skipUnits: 0, ...base });
    ok(db.inserted[0].first_name === "Sam" && db.inserted[0].last_name === "Lee", "falls back to the shipping name when no customer name");
    db = fakeDb();
    await flagUnallocatedLines({ supabase: db, payload: {} as any, lineItems: [{ ...jamesLine(1, "3XS"), properties: [] }], skipUnits: 0, ...base });
    ok(db.inserted[0].size === "Unknown" && db.inserted[0].first_name === "Unknown", "missing size/name → 'Unknown', still recorded");
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
