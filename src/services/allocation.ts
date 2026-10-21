// FILE: src/services/allocation.ts
import { supabase } from "./supabase";

// ─── Age group helpers ─────────────────────────────────────────────────────────
// Used to determine adjacent cohort warnings (different team, close age group).
const AGE_GROUP_ORDER = ["U8", "U10", "U12", "U14", "U16", "U18", "U20", "Junior", "Open Girls", "Open", "Seniors", "SLG"];

function ageGroupIndex(ag: string | null | undefined): number {
  if (!ag) return -1;
  const upper = ag.trim().toUpperCase();
  return AGE_GROUP_ORDER.findIndex((g) => g.toUpperCase() === upper);
}

/**
 * Gold Coast girls-only divisions merge multiple standard age groups into one team:
 *   Junior     = U14 + U16 merged (ages 12-15)
 *   Open Girls = U18 + Open/Seniors merged (ages 16+)
 * A girl whose YOB derives to "U14" via the standard ladder may actually be on a
 * "Junior" team, so these labels must be treated as the same/adjacent group for
 * clash-matching purposes. Safe to apply regardless of buyer gender — "Junior" and
 * "Open Girls" never appear on boys' teams structurally.
 */
// Canonical casing matches what's stored in players.age_group / teams.age_group (see Importer.tsx normalizeAgeGroup).
const AGE_GROUP_MERGE_BUCKETS: string[][] = [
  ["U14", "U16", "Junior"],
  ["U18", "Open", "Seniors", "SLG", "Open Girls"],
];

/** Returns the merge-bucket siblings (canonical casing, for DB .in() queries) including the group itself. */
export function ageGroupBucketSiblings(ag: string | null | undefined): string[] {
  if (!ag) return [];
  const upper = ag.trim().toUpperCase();
  const bucket = AGE_GROUP_MERGE_BUCKETS.find((b) => b.some((g) => g.toUpperCase() === upper));
  return bucket ?? [ag.trim()];
}

/** Case-insensitive check: is ag2 in ag1's merge-bucket sibling set (or vice versa)? */
function isSameMergeBucket(ag1?: string | null, ag2?: string | null): boolean {
  if (!ag1 || !ag2) return false;
  const ag2Upper = ag2.trim().toUpperCase();
  return ageGroupBucketSiblings(ag1).some((g) => g.toUpperCase() === ag2Upper);
}

/** Returns true if the two age groups are the same, merge-bucket siblings, or one step apart in the ladder. */
function isAdjacentOrSameAgeGroup(ag1?: string | null, ag2?: string | null): boolean {
  if (!ag1 || !ag2) return false;
  if (isSameMergeBucket(ag1, ag2)) return true;
  const i1 = ageGroupIndex(ag1);
  const i2 = ageGroupIndex(ag2);
  if (i1 === -1 || i2 === -1) return false;
  return Math.abs(i1 - i2) <= 1;
}

// ─── YOB clash-window helpers (ALLOCATION_LOGIC.md rules) ─────────────────────

/**
 * Check whether the club has a U8 division.
 * Only needed for U10 buyers (age 8-9) to decide whether to widen the clash window.
 */
async function hasU8Division(clubId: string): Promise<boolean> {
  const { data } = await supabase
    .from("teams")
    .select("id")
    .eq("club_id_uuid", clubId)
    .eq("age_group", "U8")
    .limit(1);
  return (data ?? []).length > 0;
}

/**
 * Compute the birth-year range that clashes with a buyer born in buyerYob.
 *
 * Clash windows (from ALLOCATION_LOGIC.md):
 *   U8  (age ≤7)         → all ages ≤7 at this club
 *   U10 (age 8-9, U8 ✓) → ±1 year = ages 7–10
 *   U10 (age 8-9, no U8) → all ages ≤9
 *   U12 (age 10-11)      → ±1 = ages 9–12
 *   U14 (age 12-13)      → ±1 = ages 11–14
 *   U16 (age 14-15)      → ±1 = ages 13–16
 *   U18 (age 16-17)      → ±1 = ages 15–18
 *   Open/SLG (age ≥18)   → all ages 18+
 *
 * Returns { min, max } where min ≤ max are birth years (higher = younger).
 */
export function getClashYobWindow(
  buyerYob: number,
  currentYear: number,
  hasU8: boolean
): { min: number; max: number } {
  const age = currentYear - buyerYob;
  if (age <= 7)  return { min: currentYear - 7,  max: currentYear };     // U8: all ≤7
  if (age <= 9) {
    return hasU8
      ? { min: currentYear - 10, max: currentYear - 7 }   // ±1: ages 7–10
      : { min: currentYear - 9,  max: currentYear };       // no U8: all ≤9
  }
  if (age <= 11) return { min: currentYear - 12, max: currentYear - 9  }; // U12
  if (age <= 13) return { min: currentYear - 14, max: currentYear - 11 }; // U14
  if (age <= 15) return { min: currentYear - 16, max: currentYear - 13 }; // U16
  if (age <= 17) return { min: currentYear - 18, max: currentYear - 15 }; // U18
  return { min: 1900, max: currentYear - 18 };                            // Open/SLG: all 18+
}

/**
 * Estimate a YOB range from age_group label + season year.
 * Used as a fallback for BC-imported players who have age_group but not yet
 * estimated_yob_min/max (i.e., imported before the importer fix was deployed).
 */
function estimateYobFromAgeGroup(
  ageGroup: string | null | undefined,
  seasonYear: number
): { min: number; max: number } | null {
  if (!ageGroup) return null;
  const ag = ageGroup.trim().toUpperCase();
  if (ag === "U8")   return { min: seasonYear - 7,  max: seasonYear - 5  };
  if (ag === "U10")  return { min: seasonYear - 9,  max: seasonYear - 8  };
  if (ag === "U12")  return { min: seasonYear - 11, max: seasonYear - 10 };
  if (ag === "U14")  return { min: seasonYear - 13, max: seasonYear - 12 };
  if (ag === "U16")  return { min: seasonYear - 15, max: seasonYear - 14 };
  if (ag === "U18")  return { min: seasonYear - 17, max: seasonYear - 16 };
  if (ag === "U20")  return { min: seasonYear - 99, max: seasonYear - 17 }; // ages 17+ (born 2009 or earlier in 2026)
  if (ag === "JUNIOR") return { min: seasonYear - 15, max: seasonYear - 12 }; // girls only: U14 + U16 merged, ages 12-15
  if (ag === "OPEN GIRLS") return { min: seasonYear - 99, max: seasonYear - 16 }; // girls only: U18 + Open/Seniors merged, ages 16+
  if (ag === "SLG" || ag === "OPEN" || ag === "SENIORS")
    return { min: seasonYear - 99, max: seasonYear - 18 };
  return null;
}

/**
 * Returns true if any YOB information for this player overlaps the given clash window.
 *
 * Priority:
 *  1. Exact year_of_birth (widget-purchased players)
 *  2. estimated_yob_min / estimated_yob_max (BC imports after importer fix)
 *  3. Derived from age_group + seasonYear (BC imports before importer fix — transitional)
 *  4. No data at all → conservatively returns true (treat as potential clash)
 */
export function yobOverlapsWindow(
  exactYob: number | null | undefined,
  estMin: number | null | undefined,
  estMax: number | null | undefined,
  ageGroup: string | null | undefined,
  seasonYear: number,
  window: { min: number; max: number }
): boolean {
  // 1. Exact YOB — inclusive (a player born exactly on the boundary is in the window)
  if (typeof exactYob === "number" && Number.isFinite(exactYob)) {
    return exactYob >= window.min && exactYob <= window.max;
  }
  // 2. Estimated range — exclusive boundaries. Inclusive caused boundary-touching age groups
  // (e.g. Junior girls est_yob_max=2014 touching U12 window.min=2014) to be treated as clashes,
  // blocking every available number for typical U12 buyers at large multi-division clubs.
  if (typeof estMin === "number" && typeof estMax === "number" &&
      Number.isFinite(estMin) && Number.isFinite(estMax)) {
    return estMin < window.max && estMax > window.min;
  }
  // 3. Fallback: derive from age_group (transitional BC imports) — also exclusive
  const fromAg = estimateYobFromAgeGroup(ageGroup, seasonYear);
  if (fromAg) {
    return fromAg.min < window.max && fromAg.max > window.min;
  }
  // 4. No data — conservatively count as potential clash
  return true;
}

/**
 * Types shared with the React components
 */
export interface ClashPlayer {
  id: string;
  /** Only with includeNames (signed-in admin pages); the public key can't read names. */
  first_name?: string;
  last_name?: string;
  division_code: string | null; // e.g. "JGC1" (GC) or "14B.1" (Seahawks)
  team_id?: string | null;      // BC team code on older imports, e.g. "12GC3"
  team_name: string | null;     // e.g. "BLAZES" (GC), null for Seahawks
  age_group: string | null;     // e.g. "U14"
  final_shirt: number | null;
  year_of_birth: number | null;
  estimated_yob_min?: number | null;
  estimated_yob_max?: number | null;
}

