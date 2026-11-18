// The pre-allocated "find my record" lookup (api/preorder/lookup-preallocated.ts) must only show a child
// whose NAME fits what was typed. Before 2026-11-17 a matching birth year was worth enough points on its own,
// so a search for any name listed other children of that birth year with their full names and numbers
// (found on the Gold Coast Rep U14 launch). Rule: same as the standard returning-player lookup
// (ALLOCATION_LOGIC.md §12) plus a one-slip typo allowance.
// 2026-11-18 additions, also tested here: (1) a name that is right apart from one letter is found whatever birth year
// was typed ("near-exact"); (2) first name and surname typed the wrong way round are found when the birth year fits;
// (3) the wrong-page pointer: nothing on this product's list but the name is on the other (boys'/girls') list ->
// the answer says which list, and carries nothing else from it.
// Part 1 tests the matching rule on made-up names. Part 2 runs the real handler against a local stand-in for
// Supabase (no live data) to check the wiring: product, age-group window, required birth year, the pointer.
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
check("surname with two neighbouring letters swapped (Wrenfeild) counts as one slip", ids(roster, q("Tessa", "Wrenfeild", 2014)) === "tessa");

// Near-exact (2026-11-18): one name exactly right, the other one slip away -> found whatever birth year was typed.
check("near-exact: surname slip with the wrong birth year (Wrenfeld, 2010)", ids(roster, q("Tessa", "Wrenfeld", 2010)) === "tessa");
check("near-exact: first-name slip with the wrong birth year (Tesa, 2010)", ids(roster, q("Tesa", "Wrenfield", 2010)) === "tessa");
check("near-exact: a name one letter short (Tess for Tessa) with the wrong birth year", ids(roster, q("Tess", "Wrenfield", 2010)) === "tessa");
check("near-exact: neighbouring letters swapped in the surname, wrong birth year", ids(roster, q("Tessa", "Wrenfeild", 2010)) === "tessa");
check("near-exact: a slip in a double surname that still shares a whole word (Dunmore Ker), wrong birth year", ids(roster, q("Willa", "Dunmore Ker", 2010)) === "willa");
check("near-exact: only one word of a double surname is NOT a slip (Willa Kerr, wrong birth year)", ids(roster, q("Willa", "Kerr", 2010)) === "");
check("near-exact does not cover two slips at once with the wrong birth year (Tesa Wrenfeld, 2010)", ids(roster, q("Tesa", "Wrenfeld", 2010)) === "");
check("two slips at once are still found when the birth year fits (Tesa Wrenfeld, 2014)", ids(roster, q("Tesa", "Wrenfeld", 2014)) === "tessa");
check("near-exact does not cover a nickname with the wrong birth year (Jem Ashdown, 2010)", ids(roster, q("Jem", "Ashdown", 2010)) === "");
check("near-exact does not cover an unrelated first name with the wrong birth year (Zed Wrenfeld, 2010)", ids(roster, q("Zed", "Wrenfeld", 2010)) === "");
check("near-exact: short names get no slip allowance (Zoy Fu, 2010)", ids(roster, q("Zoy", "Fu", 2010)) === "");
check("near-exact is still only one child (five near-identical records)", findPreallocatedMatches(["a", "b", "c", "d", "e"].map(i => r(i, "Tessa", "Wrenfield", 2014)), q("Tessa", "Wrenfeld", 2010)).length === 1);
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

// Swapped (2026-11-18): first name and surname the wrong way round (the club's list, or typed into the wrong boxes).
check("swapped names + right birth year (Wrenfield Tessa, 2014)", ids(roster, q("Wrenfield", "Tessa", 2014)) === "tessa");
check("swapped names, capitals/spaces/accents ignored (MULLER chloe)", ids(roster, q("MULLER", "chloe", 2015)) === "chloe");
check("swapped double surname (Dunmore Kerr / Willa)", ids(roster, q("Dunmore Kerr", "Willa", 2014)) === "willa");
check("swapped names with the wrong birth year -> nobody", ids(roster, q("Wrenfield", "Tessa", 2010)) === "");
check("swapped names, no birth year on file -> found (Orchard Lena)", ids(roster, q("Orchard", "Lena", 2014)) === "lena");
check("swapped needs BOTH names reversed (Wrenfield Xavier shows nobody)", ids(roster, q("Wrenfield", "Xavier", 2014)) === "");
check("an exact match always beats a swapped one", ids([r("a", "Tessa", "Wrenfield", 2014), r("b", "Wrenfield", "Tessa", 2014)], q("Tessa", "Wrenfield", 2014)) === "a");

