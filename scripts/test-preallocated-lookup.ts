// The pre-allocated "find my record" lookup (api/preorder/lookup-preallocated.ts) must only show a child
// whose NAME fits what was typed. Before 2026-11-17 a matching birth year was worth enough points on its own,
// so a search for any name listed other children of that birth year with their full names and numbers
// (found on the Gold Coast Rep U14 launch). Rule: same as the standard returning-player lookup
// (ALLOCATION_LOGIC.md §12) plus a one-slip typo allowance.
// Part 1 tests the matching rule on made-up names. Part 2 runs the real handler against a local stand-in for
// Supabase (no live data) to check the wiring: product, age-group window, required birth year.
// Run with: npx tsx scripts/test-preallocated-lookup.ts
import http from "node:http";
import type { AddressInfo } from "node:net";
import { findPreallocatedMatches } from "../api/preorder/lookup-preallocated";

let failures = 0;
function check(label: string, condition: boolean) {
  console.log(`${condition ? "PASS" : "FAIL"} - ${label}`);
  if (!condition) failures++;
}

interface R { id: string; first_name: string; last_name: string; year_of_birth: number | null; shopify_product_id: string | null }
const r = (id: string, first_name: string, last_name: string, year_of_birth: number | null, shopify_product_id: string | null = null): R =>
  ({ id, first_name, last_name, year_of_birth, shopify_product_id });

const roster: R[] = [
  r("tessa", "Tessa", "Wrenfield", 2014),
  r("nova", "Nova", "Hartigan", 2014),
  r("pia", "Pia", "Lockhart", 2015),
  r("jemma", "Jemma", "Ashdown", 2014),
  r("ruby", "Ruby", "Ashdown", 2015),
  r("willa", "Willa", "Dunmore Kerr", 2014),
  r("zoe", "Zoe", "Fu", 2014),
  r("anika", "Anika", "D'Orsay", 2015),
  r("chloe", "Chloé", "Müller", 2015),
  r("lena", "Lena", "Orchard", null), // no birth year on file
];
const q = (firstName: string, lastName: string, yearOfBirth: number, shopifyProductId: string | null = null) =>
  ({ firstName, lastName, yearOfBirth, shopifyProductId });
const ids = (rows: R[], query: ReturnType<typeof q>) => findPreallocatedMatches(rows, query).map(x => x.id).join(",");

// ── Part 1: who is shown ─────────────────────────────────────────────────────
check("exact name -> only that child", ids(roster, q("Tessa", "Wrenfield", 2014)) === "tessa");
check("exact name, capitals/spaces/accents ignored", ids(roster, q("  TESSA ", "wren field", 2014)) === "tessa");
check("exact name is found whatever birth year was typed", ids(roster, q("Tessa", "Wrenfield", 1999)) === "tessa");
check("exact name with an apostrophe typed without it", ids(roster, q("Anika", "DOrsay", 2015)) === "anika");
check("accented name typed without the accents", ids(roster, q("Chloe", "Muller", 2015)) === "chloe");

check("birth year alone shows nobody (unknown name, a year that 3 children share)", ids(roster, q("Xavier", "Quill", 2014)) === "");
check("birth year plus a first name that exists, wrong surname -> nobody", ids(roster, q("Nova", "Smith", 2014)) === "");
check("a first name alone, surname left as junk -> nobody", ids(roster, q("Tessa", "Zzzz", 2014)) === "");
check("one-letter probing shows nobody", ids(roster, q("a", "a", 2014)) === "" && ids(roster, q("t", "w", 2014)) === "");
check("two-letter probing shows nobody", ids(roster, q("Te", "Wr", 2014)) === "");
check("a short fragment of a surname shows nobody", ids(roster, q("Tessa", "ren", 2014)) === "");

check("siblings: exact name shows only that child", ids(roster, q("Jemma", "Ashdown", 2014)) === "jemma");
check("nickname + surname + right birth year -> that child only (Jem for Jemma)", ids(roster, q("Jem", "Ashdown", 2014)) === "jemma");
check("surname + birth year picks the right sibling even with an unrelated first name", ids(roster, q("Zed", "Ashdown", 2015)) === "ruby");
check("surname with no fitting birth year and an unrelated first name -> nobody", ids(roster, q("Zed", "Ashdown", 2016)) === "");
check("first-name slip, right surname + year", ids(roster, q("Tesa", "Wrenfield", 2014)) === "tessa");