export interface StockBySize {
  size: string;
  count: number;
}

export interface NumberSuggestion {
  jersey_number: number;
  total_stock: number;
  score?: number; // lower is better (ranked suggestions only)
}

export interface SmartCheckOptions {
  // Backward-compat cohort options (used by widget; ignored when team info is provided)
  seasonYear?: number;
  yearOfBirth?: number;
  cohortWindowYears?: number;
  // Team identity of the requesting player — enables team-aware clash logic.
  // When provided: same team = hard clash; adjacent age group, different team = soft warning.
  divisionCode?: string | null;
  teamName?: string | null;
  ageGroup?: string | null; // e.g. "U14" — used for soft warning when YOB unavailable
  /**
   * When true, players in the SAME age group at this club count as hard clashes —
   * even if they are on a different team. Set when the age group runs cross-pool
   * (Mixed gender detected or admin manual override via competition_age_groups).
   */
  crossPoolCheck?: boolean;
  /**
   * Shopify product type for clubs with dual mens/womens products mapped via
   * shopify_product_club_map. Defaults to "default" (single-product clubs).
   * Filters which inventory pool stock is checked against.
   */
  productType?: string;
  /**
   * The confirmed player's own DB id (from lookupPlayerByName). Excludes their own
   * existing jersey record from clash checks — without this, a returning player
   * re-buying their own current number (season replacement, or a spare) would be
   * flagged as a "same-team clash" against themselves.
   */
  excludePlayerId?: string | null;
  /**
   * When true the YOB-window check ALWAYS runs, in addition to any same-team check. Use it for
   * every buyer whose team is self-declared or unconfirmed (i.e. everyone except a returning
   * player confirmed by name lookup -- Plan B). A stated team can then only ADD protection;
   * it never replaces the birth-year check (ALLOCATION_LOGIC.md 2b/2c, Layer 1).
   */
  enforceYobWindow?: boolean;
  /**
   * The team code the buyer picked from the widget dropdown (e.g. "12GC3", "10BC3/4").
   * Teammates are stored under that code in several different fields (division_code,
   * team_name, team_id), so an exact (division, team name) match rarely finds them. When
   * provided, anyone active holding the number under that code (or any part of a combined
   * code such as "10BC3/4" = 10BC3 + 10BC4) counts as a same-team clash. Additive only.
   */
  selectedTeamCode?: string | null;
  /** Buyer's gender (widget answer or mens/womens product). Enables the North Gold Coast rules (§2f). */
  buyerGender?: BuyerGender | null;
  /**
   * Also return the clashing players' names, for admin pages (signed in). The widget runs on the
   * public key, which can only read the clash columns of players, so it must leave this off.
   */
  includeNames?: boolean;
}

/** Team-code variants to match against stored player records ("10BC3/4" -> 10BC3/4, 10BC3, 10BC4). */
function teamCodeVariants(code: string | null | undefined): string[] {
  const c = (code ?? "").trim();
  if (!c) return [];
  const out = new Set<string>([c]);
  const combined = c.match(/^(\d+[A-Za-z]+)(\d+(?:\/\d+)+)$/);
  if (combined) {
    for (const part of combined[2].split("/")) out.add(`${combined[1]}${part}`);
  }
  return Array.from(out);
}

/** PostgREST .or() filter matching a picked team code in any of the fields teams are stored under. */
function teamCodeOrFilter(code: string | null | undefined): string | null {
  const variants = teamCodeVariants(code);
  if (variants.length === 0) return null;
  return variants
    .flatMap((v) => [`division_code.eq.${v}`, `team_name.eq.${v}`, `team_id.eq.${v}`])
    .join(",");
}

function holderMatchesTeamCode(
  p: { division_code?: string | null; team_name?: string | null; team_id?: string | null },
  code: string | null | undefined
): boolean {
  const variants = teamCodeVariants(code);
  return variants.some(
    (v) => p.division_code === v || p.team_name === v || p.team_id === v
  );
}

// ─── North Gold Coast (Seahawks) rules — ALLOCATION_LOGIC.md §2f ─────────────
// Only for clubs with a team in a competition flagged competitions.ngc_clash_rules:
//   1. Super League Girls is one number pool per club (SLG has no age limit and girls move
//      between SLG teams, so a birth-year window can't tell who might be a teammate).
//   2. A boys'-team player never blocks a girl and vice versa. Mixed teams, and holders with
//      no team on record, still block everyone.

export type BuyerGender = "Male" | "Female";

interface NgcContext {
  active: boolean;
  /** teams.name and teams.id -> teams.gender ("Male" | "Female" | "Mixed") */
  teamGender: Map<string, string>;
  /** teams.id of the club's SLG teams (pending reservations store the team as teams.id) */
  slgTeamIds: Set<string>;
}

const INACTIVE_NGC: NgcContext = { active: false, teamGender: new Map(), slgTeamIds: new Set() };
const ngcContextCache = new Map<string, NgcContext>();

async function getNgcContext(clubId: string): Promise<NgcContext> {
  const cached = ngcContextCache.get(clubId);
  if (cached) return cached;
  const { data: active, error } = await supabase.rpc("club_uses_ngc_clash_rules", { p_club_id: clubId });
  if (error) {
    console.error("club_uses_ngc_clash_rules error", error);
    return INACTIVE_NGC; // not cached, so a transient failure retries on the next check
  }
  let ctx = INACTIVE_NGC;
  if (active === true) {
    const { data: teams } = await supabase
      .from("teams")
      .select("id, name, gender")
      .eq("club_id_uuid", clubId);
    const teamGender = new Map<string, string>();
    const slgTeamIds = new Set<string>();
    for (const t of (teams ?? []) as { id: string | null; name: string | null; gender: string | null }[]) {
      if (t.id && isSlgCode(t.name)) slgTeamIds.add(t.id);
      if (!t.gender) continue;
      if (t.name) teamGender.set(t.name, t.gender);
      if (t.id) teamGender.set(t.id, t.gender);
    }
    ctx = { active: true, teamGender, slgTeamIds };
  }
  ngcContextCache.set(clubId, ctx);
  return ctx;
}

// ─── Active players (ALLOCATION_LOGIC.md 5) ───────────────────────────────────
// A number is released once the club's BC reports from the last 12 months (two seasons)
// no longer include its holder. Measured from the club's newest report rather than today,
// so a club whose reports haven't been imported lately never has its numbers freed.
// Players never seen in a BC report (bc_last_seen_at null, e.g. shop-only) stay active.
const RELEASE_AFTER_MONTHS = 12;

/** Oldest last-seen date that still counts as active, given the club's newest report date. */
export function activeCutoff(latestReport: string | null): string {
  if (!latestReport) return "1900-01-01";
  const d = new Date(latestReport + "T00:00:00Z");
  d.setUTCMonth(d.getUTCMonth() - RELEASE_AFTER_MONTHS);
  return d.toISOString().slice(0, 10);
}

export const activeFilterFor = (cutoff: string) => `bc_last_seen_at.is.null,bc_last_seen_at.gte.${cutoff}`;

const activeFilterCache = new Map<string, string>();

/** PostgREST `.or()` filter selecting the club's active players. */
async function activePlayersFilter(clubId: string): Promise<string> {
  const cached = activeFilterCache.get(clubId);
  if (cached) return cached;
  const { data, error } = await supabase
    .from("players")
    .select("bc_last_seen_at")
    .eq("club_id", clubId)
    .is("deleted_at", null)
    .not("bc_last_seen_at", "is", null)
    .order("bc_last_seen_at", { ascending: false })
    .limit(1);
  if (error) {
    console.error("activePlayersFilter error", error);
    return activeFilterFor(activeCutoff(null)); // everyone active; not cached, so it retries
  }
  const filter = activeFilterFor(activeCutoff(data?.[0]?.bc_last_seen_at ?? null));
  activeFilterCache.set(clubId, filter);
  return filter;
}

const seasonYearCache = new Map<string, number>();
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The year a club's ages count from. Basketball Queensland uses the season's registration year:
 * Summer 2026/27 is "2027 BQ Player", so a 2013-born plays U16 (14 in 2027). The BC importer saves
 * it on the competition (competitions.age_year) and a club takes the newest year among its teams'
 * competitions. Clubs without BC teams (pre-order clubs) keep the calendar year.
 */
export async function clubSeasonYear(clubId: string): Promise<number> {
  const cached = seasonYearCache.get(clubId);
  if (cached) return cached;
  const calendarYear = new Date().getFullYear();
  if (!UUID_RE.test(clubId ?? "")) return calendarYear;
  const { data, error } = await supabase.rpc("widget_season_year", { p_club_id: clubId });
  if (error) {
    console.error("widget_season_year error", error);
    return calendarYear; // not cached, so it retries
  }
  const year = typeof data === "number" && Number.isFinite(data) ? data : calendarYear;
  seasonYearCache.set(clubId, year);
  return year;
}