// nameOnly (the wrong-page pointer): only records whose first name AND surname both fit count.
const nameOnly = (rows: R[], query: ReturnType<typeof q>) => findPreallocatedMatches(rows, query, { nameOnly: true }).map(x => x.id).join(",");
check("nameOnly: an exact name counts", nameOnly(roster, q("Tessa", "Wrenfield", 2014)) === "tessa");
check("nameOnly: a near-exact name counts, whatever the birth year", nameOnly(roster, q("Tessa", "Wrenfeld", 2010)) === "tessa");
check("nameOnly: swapped names count", nameOnly(roster, q("Wrenfield", "Tessa", 2014)) === "tessa");
check("nameOnly: a close first name + surname + birth year counts (Jem Ashdown, 2014)", nameOnly(roster, q("Jem", "Ashdown", 2014)) === "jemma");
check("nameOnly: a sibling who only shares surname + birth year does NOT count (Zed Ashdown, 2015)",
  ids(roster, q("Zed", "Ashdown", 2015)) === "ruby" && nameOnly(roster, q("Zed", "Ashdown", 2015)) === "");

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
  { id: "g3", club_id: CLUB, season: "2026-2027", age_group: "U14 Rep", product_type: "womens", status: "needs_size", first_name: "Sam", last_name: "Rowe", year_of_birth: 2014, assigned_number: 21, jersey_number_display: null, jersey_name: "ROWE", shopify_product_id: null },
  { id: "b3", club_id: CLUB, season: "2026-2027", age_group: "U14 Rep", product_type: "mens", status: "needs_size", first_name: "Sam", last_name: "Rowe", year_of_birth: 2014, assigned_number: 22, jersey_number_display: null, jersey_name: "ROWE", shopify_product_id: null },
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

  // The wrong-page pointer (2026-11-18): nothing on this product's list, but the name is on the other one.
  reply = await call(handler, { ...base, productType: "womens", firstName: "Felix", lastName: "Brandt", yearOfBirth: 2014 });
  check("handler: a boy searched on the girls' page -> no candidates, the answer points to the boys' list", names(reply) === "" && reply.body.otherProductType === "mens");
  check("handler: that pointer carries nothing from the other list (no name, number or id)",
    JSON.stringify(reply.body) === JSON.stringify({ ok: true, candidates: [], otherProductType: "mens" }));
  reply = await call(handler, { ...base, productType: "mens", firstName: "Tessa", lastName: "Wrenfield", yearOfBirth: 2014 });
  check("handler: a girl searched on the boys' page -> points to the girls' list", names(reply) === "" && reply.body.otherProductType === "womens");
  reply = await call(handler, { ...base, productType: "womens", firstName: "Felix", lastName: "Brandt", yearOfBirth: 2009 });
  check("handler: the pointer works with the wrong birth year too (exact name)", names(reply) === "" && reply.body.otherProductType === "mens");
  reply = await call(handler, { ...base, productType: "womens", firstName: "Brandt", lastName: "Felix", yearOfBirth: 2014 });
  check("handler: swapped names on the wrong page also point to the right list", names(reply) === "" && reply.body.otherProductType === "mens");
  reply = await call(handler, { ...base, productType: "womens", firstName: "Xavier", lastName: "Quill", yearOfBirth: 2014 });
  check("handler: a name on neither list -> no pointer", names(reply) === "" && reply.body.otherProductType === null);
  reply = await call(handler, { ...base, productType: "womens", firstName: "Zed", lastName: "Brandt", yearOfBirth: 2014 });
  check("handler: another family's surname + birth year with an unrelated first name -> no pointer (could be a sibling)", names(reply) === "" && reply.body.otherProductType === null);
  reply = await call(handler, { ...base, productType: "mens", firstName: "Ivy", lastName: "Oakes", yearOfBirth: 2013 });
  check("handler: the pointer ignores records outside the open age group", names(reply) === "" && reply.body.otherProductType === null);
  reply = await call(handler, { ...base, productType: "mens", firstName: "Nell", lastName: "Pemberton", yearOfBirth: 2014 });
  check("handler: the pointer ignores unmatched rows", names(reply) === "" && reply.body.otherProductType === null);
  reply = await call(handler, { ...base, productType: "womens", firstName: "Sam", lastName: "Rowe", yearOfBirth: 2014 });
  check("handler: when this list has the player (a girl and a boy share a name) the other list is ignored",
    names(reply) === "Sam Rowe" && reply.body.candidates[0].assignedNumber === 21 && reply.body.otherProductType === null);
  reply = await call(handler, { ...base, firstName: "Felix", lastName: "Brandt", yearOfBirth: 2014 });
  check("handler: no product type (single-list club) -> everything is searched, no pointer", names(reply) === "Felix Brandt" && reply.body.otherProductType === null);

  // Near-exact and swapped names through the real handler.
  reply = await call(handler, { ...base, productType: "mens", firstName: "Felix", lastName: "Brandtt", yearOfBirth: 2009 });
  check("handler: one-letter surname slip with the wrong birth year finds the record", names(reply) === "Felix Brandt");
  reply = await call(handler, { ...base, productType: "mens", firstName: "Brandt", lastName: "Felix", yearOfBirth: 2014 });
  check("handler: swapped names find the record", names(reply) === "Felix Brandt");
  reply = await call(handler, { ...base, productType: "mens", firstName: "Brandt", lastName: "Felix", yearOfBirth: 2009 });
  check("handler: swapped names with the wrong birth year show nobody", names(reply) === "");

  stub.close();
  if (failures > 0) { console.log(`\n${failures} check(s) FAILED`); process.exit(1); }
  console.log("\nAll checks passed");
}
main().catch((e) => { console.error(e); process.exit(1); });
