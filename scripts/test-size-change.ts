// A reserved number is held in ONE size (Wolves H2H2413715, Nov 2026: 5XS #10 reserved, size
// switched to 4XS, order bought a 4XS "#10"). Checks the order webhook's size comparison and its
// fix-up: same number in the size bought when free, otherwise flagged. In-memory database only.
// The storefront side (widget.js drops the reservation on a size change) is checked in the browser.
// Run: npx tsx scripts/test-size-change.ts
import { boughtSizeDiffers, resolveSizeMismatch } from "../api/shopify/orders-create";

let pass = 0, fail = 0;
const ok = (c: boolean, m: string) => { if (c) { pass++; console.log("  ✓ " + m); } else { fail++; console.log("  ✗ FAIL: " + m); } };

console.log("Size comparison");
ok(boughtSizeDiffers("5XS", "4XS") === true, "George Bartle: reserved 5XS, bought 4XS → mismatch");
ok(boughtSizeDiffers("4XS", "4XS") === false, "same size → fine");
ok(boughtSizeDiffers("M", "MM") === false && boughtSizeDiffers("3XS", "3xs") === false, "swatch double read / capitals → same size");
ok(boughtSizeDiffers("L", "Mens / L") === false && boughtSizeDiffers("L", "Mens / XL") === true, "multi-option variant title matches on its size option");
ok(boughtSizeDiffers("M", "") === false && boughtSizeDiffers("M", "Default Title") === false, "no size on the line → can't tell, left alone");

// Minimal stand-in for the Supabase query builder: select/eq/update/insert/maybeSingle.
function fakeDb(tables: Record<string, any[]>) {
  return {
    tables,
    from(table: string) {
      const rows = (tables[table] ??= []);
      const filters: [string, any][] = [];
      let patch: any = null;
      const match = (r: any) => filters.every(([c, v]) => r[c] === v);
      const run = () => {
        const hit = rows.filter(match);
        if (patch) hit.forEach((r) => Object.assign(r, patch));
        return { data: hit.map((r) => ({ ...r })), error: null };
      };
      const q: any = {
        select() { return q; },
        eq(c: string, v: any) { filters.push([c, v]); return q; },
        update(p: any) { patch = p; return q; },
        insert(r: any) { (Array.isArray(r) ? r : [r]).forEach((x) => rows.push({ ...x })); return Promise.resolve({ error: null }); },
        maybeSingle() { const r = run(); return Promise.resolve({ data: r.data[0] ?? null, error: null }); },
        then(res: any, rej: any) { return Promise.resolve(run()).then(res, rej); },
      };
      return q;
    },
  };
}

const W = "wolves";
const inv = (id: string, size: string, status: string, product_type = "default") =>
  ({ id, club_id: W, jersey_number: 10, size, status, product_type });
const hold = (over: any = {}) =>
  ({ id: "p1", club_id: W, inventory_id: "old", size: "5XS", jersey_number: 10, status: "reserved", product_type: "default", ...over });
const setup = (inventory: any[], pendingOver: any = {}) => {
  const pending = hold(pendingOver);
  const db = fakeDb({ inventory, pending_allocations: [{ ...pending }], allocations: [], club_sizes: [] });
  return { db, pending };
};
const row = (db: any, table: string, id: string) => db.tables[table].find((r: any) => r.id === id);
const now = "2026-11-16T00:00:00Z";

async function main() {
  console.log("\nFix-up when the order arrives in another size");

  {
    const { db, pending } = setup([inv("old", "5XS", "Allocated"), inv("n4", "4XS", "Available")]);
    const r = await resolveSizeMismatch({ supabase: db, pending, reservationId: "p1", boughtSizeRaw: "4XS", nowIso: now });
    ok(r.outcome === "swapped" && row(db, "inventory", "n4").status === "Allocated" && row(db, "inventory", "old").status === "Available"
      && row(db, "pending_allocations", "p1").size === "4XS" && row(db, "pending_allocations", "p1").inventory_id === "n4"
      && pending.size === "4XS" && db.tables.allocations.some((a: any) => a.allocation_type === "swap"),
      "4XS #10 in stock → given 4XS #10, 5XS #10 back on sale, records say 4XS");
  }
  {
    const { db, pending } = setup([inv("old", "5XS", "Allocated"), inv("x", "3XS", "Available")]);
    const r = await resolveSizeMismatch({ supabase: db, pending, reservationId: "p1", boughtSizeRaw: "4XS", nowIso: now });
    ok(r.outcome === "flagged" && row(db, "inventory", "old").status === "Allocated" && row(db, "pending_allocations", "p1").size === "5XS"
      && db.tables.allocations.length === 0,
      "George's real case (no 4XS #10) → flagged, nothing changed");
  }
  {
    const { db, pending } = setup([inv("old", "5XS", "Allocated"), inv("n4", "4XS", "Available")], { status: "expired" });
    const r = await resolveSizeMismatch({ supabase: db, pending, reservationId: "p1", boughtSizeRaw: "4XS", nowIso: now });
    ok(r.outcome === "swapped" && !r.oldReleased && row(db, "inventory", "old").status === "Allocated",
      "hold had expired → still given 4XS #10, but the 5XS (maybe someone else's now) is left alone");
  }
  {
    const { db, pending } = setup([inv("old", "5XS", "Pending"), inv("n4", "4XS", "Available")]);
    const r = await resolveSizeMismatch({ supabase: db, pending, reservationId: "p1", boughtSizeRaw: "4XS", nowIso: now });
    ok(r.outcome === "made_to_order" && row(db, "pending_allocations", "p1").size === "4XS" && row(db, "inventory", "n4").status === "Available",
      "made-to-order → record takes 4XS, no stock touched");
  }
  {
    const { db, pending } = setup([inv("old", "5XS", "Allocated", "mens"), inv("w4", "4XS", "Available", "womens")], { product_type: "mens" });
    const r = await resolveSizeMismatch({ supabase: db, pending, reservationId: "p1", boughtSizeRaw: "4XS", nowIso: now });
    ok(r.outcome === "flagged" && row(db, "inventory", "w4").status === "Available",
      "only a women's-product 4XS #10 free, men's bought → flagged (other product's stock never used)");
  }
  {
    const { db, pending } = setup([inv("old", "5XS", "Allocated"), inv("n4", "4XS", "Available")]);
    const r = await resolveSizeMismatch({ supabase: db, pending, reservationId: "p1", boughtSizeRaw: "Reversible / 4XS", nowIso: now });
    ok(r.outcome === "swapped" && r.boughtSize === "4XS", "variant title with two options (\"Reversible / 4XS\") → swapped to 4XS");
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
}
void main();