const isSlgCode =(code: string | null | undefined): boolean => /^SLG/i.test((code ?? "").trim());

type TeamFields = {
  division_code?: string | null;
  team_name?: string | null;
  team_id?: string | null;
  age_group?: string | null;
};

function isSlgHolder(p: TeamFields): boolean {
  return (
    isSlgCode(p.division_code) || isSlgCode(p.team_name) || isSlgCode(p.team_id) ||
    (p.age_group ?? "").trim().toUpperCase() === "SLG"
  );
}

/** Gender of the team a holder is stored under; null when no team is on record. */
function holderTeamGender(p: TeamFields, ctx: NgcContext): string | null {
  for (const code of [p.division_code, p.team_name, p.team_id]) {
    const g = code ? ctx.teamGender.get(code) : undefined;
    if (g) return g;
  }
  return isSlgHolder(p) ? "Female" : null;
}

/** NGC rule 2: false only when the holder's team is single-gender and not the buyer's gender. */
function holderBlocksBuyer(p: TeamFields, ctx: NgcContext, buyerGender: BuyerGender | null | undefined): boolean {
  if (!ctx.active || !buyerGender) return true;
  const g = holderTeamGender(p, ctx);
  if (g !== "Male" && g !== "Female") return true;
  return g === buyerGender;
}

/**
 * NGC rule 1: the club's SLG number pool applies to a girl who picked an SLG team, whose
 * looked-up record is on an SLG team, or who is 12 or older and picked no team.
 */
function slgPoolApplies(
  ctx: NgcContext,
  o: {
    buyerGender?: BuyerGender | null;
    yearOfBirth?: number;
    seasonYear: number;
    divisionCode?: string | null;
    teamName?: string | null;
    selectedTeamCode?: string | null;
  }
): boolean {
  if (!ctx.active || o.buyerGender !== "Female") return false;
  if (isSlgCode(o.selectedTeamCode) || isSlgCode(o.divisionCode) || isSlgCode(o.teamName)) return true;
  const age = typeof o.yearOfBirth === "number" ? o.seasonYear - o.yearOfBirth : NaN;
  return !o.selectedTeamCode && age >= 12;
}

export interface SmartCheckResult {
  /** Hard clashes: same team as requesting player. Allocation must not proceed. */
  clashes: ClashPlayer[];
  /** Soft warnings: adjacent age group, different team. Advise choosing another number but can proceed. */
  softWarnings: ClashPlayer[];
  stockBySize: StockBySize[];
  statusMessage: string;
}

export type PendingAllocationStatus =
  | "reserved"
  | "purchased"
  | "expired"
  | "cancelled"
  | "reconciled";

export interface PendingAllocationRow {
  id: string;
  club_id: string;
  inventory_id: string;
  jersey_number: number;
  size: string;
  season_year: number;
  year_of_birth: number;
  team_id: string | null;
  status: PendingAllocationStatus;
  created_at: string;
  expires_at: string;

  order_id?: string | null;
  order_number?: string | null;
  shopify_line_item_id?: string | null;
  purchased_at?: string | null;
  cancelled_at?: string | null;
  expired_at?: string | null;
}

const STATUS_AVAILABLE = "Available";
const STATUS_ALLOCATED = "Allocated";

/**
 * Returns true if jersey numbers must be unique across ALL teams in this age
 * group at this club — i.e. if any team in that age group runs Mixed gender
 * competition, or an admin has manually set a cross-pool override in
 * competition_age_groups.
 *
 * Call this once per widget session (when club + age group are known) and pass
 * the result as `crossPoolCheck` into smartCheckNumber / suggestNumbersForClubRanked.
 */
export async function isAgeGroupCrossPool(
  clubId: string,
  ageGroup: string
): Promise<boolean> {
  // Support both UUID and string club IDs
  const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(clubId);
  const baseQuery = supabase
    .from("teams")
    .select("competition_id, gender")
    .eq("age_group", ageGroup)
    .limit(20);

  const { data: teamData } = isUuid
    ? await baseQuery.eq("club_id_uuid", clubId)
    : await baseQuery.eq("club_id", clubId);

  if (!teamData || (teamData as any[]).length === 0) return false;

  // Auto cross-pool: any team in this age group is Mixed
  if ((teamData as any[]).some((t: any) => t.gender === "Mixed")) return true;

  // Check for manual override in competition_age_groups
  const competitionId: string | null = (teamData as any[])[0]?.competition_id ?? null;
  if (!competitionId) return false;

  const { data: overrideData } = await supabase
    .from("competition_age_groups")
    .select("id")
    .eq("competition_id", competitionId)
    .eq("age_label", ageGroup)
    .limit(1);

  return ((overrideData ?? []) as any[]).length > 0;
}

/**
 * Team-aware clash + stock check for a given number in a club.
 *
 * When divisionCode / teamName / ageGroup are provided:
 *   - "clashes"      = players on the SAME team wearing this number (hard block)
 *   - "softWarnings" = players on a DIFFERENT team in the same or adjacent age group (advisory)
 *
 * When no team info is provided, falls back to the original cohort-based logic
 * (backward compatible with the widget flow which supplies yearOfBirth only).
 */
