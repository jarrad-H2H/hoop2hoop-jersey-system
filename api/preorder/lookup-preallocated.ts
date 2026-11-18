// FILE: api/preorder/lookup-preallocated.ts
// Finds the pre-allocated preorder_requests record for a typed name + birth year (club + season).
// Called by the widget's pre-allocated form to find the player's record before they confirm size.
// POST { clubId, season, productType, shopifyProductId, firstName, lastName, yearOfBirth }
// Returns { candidates: [{ id, firstName, lastName, assignedNumber, assignedNumberDisplay, defaultJerseyName, alreadyConfirmed }],
//           otherProductType }
//
// Who is shown follows the same rule as the standard returning-player lookup (ALLOCATION_LOGIC.md §12):
// a record only appears if the typed NAME fits it. A matching birth year on its own never shows anyone.
// (Before 2026-11-17 it did: a search for any name listed other children of that birth year, with their
// full names and numbers.) See findPreallocatedMatches below.
//
// otherProductType (added 2026-11-18): when nothing is found on this product's list but the same name is on the
// club's OTHER list (boys' vs girls'), it says which one ("mens" | "womens"), so the widget can say "That name is on
// the boys' list, please use the boys' jersey page" instead of a bare "couldn't find a match". It is only a pointer:
// no name, number or id from the other list is ever returned.
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { createClient } from "@supabase/supabase-js";

export const maxDuration = 15;

interface Row {
  id: string;
  first_name: string;
  last_name: string;
  assigned_number: number | null;
  jersey_number_display: string | null;
  jersey_name: string | null;
  status: string;
  year_of_birth: number | null;
  shopify_product_id: string | null;
  product_type: string | null;
}

/** Letters only: capitals, spaces, hyphens, apostrophes and accents are ignored ("D'Abate" = "dabate"). */
const key = (s: string): string => (s ?? "").normalize("NFKD").toLowerCase().replace(/[^a-z]/g, "");

/** Whole words of 3+ letters in a name: "Manuel Kerrison" -> manuel, kerrison; "Smith-Williams" -> smith, williams. */
const words = (s: string): string[] =>
  (s ?? "").normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().split(/[^a-z]+/).filter(w => w.length >= 3);

/** Edit distance where a missing, extra or wrong letter, or two neighbouring letters swapped (Caslte), is one slip. */
function editDistance(a: string, b: string): number {
  const m = a.length, n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, (_, i) =>
    Array.from({ length: n + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0))
  );
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        dp[i][j] = Math.min(dp[i][j], dp[i - 2][j - 2] + 1);
      }
    }
  }
  return dp[m][n];
}

/** 0-50: how alike two letter-only strings are by edit distance. One slip in a 5-8 letter name scores 40+. */
function similarity(a: string, b: string): number {
  const maxLen = Math.max(a.length, b.length);
  if (!maxLen) return 0;
  return Math.max(0, Math.round((1 - editDistance(a, b) / maxLen) * 50));
}

/** One slip: spelled differently but close, and long enough that a single slip means something
 *  (a 3-4 letter name changed by a letter is often a different name: Mia/Max, Hall/Hill). */
function isSlip(a: string, b: string, minLen: number): boolean {
  return a !== b && Math.min(a.length, b.length) >= minLen && similarity(a, b) >= 40;
}

// How the typed surname relates to a stored one (surnameRel results).
const SAME = 3;        // same letters
const SHARES_WORD = 2; // shares a whole word of 3+ letters (Kerrison finds Manuel Kerrison)
const ONE_SLIP = 1;    // one slip away (Millar for Miller; 4+ letters only)

function surnameRel(typed: string, stored: string): 0 | 1 | 2 | 3 {
  const t = key(typed), s = key(stored);
  if (!t || !s) return 0;
  if (t === s) return SAME;
  const storedWords = new Set(words(stored));
  if (words(typed).some(w => storedWords.has(w))) return SHARES_WORD;
  if (isSlip(t, s, 4)) return ONE_SLIP;
  return 0;
}

/** How close the typed first name is to the stored one (lower is closer): 0 same, 1 same first 3 letters (Estele/Estelle),
 *  2 one slip away, 3 same first letter (Mike/Michael), 4 other. */