check("surname slip with first name and year right (Wrenfeld)", ids(roster, q("Tessa", "Wrenfeld", 2014)) === "tessa");
check("surname slip with the wrong birth year -> nobody", ids(roster, q("Tessa", "Wrenfeld", 2010)) === "");
check("surname with two neighbouring letters swapped (Wrenfeild) counts as one slip", ids(roster, q("Tessa", "Wrenfeild", 2014)) === "tessa");
check("surname with an extra letter (Wrenfielld)", ids(roster, q("Tessa", "Wrenfielld", 2014)) === "tessa");
check("first name with two neighbouring letters swapped (Tesas) + right surname/year", ids(roster, q("Tesas", "Wrenfield", 2014)) === "tessa");
check("two slips in a short surname (Ahsdwon for Ashdown) is not matched on its own", ids(roster, q("Zed", "Ahsdwon", 2014)) === "");

check("double surname: one word of it + year", ids(roster, q("Willa", "Kerr", 2014)) === "willa");
check("double surname typed in full", ids(roster, q("Willa", "Dunmore Kerr", 2014)) === "willa");
check("double surname typed without the space", ids(roster, q("Willa", "DunmoreKerr", 2014)) === "willa");
check("a word of a double surname alone, wrong year, unrelated first name -> nobody", ids(roster, q("Zed", "Kerr", 2010)) === "");

check("2-letter surname exact", ids(roster, q("Zoe", "Fu", 2014)) === "zoe");
check("2-letter surname slip is not tolerated", ids(roster, q("Zoe", "Fi", 2014)) === "");

check("no birth year on file: exact name found", ids(roster, q("Lena", "Orchard", 2014)) === "lena");
check("no birth year on file: first-name slip + surname found", ids(roster, q("Lenna", "Orchard", 2014)) === "lena");
check("no birth year on file: unrelated first name is NOT enough", ids(roster, q("Zed", "Orchard", 2014)) === "");

// A player with two records (e.g. bundle + singlet): the one already claimed by this product comes first.
const twoRecords = [r("bundle", "Tessa", "Wrenfield", 2014, "p-bundle"), r("single", "Tessa", "Wrenfield", 2014, "p-single")];
check("two records for one player: this product's record first", ids(twoRecords, q("Tessa", "Wrenfield", 2014, "p-single")).startsWith("single"));
check("two records for one player: both offered", ids(twoRecords, q("Tessa", "Wrenfield", 2014)).split(",").length === 2);

// Never more than 3 exact matches, never more than 1 inexact match.
const fiveSame = ["a", "b", "c", "d", "e"].map(i => r(i, "Tessa", "Wrenfield", 2014));
check("at most 3 exact matches", findPreallocatedMatches(fiveSame, q("Tessa", "Wrenfield", 2014)).length === 3);
const fiveSiblings = ["a", "b", "c", "d", "e"].map(i => r(i, `Kid${i}`, "Ashdown", 2014));
check("an inexact match is never more than one child", findPreallocatedMatches(fiveSiblings, q("Zed", "Ashdown", 2014)).length === 1);

// Whatever is typed, nobody is shown whose surname doesn't fit: replay a junk grid across the roster.
let leaked = 0;
for (const first of ["Xavier", "Nova", "Tessa", "Pia", "Zoe", "a", "Jemma"]) {
  for (const last of ["Quill", "Smith", "Zzzz", "a", "Lock", "Ash", "Hart"]) {
    for (const yob of [2013, 2014, 2015, 2016]) {
      const got = findPreallocatedMatches(roster, q(first, last, yob));
      // "Lock"/"Ash"/"Hart" are pieces of real surnames (Lockhart, Ashdown, Hartigan): none may appear
      leaked += got.length;
    }
  }
}
check("junk and surname fragments never show anyone", leaked === 0);

// ── Part 2: the real handler against a local stand-in for Supabase ──────────
const CLUB = "11111111-1111-1111-1111-111111111111";
const clubConfig = { require_yob: true, restrict_to_window_age_group: true, current_window_age_group: "U14 Rep" };
const table = [
  { id: "g1", club_id: CLUB, season: "2026-2027", age_group: "U14 Rep", product_type: "womens", status: "needs_size", first_name: "Tessa", last_name: "Wrenfield", year_of_birth: 2014, assigned_number: 7, jersey_number_display: null, jersey_name: "WRENFIELD", shopify_product_id: null },
  { id: "g2", club_id: CLUB, season: "2026-2027", age_group: "U14 Rep", product_type: "womens", status: "needs_size", first_name: "Nova", last_name: "Hartigan", year_of_birth: 2014, assigned_number: 12, jersey_number_display: null, jersey_name: "HARTIGAN", shopify_product_id: null },
  { id: "b1", club_id: CLUB, season: "2026-2027", age_group: "U14 Rep", product_type: "mens", status: "needs_size", first_name: "Felix", last_name: "Brandt", year_of_birth: 2014, assigned_number: 3, jersey_number_display: null, jersey_name: "BRANDT", shopify_product_id: null },
  { id: "o1", club_id: CLUB, season: "2026-2027", age_group: "U16 Rep", product_type: "womens", status: "allocated", first_name: "Ivy", last_name: "Oakes", year_of_birth: 2013, assigned_number: 9, jersey_number_display: null, jersey_name: "OAKES", shopify_product_id: "p1" },
  { id: "u1", club_id: CLUB, season: "2026-2027", age_group: "U14 Rep", product_type: "womens", status: "unmatched", first_name: "Nell", last_name: "Pemberton", year_of_birth: 2014, assigned_number: null, jersey_number_display: null, jersey_name: "PEMBERTON", shopify_product_id: null },
] as Array<Record<string, unknown>>;