export async function smartCheckNumber(
  clubId: string,
  jerseyNumber: number,
  options: SmartCheckOptions = {}
): Promise<SmartCheckResult> {
  const {
    seasonYear: optSeasonYear,
    yearOfBirth,
    cohortWindowYears = 0,
    divisionCode,
    teamName,
    ageGroup,
    crossPoolCheck = false,
    productType = "default",
    excludePlayerId,
    enforceYobWindow = false,
    selectedTeamCode = null,
    buyerGender = null,
    includeNames = false,
  } = options;

  const seasonYear =
    typeof optSeasonYear === "number" && Number.isFinite(optSeasonYear)
      ? optSeasonYear
      : await clubSeasonYear(clubId);

  const ngc = await getNgcContext(clubId);
  const activeFilter = await activePlayersFilter(clubId);
  const slgPool = slgPoolApplies(ngc, { buyerGender, yearOfBirth, seasonYear, divisionCode, teamName, selectedTeamCode });

  // Same team as the buyer's stated/looked-up team. Seahawks records carry the team in
  // division_code only (team_name null) while widget purchases store it in team_name, so a
  // division-only team is matched in any field.
  const isTeammate = (p: ClashPlayer): boolean =>
    ((p.division_code ?? null) === (divisionCode ?? null) &&
      (p.team_name ?? null) === (teamName ?? null)) ||
    (divisionCode != null && teamName == null && holderMatchesTeamCode(p, divisionCode));

  // Birth-year-window clashes among the given holders (ALLOCATION_LOGIC.md 2b). Shared by the
  // no-team path and by the "always enforce birth year" layer on top of a stated team.
  const yobWindowClashes = (allHolders: ClashPlayer[]): ClashPlayer[] => {
    const holders = allHolders.filter((p) => holderBlocksBuyer(p, ngc, buyerGender));
    if (typeof yearOfBirth !== "number" || !Number.isFinite(yearOfBirth)) {
      // No YOB at all — flag all active holders as clashes (safe fallback)
      return holders;
    }
    // Note: hasU8Division needs an async query and smartCheckNumber is called per-number,
    // so hasU8=false here (conservative: uses the ±1 window for U10). The proactive filter in
    // suggestNumbersForClubRanked does the full U8 check.
    const clashWin = getClashYobWindow(yearOfBirth, seasonYear, /* hasU8 */ false);
    return holders.filter((p) => {
      // Cross-pool: same age group (or girls Junior/Open Girls merge bucket) = hard clash regardless of YOB window
      if (crossPoolCheck && isSameMergeBucket(ageGroup, p.age_group)) {
        return true;
      }
      return yobOverlapsWindow(
        p.year_of_birth,
        p.estimated_yob_min,
        p.estimated_yob_max,
        p.age_group,
        seasonYear,
        clashWin
      );
    });
  };

  // Fetch all ACTIVE players in this club wearing this jersey number (released players
  // don't block their old number on any path).
  const clashColumns =
    "id, division_code, team_id, team_name, age_group, final_shirt, year_of_birth, estimated_yob_min, estimated_yob_max";
  let clashQuery = supabase
    .from("players")
    .select<string, ClashPlayer>(includeNames ? `${clashColumns}, first_name, last_name` : clashColumns)
    .eq("club_id", clubId)
    .eq("final_shirt", jerseyNumber)
    .is("deleted_at", null)
    .or(activeFilter);
  if (excludePlayerId) {
    clashQuery = clashQuery.neq("id", excludePlayerId);
  }
  const { data: clashRows, error: clashError } = await clashQuery;

  if (clashError) {
    console.error("smartCheckNumber: clash query error", clashError);
    throw new Error("Failed to check clashes for this number.");
  }

  const allNumberHolders = (clashRows ?? []) as ClashPlayer[];

  let hardClashes: ClashPlayer[] = [];
  let softWarnings: ClashPlayer[] = [];

  // Team-aware path: an actual team identity is known (divisionCode or teamName).
  // ageGroup alone does NOT imply team context — it's always known once YOB is entered,
  // even for "I don't know my team" players, who must fall through to the conservative
  // YOB-window hard-block below (ALLOCATION_LOGIC.md 2b) rather than the team-aware path.
  const hasTeamContext = divisionCode !== undefined || teamName !== undefined;

  if (hasTeamContext) {
    for (const p of allNumberHolders) {
      if (isTeammate(p)) {
        hardClashes.push(p);
      } else if (!holderBlocksBuyer(p, ngc, buyerGender)) {
        // NGC: other-gender team, not a possible teammate
      } else {
        // Cross-pool: same age group (or girls Junior/Open Girls merge bucket), different team = hard clash
        const sameAgeGroup = isSameMergeBucket(ageGroup, p.age_group);

        if (crossPoolCheck && sameAgeGroup) {
          hardClashes.push(p);
        } else if (isAdjacentOrSameAgeGroup(ageGroup, p.age_group)) {
          // Different team, adjacent/same age group — soft warning only
          softWarnings.push(p);
        }
      }
    }

    // Additive layers on top of the stated team. A stated team can only ADD protection:
    // (a) teammates stored under the picked team code in any field, (b) the birth-year window.
    if (selectedTeamCode) {
      for (const p of allNumberHolders) {
        if (!hardClashes.includes(p) && holderMatchesTeamCode(p, selectedTeamCode)) {
          hardClashes.push(p);
        }
      }
    }
    if (enforceYobWindow) {
      for (const p of yobWindowClashes(allNumberHolders)) {
        if (!hardClashes.includes(p)) hardClashes.push(p);
      }
    }
    if (hardClashes.length > 0) {
      softWarnings = softWarnings.filter((p) => !hardClashes.includes(p));
    }
  } else {
    // Widget path: YOB-window clash logic (ALLOCATION_LOGIC.md rules).
    hardClashes = yobWindowClashes(allNumberHolders);
  }

  // NGC rule 1: every SLG player at the club counts as a teammate for an SLG buyer.
  const slgPoolClashes = slgPool ? allNumberHolders.filter((p) => isSlgHolder(p)) : [];
  for (const p of slgPoolClashes) {
    if (!hardClashes.includes(p)) hardClashes.push(p);
  }
  if (slgPoolClashes.length > 0) {
    softWarnings = softWarnings.filter((p) => !hardClashes.includes(p));
  }

  // ── Inventory check ──────────────────────────────────────────────────────────
  const { data: inventoryRows, error: invError } = await supabase
    .from("inventory")
    .select("size, status")
    .eq("club_id", clubId)
    .eq("jersey_number", jerseyNumber)
    .eq("product_type", productType);

  if (invError) {
    console.error("smartCheckNumber: inventory query error", invError);
    throw new Error("Failed to check inventory for this number.");
  }

  const stockMap = new Map<string, number>();
  for (const row of inventoryRows ?? []) {
    const sizeLabel = String((row as any).size ?? "");
    if (!sizeLabel) continue;
    if (String((row as any).status) === STATUS_AVAILABLE) {
      stockMap.set(sizeLabel, (stockMap.get(sizeLabel) ?? 0) + 1);
    }
  }

  const stockBySize: StockBySize[] = Array.from(stockMap.entries()).map(
    ([size, count]) => ({ size, count })
  );

  // ── Status message ───────────────────────────────────────────────────────────
  const hasHardClash = hardClashes.length > 0;
  const hasSoftWarning = softWarnings.length > 0;
  const hasStock = stockBySize.length > 0;

  let statusMessage = "";

  if (hasTeamContext) {
    if (hasHardClash) {
      // Distinguish same-team clash vs cross-pool (different team, same age group)
      const hasCrossPoolClash = crossPoolCheck && hardClashes.some((p) => !isTeammate(p));
      // A clash that is not a teammate (only possible with enforceYobWindow) is a player of a
      // similar age elsewhere at the club.
      const hasTeammateClash = hardClashes.some(
        (p) =>
          isTeammate(p) ||
          (selectedTeamCode ? holderMatchesTeamCode(p, selectedTeamCode) : false)
      );
      const hasSlgPoolClash = slgPoolClashes.length > 0 && !hasTeammateClash;
      statusMessage = hasCrossPoolClash
        ? hasStock
          ? "This number is worn by another team in the same age group (cross-pool check) — choose a different number."
          : "This number is worn by another team in the same age group and there is no available stock."
        : hasSlgPoolClash
        ? hasStock
          ? "This number is already worn by a Super League Girls player at this club — choose a different number."
          : "This number is already worn by a Super League Girls player at this club and there is no available stock."
        : enforceYobWindow && !hasTeammateClash
          ? hasStock
            ? "This number is already used by a player of a similar age at this club — choose a different number."
            : "This number is already used by a player of a similar age at this club and there is no available stock."
          : hasStock
            ? "This number is already worn by a teammate — choose a different number."
            : "This number is already worn by a teammate and there is no available stock.";
    } else if (hasSoftWarning && hasStock) {
      statusMessage =
        "This number is used in an adjacent age group (different team). Consider another number, but you can proceed.";
    } else if (!hasHardClash && hasStock) {
      statusMessage = "No team clash — this number is clear and stock is available.";
    } else {
      statusMessage =
        "No team clash, but there is no available stock for this number in this club.";
    }
  } else {
    // Original messages (backward compat for widget)
    const requestedAgeGroup =
      typeof yearOfBirth === "number" && Number.isFinite(yearOfBirth)
        ? seasonYear - yearOfBirth
        : undefined;

    if (requestedAgeGroup !== undefined) {
      if (hasHardClash && hasStock) {
        statusMessage =
          "This number is already used in the same age group for this club, but inventory exists. Proceed with caution.";
      } else if (hasHardClash && !hasStock) {
        statusMessage =
          "This number clashes in the same age group and there is no available stock.";
      } else if (!hasHardClash && hasStock) {
        statusMessage =
          "No cohort clash found for this number and there is available stock.";
      } else {
        statusMessage =
          "No cohort clash found, but there is no available inventory for this number in this club.";
      }
    } else {
      if (hasHardClash && hasStock) {
        statusMessage =
          "This number is already used in this club, but inventory exists. Proceed with caution.";
      } else if (hasHardClash && !hasStock) {
        statusMessage =
          "This number is already used in this club and there is no available stock.";
      } else if (!hasHardClash && hasStock) {
        statusMessage =
          "This number is not currently used in this club and there is available stock.";
      } else {
        statusMessage =
          "This number is not currently used in this club, but there is no available inventory for it.";
      }
    }
  }

  return { clashes: hardClashes, softWarnings, stockBySize, statusMessage };
}

/**
 * Basic suggestion function (conservative: avoids numbers used anywhere in the club).
 * Pass team info to get team-aware suggestions.
 */
export async function suggestNumbersForClub(
  clubId: string,
  size: string,
  limit: number = 10,
  teamContext?: Pick<SmartCheckOptions, "divisionCode" | "teamName" | "ageGroup" | "crossPoolCheck">,
  productType: string = "default"
): Promise<NumberSuggestion[]> {
  const { data, error } = await supabase
    .from("inventory")
    .select("jersey_number")
    .eq("club_id", clubId)
    .eq("status", STATUS_AVAILABLE)
    .eq("size", size)
    .eq("product_type", productType);

  if (error) {
    console.error("suggestNumbersForClub inventory error", error);
    throw new Error("Failed to load inventory for suggestions.");
  }

  const counts = new Map<number, number>();
  (data ?? []).forEach((row: any) => {
    const n = Number(row.jersey_number);
    if (!Number.isFinite(n)) return;
    counts.set(n, (counts.get(n) ?? 0) + 1);
  });

  const candidates = Array.from(counts.entries())
    .map(([jersey_number, total_stock]) => ({ jersey_number, total_stock }))
    .sort((a, b) => a.jersey_number - b.jersey_number);

  const primaryPool: NumberSuggestion[] = [];   // no same-team clash, no adjacent-age warning
  const secondaryPool: NumberSuggestion[] = [];  // no same-team clash, but adjacent-age player exists

  for (const candidate of candidates) {
    const { clashes, softWarnings } = await smartCheckNumber(
      clubId,
      candidate.jersey_number,
      { ...(teamContext ?? {}), productType }
    );
    if (clashes.length > 0) continue;
    if (softWarnings.length === 0) {
      primaryPool.push(candidate);
    } else {
      secondaryPool.push(candidate);
    }
  }

  // Primary-only when 3+ clean numbers exist; otherwise append top 3 from secondary.
  const combined =
    primaryPool.length >= 3
      ? primaryPool
      : [...primaryPool, ...secondaryPool.slice(0, 3)];

  return combined.slice(0, limit);
}