function firstRank(typed: string, stored: string): 0 | 1 | 2 | 3 | 4 {
  const t = key(typed), s = key(stored);
  if (t && t === s) return 0;
  if (t.length >= 3 && s.length >= 3 && t.slice(0, 3) === s.slice(0, 3)) return 1;
  if (isSlip(t, s, 3)) return 2;
  if (t && s && t[0] === s[0]) return 3;
  return 4;
}

export interface PreallocatedQuery {
  firstName: string;
  lastName: string;
  yearOfBirth: number;
  shopifyProductId: string | null;
}

type Kind = "exact" | "near" | "swapped" | "fuzzy";

/** Which stored records to offer for a typed name + birth year.
 *  1. Same first name and surname: every such record (up to 3), whatever the birth year.
 *  Otherwise ONE record, the best of these (a name that fits no surname shows nothing, and a birth year never
 *  shows a record on its own):
 *  2. Near-exact (2026-11-18): one name is exactly right and the other is one slip away (Tessa Wrenfeld for Tessa
 *     Wrenfield, Tesa Wrenfield). The birth year is NOT needed: a typo and a wrong year can both happen, and a name that
 *     is right apart from one letter is as specific as the whole name. Slips count only in names of 5+ letters (4+
 *     for a surname), as before.
 *  3. Surname (or a whole word of a double surname) the same and the record's birth year the typed one: any first
 *     name (Jem for Jemma). Or a close first name (same first 3 letters, or one slip) with a surname that is the same
 *     or one slip away, when the birth year is the typed one or there is none on the record (or none typed) to compare.
 *  4. Swapped (2026-11-18): the typed first name is the record's surname and the typed surname is its first name
 *     (the club listed them the wrong way round, or they went in the wrong boxes). The birth year must fit.
 *  opts.nameOnly: used for the wrong-page pointer. Only records whose first name AND surname both fit count, so a
 *  sibling or twin who merely shares the surname and birth year never makes it say "that name is on the other list". */