const stub = http.createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://stub");
  const send = (status: number, body: unknown) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(body)); };
  const name = url.pathname.replace("/rest/v1/", "");
  if (name === "clubs") return send(200, [{ widget_config: clubConfig }]);
  if (name === "preorder_requests") {
    let rows = table;
    for (const [col, raw] of url.searchParams.entries()) {
      if (["select", "order", "limit", "offset"].includes(col)) continue;
      if (raw.startsWith("eq.")) rows = rows.filter(x => String(x[col]) === raw.slice(3));
      else if (raw.startsWith("in.(")) { const set = raw.slice(4, -1).split(","); rows = rows.filter(x => set.includes(String(x[col]))); }
    }
    return send(200, rows);
  }
  return send(200, []);
});

async function call(handler: (req: any, res: any) => Promise<unknown>, body: unknown) {
  const reply: { status: number; body: any } = { status: 0, body: undefined };
  const res = { status(c: number) { reply.status = c; return res; }, json(b: unknown) { reply.body = b; return res; }, setHeader() { return res; } };
  await handler({ method: "POST", headers: {}, body }, res);
  return reply;
}

async function main() {
  await new Promise<void>((resolve) => stub.listen(0, "127.0.0.1", resolve));
  const port = (stub.address() as AddressInfo).port;
  process.env.SUPABASE_URL = `http://127.0.0.1:${port}`;
  process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-key-for-test";
  const { default: handler } = await import("../api/preorder/lookup-preallocated");
  const base = { clubId: CLUB, season: "2026-2027" };
  const names = (reply: { body: any }) => (reply.body?.candidates ?? []).map((c: any) => `${c.firstName} ${c.lastName}`).join("|");

  let reply = await call(handler, { ...base, productType: "womens", firstName: "Tessa", lastName: "Wrenfield", yearOfBirth: 2014 });
  check("handler: girls' product finds the girl", reply.status === 200 && names(reply) === "Tessa Wrenfield");
  check("handler: answer has the number and jersey name", reply.body.candidates[0].assignedNumber === 7 && reply.body.candidates[0].defaultJerseyName === "WRENFIELD" && reply.body.candidates[0].alreadyConfirmed === false);

  reply = await call(handler, { ...base, productType: "womens", firstName: "Xavier", lastName: "Quill", yearOfBirth: 2014 });
  check("handler: a name that isn't on the list + a shared birth year shows nobody (the launch-day case)", reply.status === 200 && names(reply) === "");

  reply = await call(handler, { ...base, productType: "womens", firstName: "Felix", lastName: "Brandt", yearOfBirth: 2014 });
  check("handler: a boy searched on the girls' product is not found", names(reply) === "");
  reply = await call(handler, { ...base, productType: "mens", firstName: "Felix", lastName: "Brandt", yearOfBirth: 2014 });
  check("handler: the boy is found on the boys' product", names(reply) === "Felix Brandt");

  reply = await call(handler, { ...base, productType: "womens", firstName: "Ivy", lastName: "Oakes", yearOfBirth: 2013 });
  check("handler: a record outside the open age group can't be found", names(reply) === "");

  reply = await call(handler, { ...base, productType: "womens", firstName: "Nell", lastName: "Pemberton", yearOfBirth: 2014 });
  check("handler: unmatched rows (club still to assign a number) are never offered", names(reply) === "");

  reply = await call(handler, { ...base, productType: "womens", firstName: "Tessa", lastName: "Wrenfield" });
  check("handler: birth year still required for a club that requires it", reply.status === 400);

  reply = await call(handler, { ...base, productType: "womens", firstName: "", lastName: "Wrenfield", yearOfBirth: 2014 });
  check("handler: missing name -> 400", reply.status === 400);

  stub.close();
  if (failures > 0) { console.log(`\n${failures} check(s) FAILED`); process.exit(1); }
  console.log("\nAll checks passed");
}
main().catch((e) => { console.error(e); process.exit(1); });