/**
 * Ranked suggestions (size-aware + team/cohort-aware + reservation-aware).
 *
 * When divisionCode + teamName are provided, same-team numbers are hard-blocked.
 * Adjacent age group, different-team numbers incur a scoring penalty.
 * Falls back to YOB-based cohort logic when no team info is given.
 */
export async function suggestNumbersForClubRanked(input: {
  clubId: string;
  size: string;
  seasonYear: number;
  yearOfBirth: number;
  limit?: number;
  cohortWindowYears?: number;
  adjacentCohortYears?: number;
  // Optional team info — enables team-aware blocking
  divisionCode?: string | null;
  teamName?: string | null;
  ageGroup?: string | null;
  /** When true, block same-age-group numbers across all teams (cross-pool). */
  crossPoolCheck?: boolean;
  /** Shopify product type for dual mens/womens clubs. Defaults to "default". */
  productType?: string;
  /** Excludes the confirmed player's own existing jersey record from clash checks. */
  excludePlayerId?: string | null;
  /** Always run the birth-year window, even when a team is given (a team can only add protection). */
  enforceYobWindow?: boolean;
  /** Team code the buyer picked from the dropdown; blocks teammates stored under it (additive). */
  selectedTeamCode?: string | null;
  /** Buyer's gender (widget answer or mens/womens product). Enables the North Gold Coast rules (§2f). */
  buyerGender?: BuyerGender | null;
}): Promise<NumberSuggestion[]> {
  const limit = Math.max(1, input.limit ?? 10);
  const ngc = await getNgcContext(input.clubId);
  const activeFilter = await activePlayersFilter(input.clubId);
  // cohortWindowYears / adjacentCohortYears kept in the signature for API compatibility
  // but the widget path now uses age-group-derived windows (ALLOCATION_LOGIC.md).
  // Team-aware path: an actual team identity is known. ageGroup alone does NOT imply
  // team context — see matching comment in smartCheckNumber.
  const hasTeamContext =
    input.divisionCode !== undefined || input.teamName !== undefined;
  // Team-aware scoring/relaxation (Plan B and the last-resort fallback) only when the birth-year
  // window is NOT being enforced on top. With enforceYobWindow the birth-year path decides.
  const teamAware = hasTeamContext && !input.enforceYobWindow;

  const currentYear = input.seasonYear || (await clubSeasonYear(input.clubId));
  const targetAge = currentYear - input.yearOfBirth;

  const { data: invRows, error: invErr } = await supabase
    .from("inventory")
    .select("jersey_number")
    .eq("club_id", input.clubId)
    .eq("status", STATUS_AVAILABLE)
    .eq("size", input.size)
    .eq("product_type", input.productType ?? "default");

  if (invErr) {
    console.error("suggestNumbersForClubRanked inventory error", invErr);
    throw new Error("Failed to load inventory for ranked suggestions.");
  }

  const stockCounts = new Map<number, number>();
  for (const r of invRows ?? []) {
    const n = Number((r as any).jersey_number);
    if (!Number.isFinite(n)) continue;
    stockCounts.set(n, (stockCounts.get(n) ?? 0) + 1);
  }

  const candidateNums = Array.from(stockCounts.keys());
  if (candidateNums.length === 0) return [];

  const blockedNums = new Set<number>();
  const adjCounts = new Map<number, number>();

  if (hasTeamContext) {
    // Team-aware: block numbers worn by ACTIVE players on the SAME team.
    const sameTeamQuery = supabase
      .from("players")
      .select("final_shirt")
      .eq("club_id", input.clubId)
      .in("final_shirt", candidateNums)
      .is("deleted_at", null)
      .or(activeFilter);

    const divisionOnlyFilter =
      input.divisionCode != null && input.teamName == null ? teamCodeOrFilter(input.divisionCode) : null;
    if (divisionOnlyFilter) {
      // Seahawks: the division code IS the team, stored in division_code on BC records and in
      // team_name on widget purchases — match it in any field (see smartCheckNumber isTeammate).
      sameTeamQuery.or(divisionOnlyFilter);
    } else {
      // null-safe team filter
      if (input.divisionCode != null) {
        sameTeamQuery.eq("division_code", input.divisionCode);
      } else {
        sameTeamQuery.is("division_code", null);
      }
      if (input.teamName != null) {
        sameTeamQuery.eq("team_name", input.teamName);
      } else {
        sameTeamQuery.is("team_name", null);
      }
    }
    if (input.excludePlayerId) {
      sameTeamQuery.neq("id", input.excludePlayerId);
    }

    const { data: sameTeamPlayers, error: stErr } = await sameTeamQuery;
    if (stErr) {
      console.error("same-team block query error", stErr);
      throw new Error("Failed to load same-team player data.");
    }
    for (const p of sameTeamPlayers ?? []) {
      const n = Number((p as any).final_shirt);
      if (Number.isFinite(n)) blockedNums.add(n);
    }
  }

  // Additive: teammates stored under the buyer's picked team code (see selectedTeamCode).
  const pickedTeamFilter = teamCodeOrFilter(input.selectedTeamCode);
  if (pickedTeamFilter) {
    let pickedTeamQuery = supabase
      .from("players")
      .select("final_shirt")
      .eq("club_id", input.clubId)
      .in("final_shirt", candidateNums)
      .is("deleted_at", null)
      .or(activeFilter)
      .or(pickedTeamFilter);
    if (input.excludePlayerId) {
      pickedTeamQuery = pickedTeamQuery.neq("id", input.excludePlayerId);
    }
    const { data: pickedTeamPlayers, error: ptErr } = await pickedTeamQuery;
    if (ptErr) {
      console.error("picked-team block query error", ptErr);
      throw new Error("Failed to load picked-team player data.");
    }
    for (const p of pickedTeamPlayers ?? []) {
      const n = Number((p as any).final_shirt);
      if (Number.isFinite(n)) blockedNums.add(n);
    }
  }

  if (!hasTeamContext || input.enforceYobWindow) {
    // ── Widget path: full YOB-window clash logic (ALLOCATION_LOGIC.md) ──────────

    // For U10 buyers (age 8-9) check whether U8 exists at this club —
    // that determines whether the clash window is ±1 year or "all ages ≤9".
    let hasU8 = false;
    if (targetAge === 8 || targetAge === 9) {
      hasU8 = await hasU8Division(input.clubId);
    }
    const clashWindow = getClashYobWindow(input.yearOfBirth, currentYear, hasU8);
    // Adjacent window: one birth-year step beyond the clash boundary (scoring penalty only)
    const adjWindow = { min: clashWindow.min - 2, max: clashWindow.max + 2 };

    // For mens products, build a set of girls-only team division codes to exclude from
    // clash checking. teams.gender is authoritative (set at BC import time) and covers
    // all girls divisions — not just "Junior"/"Open Girls" but also e.g. "12GC3" U12
    // girls who share the age_group label "U12" with boys but are on separate teams.
    // Note: BC importer stores gender as 'Female'/'Male'/'Mixed', and teams.name IS
    // the division code for Gold Coast format (e.g. "12GC3") — no separate column.
    const girlsDivCodes = new Set<string>();
    if (input.productType === "mens") {
      const { data: girlsTeams } = await supabase
        .from("teams")
        .select("name")
        .eq("club_id_uuid", input.clubId)
        .eq("gender", "Female");
      for (const t of girlsTeams ?? []) {
        if ((t as any).name) girlsDivCodes.add(String((t as any).name));
      }
    }

    // Single query: all active holders of candidate numbers at this club.
    let allHoldersQuery = supabase
      .from("players")
      .select("final_shirt, year_of_birth, estimated_yob_min, estimated_yob_max, age_group, division_code, team_name, team_id")
      .eq("club_id", input.clubId)
      .in("final_shirt", candidateNums)
      .is("deleted_at", null)
      .or(activeFilter);
    if (input.excludePlayerId) {
      allHoldersQuery = allHoldersQuery.neq("id", input.excludePlayerId);
    }
    const { data: allHolders, error: pbErr } = await allHoldersQuery;

    if (pbErr) {
      console.error("players block query error", pbErr);
      throw new Error("Failed to load player clash data for ranked suggestions.");
    }

    for (const p of allHolders ?? []) {
      const n = Number((p as any).final_shirt);
      if (!Number.isFinite(n)) continue;
      const exactYob  = (p as any).year_of_birth ?? null;
      const estMin    = (p as any).estimated_yob_min ?? null;
      const estMax    = (p as any).estimated_yob_max ?? null;
      const ageGrp    = (p as any).age_group ?? null;
      const divCode   = (p as any).division_code ?? null;

      // For mens products, skip players from girls-only teams. Use division_code to
      // match against the girls team set; fall back to age_group for players without one.
      if (input.productType === "mens") {
        if (divCode && girlsDivCodes.has(divCode)) continue;
        if (!divCode && (ageGrp === "Junior" || ageGrp === "Open Girls")) continue;
      }
      // NGC rule 2: other-gender teams never block.
      if (!holderBlocksBuyer(p as TeamFields, ngc, input.buyerGender)) continue;

      if (yobOverlapsWindow(exactYob, estMin, estMax, ageGrp, currentYear, clashWindow)) {
        blockedNums.add(n);
      } else if (yobOverlapsWindow(exactYob, estMin, estMax, ageGrp, currentYear, adjWindow)) {
        adjCounts.set(n, (adjCounts.get(n) ?? 0) + 1);
      }
    }

    // Source 2: active pending reservations / purchases. Through a database function: the public
    // key can't read pending_allocations, which holds buyers' names.
    const { data: resBlock, error: rbErr } = await supabase.rpc("widget_reservation_holds", {
      p_club_id: input.clubId,
      p_jersey_numbers: candidateNums,
    });

    if (rbErr) {
      console.error("reservations block query error", rbErr);
      throw new Error("Failed to load reservation data for ranked suggestions.");
    }

    const now = Date.now();
    for (const r of resBlock ?? []) {
      const n      = Number((r as any).jersey_number);
      const resYob = Number((r as any).year_of_birth);
      if (!Number.isFinite(n) || !Number.isFinite(resYob)) continue;
      // Skip expired reservations (purchased ones are always active)
      if ((r as any).status === "reserved") {
        const expiresAt = Date.parse(String((r as any).expires_at));
        if (!Number.isFinite(expiresAt) || expiresAt <= now) continue;
      }
      if (!holderBlocksBuyer({ team_id: (r as any).team_id ?? null }, ngc, input.buyerGender)) continue;
      if (resYob >= clashWindow.min && resYob <= clashWindow.max) {
        blockedNums.add(n);
      } else if (resYob >= adjWindow.min && resYob <= adjWindow.max) {
        adjCounts.set(n, (adjCounts.get(n) ?? 0) + 1);
      }
    }
  }

  // ── Cross-pool blocking: additionally hard-block same-age-group numbers ──────
  // Runs in BOTH team-aware and widget paths when crossPoolCheck is active.
  // Inactive players are excluded.
  if (input.crossPoolCheck && input.ageGroup) {
    let cpQuery = supabase
      .from("players")
      .select("final_shirt")
      .eq("club_id", input.clubId)
      .in("age_group", ageGroupBucketSiblings(input.ageGroup))
      .in("final_shirt", candidateNums)
      .is("deleted_at", null)
      .or(activeFilter);
    if (input.excludePlayerId) {
      cpQuery = cpQuery.neq("id", input.excludePlayerId);
    }
    const { data: cpPlayers, error: cpErr } = await cpQuery;

    if (cpErr) {
      console.error("cross-pool block query error", cpErr);
      throw new Error("Failed to load cross-pool player data.");
    }
    for (const p of cpPlayers ?? []) {
      const n = Number((p as any).final_shirt);
      if (Number.isFinite(n)) blockedNums.add(n);
    }

    // Inventory-level cross-pool block: mirrors reserve_jersey's Allocated-in-other-pool check.
    // Blocks numbers that are Allocated in the opposite inventory pool regardless of age group,
    // so the suggestion engine and reserve_jersey agree on what's actually reservable.
    if (input.productType === "mens" || input.productType === "womens") {
      const otherType = input.productType === "mens" ? "womens" : "mens";
      const unblocked = candidateNums.filter((n) => !blockedNums.has(n));
      if (unblocked.length > 0) {
        const { data: otherPoolRows, error: opErr } = await supabase
          .from("inventory")
          .select("jersey_number")
          .eq("club_id", input.clubId)
          .eq("product_type", otherType)
          .eq("status", STATUS_ALLOCATED)
          .in("jersey_number", unblocked);
        if (opErr) {
          console.error("cross-pool inventory block query error", opErr);
          throw new Error("Failed to load cross-pool inventory data.");
        }
        for (const r of otherPoolRows ?? []) {
          const n = Number((r as any).jersey_number);
          if (Number.isFinite(n)) blockedNums.add(n);
        }
      }
    }
  }

  // ── NGC rule 1: SLG number pool — every SLG player's number, across all the club's SLG
  // teams (incl. kept players from last season and live SLG reservations), is blocked. ───
  const slgPool = slgPoolApplies(ngc, {
    buyerGender: input.buyerGender,
    yearOfBirth: input.yearOfBirth,
    seasonYear: currentYear,
    divisionCode: input.divisionCode,
    teamName: input.teamName,
    selectedTeamCode: input.selectedTeamCode,
  });
  if (slgPool) {
    let slgQuery = supabase
      .from("players")
      .select("final_shirt")
      .eq("club_id", input.clubId)
      .in("final_shirt", candidateNums)
      .is("deleted_at", null)
      .or(activeFilter)
      .or("division_code.ilike.SLG*,team_name.ilike.SLG*,team_id.ilike.SLG*,age_group.eq.SLG");
    if (input.excludePlayerId) {
      slgQuery = slgQuery.neq("id", input.excludePlayerId);
    }
    const { data: slgPlayers, error: slgErr } = await slgQuery;
    if (slgErr) {
      console.error("SLG pool block query error", slgErr);
      throw new Error("Failed to load Super League Girls player data.");
    }
    for (const p of slgPlayers ?? []) {
      const n = Number((p as any).final_shirt);
      if (Number.isFinite(n)) blockedNums.add(n);
    }

    if (ngc.slgTeamIds.size > 0) {
      const { data: slgRes, error: slgResErr } = await supabase.rpc("widget_reservation_holds", {
        p_club_id: input.clubId,
        p_jersey_numbers: candidateNums,
      });
      if (slgResErr) {
        console.error("SLG pool reservation query error", slgResErr);
        throw new Error("Failed to load Super League Girls reservation data.");
      }
      const nowMs = Date.now();
      for (const r of slgRes ?? []) {
        if (!ngc.slgTeamIds.has(String((r as any).team_id))) continue;
        if ((r as any).status === "reserved") {
          const exp = Date.parse(String((r as any).expires_at));
          if (!Number.isFinite(exp) || exp <= nowMs) continue;
        }
        const n = Number((r as any).jersey_number);
        if (Number.isFinite(n)) blockedNums.add(n);
      }
    }
  }

  // Team path adjacent penalty (runs for team-aware scoring only)
  if (teamAware) {
    const adjacentGroups = Array.from(new Set([
      ...AGE_GROUP_ORDER.filter((ag) => {
        const reqIdx = ageGroupIndex(input.ageGroup);
        const agIdx  = ageGroupIndex(ag);
        return reqIdx !== -1 && agIdx !== -1 && Math.abs(reqIdx - agIdx) <= 1;
      }),
      ...ageGroupBucketSiblings(input.ageGroup),
    ]));

    if (adjacentGroups.length > 0) {
      let adjQuery = supabase
        .from("players")
        .select("final_shirt, division_code, team_name, team_id, age_group")
        .eq("club_id", input.clubId)
        .in("final_shirt", candidateNums)
        .in("age_group", adjacentGroups)
        .is("deleted_at", null)
        .or(activeFilter);
      if (input.excludePlayerId) {
        adjQuery = adjQuery.neq("id", input.excludePlayerId);
      }
      const { data: adjPlayers } = await adjQuery;

      for (const p of adjPlayers ?? []) {
        const n = Number((p as any).final_shirt);
        if (!Number.isFinite(n)) continue;
        if (!holderBlocksBuyer(p as TeamFields, ngc, input.buyerGender)) continue;
        const sameTeam =
          ((p as any).division_code ?? null) === (input.divisionCode ?? null) &&
          ((p as any).team_name ?? null) === (input.teamName ?? null);
        if (!sameTeam) {
          adjCounts.set(n, (adjCounts.get(n) ?? 0) + 1);
        }
      }
    }
  }

  // adjCounts is already populated for the widget path above

  const sortFn = (a: NumberSuggestion, b: NumberSuggestion) => {
    const as = a.score ?? 0;
    const bs = b.score ?? 0;
    if (as !== bs) return as - bs;
    return a.jersey_number - b.jersey_number;
  };

  if (teamAware) {
    // Team-aware path: split into primary (no adjacent-age warning) and secondary (has warning).
    // Primary-only when 3+ clean numbers exist; otherwise append top 3 from secondary.
    const primaryPool: NumberSuggestion[] = [];
    const secondaryPool: NumberSuggestion[] = [];

    for (const n of candidateNums) {
      if (blockedNums.has(n)) continue;
      const stockDepth = stockCounts.get(n) ?? 0;
      const adjUse = adjCounts.get(n) ?? 0;
      const score = adjUse * 100 - stockDepth * 2;
      const suggestion = { jersey_number: n, total_stock: stockDepth, score };
      if (adjUse === 0) {
        primaryPool.push(suggestion);
      } else {
        secondaryPool.push(suggestion);
      }
    }

    primaryPool.sort(sortFn);
    secondaryPool.sort(sortFn);

    const combined =
      primaryPool.length >= 3
        ? primaryPool
        : [...primaryPool, ...secondaryPool.slice(0, 3)];

    return combined.slice(0, limit);
  } else {
    // YOB-window path (no team context): all non-blocked numbers are equally valid.
    // The adj window here is much softer than in the team-aware path — show everything
    // non-blocked, ordered by score so lower-adj-count numbers surface first.
    const scored: NumberSuggestion[] = [];
    for (const n of candidateNums) {
      if (blockedNums.has(n)) continue;
      const stockDepth = stockCounts.get(n) ?? 0;
      const adjUse = adjCounts.get(n) ?? 0;
      const score = adjUse * 100 - stockDepth * 2;
      scored.push({ jersey_number: n, total_stock: stockDepth, score });
    }
    scored.sort(sortFn);
    return scored.slice(0, limit);
  }
}