export function findPreallocatedMatches<T extends { first_name: string; last_name: string; year_of_birth: number | null; shopify_product_id: string | null }>(
  rows: T[],
  q: PreallocatedQuery,
  opts: { nameOnly?: boolean } = {}
): T[] {
  const typedYob = Number.isFinite(q.yearOfBirth) && q.yearOfBirth > 0 ? q.yearOfBirth : null;
  const typedFirst = key(q.firstName), typedLast = key(q.lastName);
  const hits: { row: T; kind: Kind; first: number; rel: number; yobFits: boolean; product: boolean; nameFits: boolean }[] = [];

  for (const row of rows) {
    const yobFits = typedYob !== null && row.year_of_birth != null && row.year_of_birth === typedYob;
    const nothingToCompare = typedYob === null || row.year_of_birth == null;
    // A player with two records (e.g. bundle + singlet) gets the one already claimed by this product back first.
    const product = q.shopifyProductId !== null && row.shopify_product_id === q.shopifyProductId;
    const rel = surnameRel(q.lastName, row.last_name);

    if (rel === 0) {
      if (typedFirst && typedLast && typedFirst === key(row.last_name) && typedLast === key(row.first_name) && (yobFits || nothingToCompare)) {
        hits.push({ row, kind: "swapped", first: 5, rel: 0, yobFits, product, nameFits: true });
      }
      continue;
    }

    const first = firstRank(q.firstName, row.first_name);
    const exact = rel === SAME && first === 0;
    // A surname one slip away counts even when a whole word of it is also shared (Van eden for Van Eeden), which
    // surnameRel reports as SHARES_WORD.
    const surnameSlip = isSlip(key(q.lastName), key(row.last_name), 4);
    const near = !exact && ((rel === SAME && isSlip(typedFirst, key(row.first_name), 3)) || (first === 0 && surnameSlip));
    const nameClose = first <= 2 && (yobFits || nothingToCompare);
    const surnameAndYear = yobFits && rel >= SHARES_WORD;
    if (!(exact || near || nameClose || surnameAndYear)) continue;
    hits.push({ row, kind: exact ? "exact" : near ? "near" : "fuzzy", first, rel, yobFits, product, nameFits: exact || near || nameClose });
  }

  const usable = opts.nameOnly ? hits.filter(h => h.nameFits) : hits;
  const exactHits = usable.filter(h => h.kind === "exact");
  if (exactHits.length > 0) {
    return exactHits
      .sort((a, b) => Number(b.product) - Number(a.product) || Number(b.yobFits) - Number(a.yobFits))
      .slice(0, 3)
      .map(h => h.row);
  }
  const order: Record<Kind, number> = { exact: 0, near: 0, fuzzy: 1, swapped: 2 };
  return usable
    .sort((a, b) =>
      order[a.kind] - order[b.kind] || a.first - b.first || b.rel - a.rel ||
      Number(b.yobFits) - Number(a.yobFits) || Number(b.product) - Number(a.product))
    .slice(0, 1)
    .map(h => h.row);
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ ok: false, error: "Method Not Allowed" });
  }

  const SUPABASE_URL = process.env.SUPABASE_URL ?? "";
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
  if (!SUPABASE_URL || !SERVICE_KEY) {
    return res.status(500).json({ ok: false, error: "Server not configured" });
  }

  const body = req.body ?? {};
  const clubId = String(body.clubId ?? "").trim();
  const season = String(body.season ?? "").trim();
  const productType = String(body.productType ?? "").trim();
  const shopifyProductId = String(body.shopifyProductId ?? "").trim() || null;
  const firstName = String(body.firstName ?? "").trim();
  const lastName = String(body.lastName ?? "").trim();
  const yearOfBirth = Number(body.yearOfBirth);

  if (!clubId || !firstName || !lastName) {
    return res.status(400).json({ ok: false, error: "clubId, firstName, lastName are required" });
  }

  const supabase = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

  // Year of birth is mandatory only for clubs that opt in via widget_config.require_yob.
  const { data: clubRow } = await supabase.from("clubs").select("widget_config").eq("id", clubId).maybeSingle();
  const clubCfg = (clubRow as any)?.widget_config ?? {};
  const requireYob = clubCfg.require_yob === true;
  // Clubs with restrict_to_window_age_group only expose records in the current window age group,
  // so earlier windows (e.g. already-paid U18 rows) can't be found or re-confirmed.
  const windowAgeGroup: string | null =
    clubCfg.restrict_to_window_age_group === true && clubCfg.current_window_age_group
      ? String(clubCfg.current_window_age_group)
      : null;
  if (requireYob && (!Number.isFinite(yearOfBirth) || yearOfBirth < 1900 || yearOfBirth > 2100)) {
    return res.status(400).json({ ok: false, error: "A valid yearOfBirth is required" });
  }

  // Both products' lists are read (same club, season, window and status filters); this product's list is searched
  // for the player, and the other one only for the wrong-page pointer.
  let query = supabase
    .from("preorder_requests")
    .select("id, first_name, last_name, assigned_number, jersey_number_display, jersey_name, status, year_of_birth, shopify_product_id, product_type")
    .eq("club_id", clubId)
    // assigned_number may be null (number TBC) — those players still confirm size + jersey name.
    // 'unmatched' rows are excluded by status, so they never appear here.
    .in("status", ["needs_size", "allocated"]);

  if (season) query = query.eq("season", season);
  if (windowAgeGroup) query = query.eq("age_group", windowAgeGroup);

  const { data, error } = await query;

  if (error) {
    return res.status(500).json({ ok: false, error: error.message });
  }

  const all = (data ?? []) as Row[];
  const typed = { firstName, lastName, yearOfBirth, shopifyProductId };
  const productScoped = productType === "mens" || productType === "womens";
  const matches = findPreallocatedMatches(productScoped ? all.filter(r => r.product_type === productType) : all, typed);

  // Nothing on this product's list: is the same name on the club's other list? (Only a pointer, see the header.)
  let otherProductType: "mens" | "womens" | null = null;
  if (productScoped && matches.length === 0) {
    const other: "mens" | "womens" = productType === "mens" ? "womens" : "mens";
    if (findPreallocatedMatches(all.filter(r => r.product_type === other), typed, { nameOnly: true }).length > 0) {
      otherProductType = other;
    }
  }

  const candidates = matches.map(row => ({
    id: row.id,
    firstName: row.first_name,
    lastName: row.last_name,
    assignedNumber: row.assigned_number,
    assignedNumberDisplay: row.jersey_number_display ?? null,
    defaultJerseyName: row.jersey_name ?? row.last_name,
    alreadyConfirmed: row.status === "allocated" && Boolean(row.jersey_name),
  }));

  return res.status(200).json({ ok: true, candidates, otherProductType });
}