/**
 * Reserve (hard lock): inventory Available -> Allocated
 */
export async function allocateNumberForClub(
  clubId: string,
  jerseyNumber: number,
  size: string,
  productType: string = "default"
): Promise<{ success: boolean; inventoryId?: string; message?: string }> {
  const { data, error } = await supabase
    .from("inventory")
    .select("id")
    .eq("club_id", clubId)
    .eq("status", STATUS_AVAILABLE)
    .eq("jersey_number", jerseyNumber)
    .eq("size", size)
    .eq("product_type", productType)
    .limit(1);

  if (error) {
    console.error("allocateNumberForClub select error", error);
    return { success: false, message: "Failed to read inventory while allocating." };
  }

  const row = (data ?? [])[0];
  if (!row) {
    return { success: false, message: "No available inventory row for that size/number." };
  }

  const inventoryId = row.id as string;

  const { error: updateError } = await supabase
    .from("inventory")
    .update({
      status: STATUS_ALLOCATED,
      allocation_date: new Date().toISOString(),
    })
    .eq("id", inventoryId)
    .eq("status", STATUS_AVAILABLE);

  if (updateError) {
    console.error("allocateNumberForClub update error", updateError);
    return { success: false, message: "Failed to mark inventory row as allocated." };
  }

  return { success: true, inventoryId };
}

export async function logAllocationEvent(payload: {
  allocation_type: "new" | "swap" | "end" | "return";
  club_id: string;
  player_id?: string | null;
  jersey_number?: number | null;
  size?: string | null;
  previous_jersey_number?: number | null;
  previous_size?: string | null;
  note?: string | null;
  productType?: string;
}): Promise<{ success: boolean }> {
  const insertPayload = {
    allocation_type: payload.allocation_type,
    club_id: payload.club_id,
    player_id: payload.player_id ?? null,
    jersey_number: typeof payload.jersey_number === "number" ? payload.jersey_number : null,
    size: payload.size ?? null,
    previous_jersey_number:
      typeof payload.previous_jersey_number === "number"
        ? payload.previous_jersey_number
        : null,
    previous_size: payload.previous_size ?? null,
    note: payload.note ?? null,
    product_type: payload.productType ?? "default",
  };

  const { error } = await supabase.from("allocations").insert(insertPayload);

  if (error) {
    console.error("logAllocationEvent insert error", error);
    return { success: false };
  }

  return { success: true };
}

export interface ReleasedJersey {
  id: string;
  size: string;
  jersey_number: number;
}

/**
 * Frees the jersey a player currently holds back to Available stock.
 *
 * Jerseys allocated through the admin page carry inventory.allocated_player_id, but jerseys
 * bought through the widget/webhook never do -- so releasing by player id alone silently
 * matches nothing for them and the jersey stays "Allocated" while it is physically back in
 * the warehouse. When the player-id lookup frees nothing, fall back to the player's purchase
 * record (pending_allocations.inventory_id) for the number they hold.
 */
export async function releasePlayerJersey(params: {
  clubId: string;
  playerId: string;
  firstName?: string | null;
  lastName?: string | null;
  yearOfBirth?: number | null;
  jerseyNumber: number | null;
  productType?: string;
}): Promise<{ freed: ReleasedJersey[]; via: "player_link" | "purchase_record" | "none"; error?: string }> {
  const productType = params.productType ?? "default";
  const freedPayload = {
    status: STATUS_AVAILABLE,
    allocated_player_id: null,
    allocation_date: null,
    return_date_due: null,
  };

  // 1. Jerseys linked directly to the player (admin-page allocations)
  const { data: linked, error: linkErr } = await supabase
    .from("inventory")
    .update(freedPayload)
    .eq("club_id", params.clubId)
    .eq("allocated_player_id", params.playerId)
    .eq("status", STATUS_ALLOCATED)
    .select("id, size, jersey_number");

  if (linkErr) {
    console.error("releasePlayerJersey link update error", linkErr);
    return { freed: [], via: "none", error: linkErr.message };
  }
  if (linked && linked.length > 0) {
    return { freed: linked as ReleasedJersey[], via: "player_link" };
  }

  // 2. Widget purchases: find the jersey through the player's most recent purchase of this number
  const first = (params.firstName ?? "").trim();
  const last = (params.lastName ?? "").trim();
  if (params.jerseyNumber == null || !first || !last) {
    return { freed: [], via: "none" };
  }

  let purchaseQuery = supabase
    .from("pending_allocations")
    .select("inventory_id, purchased_at")
    .eq("club_id", params.clubId)
    .eq("jersey_number", params.jerseyNumber)
    .eq("product_type", productType)
    .eq("status", "purchased")
    .not("inventory_id", "is", null)
    .ilike("player_first_name", first)
    .ilike("player_last_name", last)
    .order("purchased_at", { ascending: false })
    .limit(1);
  if (params.yearOfBirth != null) {
    purchaseQuery = purchaseQuery.eq("year_of_birth", params.yearOfBirth);
  }

  const { data: purchases, error: purchaseErr } = await purchaseQuery;
  if (purchaseErr) {
    console.error("releasePlayerJersey purchase lookup error", purchaseErr);
    return { freed: [], via: "none", error: purchaseErr.message };
  }

  const purchase = (purchases ?? [])[0] as { inventory_id: string; purchased_at: string | null } | undefined;
  if (!purchase?.inventory_id) return { freed: [], via: "none" };

  // Safety: if the same stock row was reserved or bought again after this purchase, it now
  // belongs to someone else -- never free it from under them.
  const { data: newer, error: newerErr } = await supabase
    .from("pending_allocations")
    .select("id")
    .eq("inventory_id", purchase.inventory_id)
    .in("status", ["reserved", "purchased"])
    .gt("purchased_at", purchase.purchased_at ?? "1970-01-01")
    .limit(1);
  if (newerErr) {
    console.error("releasePlayerJersey newer-purchase check error", newerErr);
    return { freed: [], via: "none", error: newerErr.message };
  }
  if (newer && newer.length > 0) return { freed: [], via: "none" };

  const { data: freed, error: freeErr } = await supabase
    .from("inventory")
    .update(freedPayload)
    .eq("id", purchase.inventory_id)
    .eq("status", STATUS_ALLOCATED)
    .select("id, size, jersey_number");

  if (freeErr) {
    console.error("releasePlayerJersey purchase-record update error", freeErr);
    return { freed: [], via: "none", error: freeErr.message };
  }
  if (freed && freed.length > 0) {
    return { freed: freed as ReleasedJersey[], via: "purchase_record" };
  }
  return { freed: [], via: "none" };
}

/**
 * Look up an existing player by name + YOB within a club.
 */
export type PlayerCandidate = {
  playerId: string;
  firstName: string;
  lastName: string;
  currentJerseyNumber: number | null;
  previousInventoryId: string | null;
  divisionCode: string | null;
  teamName: string | null;
  ageGroup: string | null;
};

export async function lookupPlayerByName(params: {
  clubId: string;
  firstName: string;
  lastName: string;
  yearOfBirth: number;
  ageGroup?: string | null;
  /** Shopify product type for dual mens/womens clubs. Defaults to "default". */
  productType?: string;
}): Promise<{
  found: boolean;
  /** Present when multiple exact-name matches exist — widget should show a picker. */
  candidates?: PlayerCandidate[];
  playerId?: string;
  matchedFirstName?: string;
  matchedLastName?: string;
  currentJerseyNumber?: number | null;
  previousInventoryId?: string | null;
  /** Plan B: the player's team identifiers from the DB — used for team-aware clash checking. */
  divisionCode?: string | null;
  teamName?: string | null;
}> {
  const { clubId, firstName, lastName, yearOfBirth, ageGroup, productType = "default" } = params;

  // Matched inside the database (widget_lookup_player): the public key can't read players' names.
  // Every player with this first name and surname comes back (the buyer picks); otherwise ONE player
  // whose surname, or part of a double surname, matches and whose age fits the birth year, the
  // closest first name first (typos, Mike for Michael). No birth-year filter on exact names: BC
  // players' age groups move on after import. previous_inventory_id is the stock jersey the order
  // webhook writes off when they say it will be their only jersey: only ever this player's own (the
  // player link, else their own purchase of that number), never another child's with the same number
  // (Celtics 2026-09/10: Harrison Cleary -> Cooper Mulheron's #75). A number that never came from our
  // stock (e.g. a BC singlet) has no jersey to write off.
  const { data } = await supabase.rpc("widget_lookup_player", {
    p_club_id: clubId,
    p_first_name: firstName.trim(),
    p_last_name: lastName.trim(),
    p_year_of_birth: yearOfBirth,
    p_age_group: ageGroup ?? null,
    p_product_type: productType,
  });
  const matches = (data ?? []) as {
    player_id: string;
    first_name: string | null;
    last_name: string | null;
    final_shirt: number | null;
    previous_inventory_id: string | null;
    division_code: string | null;
    team_name: string | null;
    age_group: string | null;
  }[];

  if (matches.length > 1) {
    // Several players with this name — surface them all so the customer can pick.
    const candidates: PlayerCandidate[] = matches.map((p) => ({
      playerId: p.player_id,
      firstName: p.first_name ?? "",
      lastName: p.last_name ?? "",
      currentJerseyNumber: p.final_shirt ?? null,
      previousInventoryId: p.previous_inventory_id ?? null,
      divisionCode: p.division_code ?? null,
      teamName: p.team_name ?? null,
      ageGroup: p.age_group ?? null,
    }));
    return { found: true, candidates };
  }

  const player = matches[0];
  if (!player) return { found: false };

  return {
    found: true,
    playerId: player.player_id,
    matchedFirstName: player.first_name ?? undefined,
    matchedLastName: player.last_name ?? undefined,
    currentJerseyNumber: player.final_shirt ?? null,
    previousInventoryId: player.previous_inventory_id ?? null,
    divisionCode: player.division_code ?? null,
    teamName: player.team_name ?? null,
  };
}

export async function reserveNumberForPurchase(input: {
  clubId: string;
  jerseyNumber: number;
  size: string;
  seasonYear: number;
  yearOfBirth: number;
  teamId?: string | null;
  expiresMinutes?: number;
  playerFirstName?: string;
  playerLastName?: string;
  isNewPlayer?: boolean | null;
  keepExistingJersey?: boolean | null;
  previousJerseyNumber?: number | null;
  previousInventoryId?: string | null;
  /** Shopify product type for dual mens/womens clubs. Defaults to "default". */
  productType?: string;
  /** Made-to-order: skip inventory stock check; create a placeholder Pending row instead. */
  madeToOrder?: boolean;
  /** Profile of a returning player confirmed via "Did you mean…?"; the order updates this profile. */
  playerId?: string | null;
}): Promise<{
  success: boolean;
  message: string;
  pendingAllocationId?: string;
  inventoryId?: string;
}> {
  const { data, error } = await supabase.rpc("reserve_jersey", {
    p_club_id: input.clubId,
    p_jersey_number: input.jerseyNumber,
    p_size: input.size,
    p_season_year: input.seasonYear,
    p_year_of_birth: input.yearOfBirth,
    p_team_id: input.teamId ?? null,
    p_expires_minutes: input.expiresMinutes ?? 30,
    p_player_first_name: input.playerFirstName ?? null,
    p_player_last_name: input.playerLastName ?? null,
    p_is_new_player: input.isNewPlayer ?? null,
    p_keep_existing_jersey: input.keepExistingJersey ?? null,
    p_previous_jersey_number: input.previousJerseyNumber ?? null,
    p_previous_inventory_id: input.previousInventoryId ?? null,
    p_product_type: input.productType ?? "default",
    p_is_made_to_order: input.madeToOrder ?? false,
    p_player_id: input.playerId ?? null,
  });

  if (error) {
    console.error("reserveNumberForPurchase rpc error", error);
    return { success: false, message: "Failed to reserve. Please try again." };
  }

  const row = (Array.isArray(data) ? data[0] : data) as
    | { pending_allocation_id: string; inventory_id: string }
    | undefined;

  if (!row?.pending_allocation_id) {
    return {
      success: false,
      message:
        "That number/size was just taken or is out of stock. Please pick another.",
    };
  }

  return {
    success: true,
    message: `Reserved jersey #${input.jerseyNumber} (${input.size}).`,
    pendingAllocationId: row.pending_allocation_id,
    inventoryId: row.inventory_id,
  };
}

const STATUS_WRITTEN_OFF = "Written Off";

export interface ReturnToStockResult {
  success: boolean;
  message: string;
  /**
   * Set when nothing was changed because the only matching jersey is marked Written Off. The caller
   * should ask the person whether it has physically come back and, if so, call again with
   * `restoreWrittenOff: true`.
   */
  needsConfirmation?: "written_off";
}

/**
 * Warehouse return: puts a physical jersey (read off the jersey as number + size) back into stock.
 *
 * 1. If an Allocated row matches, it is freed (the normal case).
 * 2. Otherwise, if a matching Written Off row exists, nothing changes until the caller confirms
 *    (`restoreWrittenOff: true`). Jerseys are written off automatically when a returning player buys a
 *    replacement and says they are not keeping the old one (api/shopify/orders-create.ts), so a jersey
 *    that later comes back to the warehouse is still Written Off.
 *
 * `deps` exists only so the branching can be tested without touching the live database.
 */
export async function returnJerseyToStock(
  clubId: string,
  jerseyNumber: number,
  size: string,
  productType: string = "default",
  options: { restoreWrittenOff?: boolean } = {},
  deps: { client?: typeof supabase; log?: typeof logAllocationEvent } = {}
): Promise<ReturnToStockResult> {
  const db = deps.client ?? supabase;
  const log = deps.log ?? logAllocationEvent;

  const findRow = async (status: string) =>
    db
      .from("inventory")
      .select("id, status")
      .eq("club_id", clubId)
      .eq("jersey_number", jerseyNumber)
      .eq("size", size)
      .eq("product_type", productType)
      .eq("status", status)
      .limit(1);

  // Prefer an Allocated row: when duplicates exist for the same number/size, picking an
  // already-Available one would "succeed" without freeing anything.
  const { data, error } = await findRow(STATUS_ALLOCATED);

  if (error) {
    console.error("returnJerseyToStock select error", error);
    return { success: false, message: "Failed to read inventory while returning jersey." };
  }

  let row = (data ?? [])[0];
  let restoredFromWrittenOff = false;

  if (!row) {
    const { data: availRows } = await findRow(STATUS_AVAILABLE);
    if ((availRows ?? []).length > 0) {
      return {
        success: false,
        message: `Jersey #${jerseyNumber} (${size}) is already Available. Nothing to return.`,
      };
    }

    const { data: writtenOffRows, error: woError } = await findRow(STATUS_WRITTEN_OFF);
    if (woError) {
      console.error("returnJerseyToStock written-off select error", woError);
      return { success: false, message: "Failed to read inventory while returning jersey." };
    }
    const writtenOff = (writtenOffRows ?? [])[0];
    if (!writtenOff) {
      return {
        success: false,
        message: "No allocated inventory row found for that number and size. Nothing to return.",
      };
    }
    if (!options.restoreWrittenOff) {
      return {
        success: false,
        needsConfirmation: "written_off",
        message:
          `Jersey #${jerseyNumber} (${size}) is marked Written Off, not allocated. ` +
          `If it has physically come back to the warehouse, confirm to restore it to stock.`,
      };
    }
    row = writtenOff;
    restoredFromWrittenOff = true;
  }

  const inventoryId = row.id as string;

  // Guard on the status we found, so a row that changed in the meantime is never touched.
  const { data: updated, error: updateError } = await db
    .from("inventory")
    .update({
      status: STATUS_AVAILABLE,
      allocated_player_id: null,
      allocation_date: null,
      return_date_due: null,
    })
    .eq("id", inventoryId)
    .eq("status", restoredFromWrittenOff ? STATUS_WRITTEN_OFF : STATUS_ALLOCATED)
    .select("id");

  if (updateError) {
    console.error("returnJerseyToStock update error", updateError);
    return {
      success: false,
      message: "Failed to update inventory while returning jersey.",
    };
  }
  if (!updated || updated.length === 0) {
    return {
      success: false,
      message: "That jersey changed while you were returning it. Nothing was changed; please try again.",
    };
  }

  await log({
    allocation_type: "return",
    club_id: clubId,
    player_id: null,
    jersey_number: jerseyNumber,
    size,
    productType,
    note: restoredFromWrittenOff
      ? "Warehouse return to stock (restored from Written Off)"
      : "Warehouse return to stock",
  });

  return {
    success: true,
    message: restoredFromWrittenOff
      ? `Jersey #${jerseyNumber} (${size}) restored from Written Off and marked Available.`
      : `Jersey #${jerseyNumber} (${size}) marked Available.`,
  };
}
