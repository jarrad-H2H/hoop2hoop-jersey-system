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
function ageGroupBucketSiblings(ag: string | null | undefined): string[] {
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
function getClashYobWindow(
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
function yobOverlapsWindow(
  exactYob: number | null | undefined,
  estMin: number | null | undefined,
  estMax: number | null | undefined,
  ageGroup: string | null | undefined,
  seasonYear: number,
  window: { min: number; max: number }
): boolean {
  // 1. Exact YOB
  if (typeof exactYob === "number" && Number.isFinite(exactYob)) {
    return exactYob >= window.min && exactYob <= window.max;
  }
  // 2. Estimated range
  if (typeof estMin === "number" && typeof estMax === "number" &&
      Number.isFinite(estMin) && Number.isFinite(estMax)) {
    return estMin <= window.max && estMax >= window.min;
  }
  // 3. Fallback: derive from age_group (transitional BC imports)
  const fromAg = estimateYobFromAgeGroup(ageGroup, seasonYear);
  if (fromAg) {
    return fromAg.min <= window.max && fromAg.max >= window.min;
  }
  // 4. No data — conservatively count as potential clash
  return true;
}

/**
 * Types shared with the React components
 */
export interface ClashPlayer {
  id: string;
  first_name: string;
  last_name: string;
  division_code: string | null; // e.g. "JGC1" (GC) or "14B.1" (Seahawks)
  team_name: string | null;     // e.g. "BLAZES" (GC), null for Seahawks
  age_group: string | null;     // e.g. "U14"
  final_shirt: number | null;
  year_of_birth: number | null;
  estimated_yob_min?: number | null;
  estimated_yob_max?: number | null;
  bc_last_seen_season?: number | null;
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
  } = options;

  const seasonYear =
    typeof optSeasonYear === "number" && Number.isFinite(optSeasonYear)
      ? optSeasonYear
      : new Date().getFullYear();

  // Fetch all ACTIVE players in this club wearing this jersey number. Inactive/released
  // players (bc_last_seen_season < seasonYear - 2) must not block their old number for
  // the team-aware path either -- this filter previously only applied in the YOB-window
  // fallback branch, so the (far more common) team-aware path never freed up old numbers.
  let clashQuery = supabase
    .from("players")
    .select("id, first_name, last_name, division_code, team_name, age_group, final_shirt, year_of_birth, estimated_yob_min, estimated_yob_max, bc_last_seen_season")
    .eq("club_id", clubId)
    .eq("final_shirt", jerseyNumber)
    .or(`bc_last_seen_season.is.null,bc_last_seen_season.gte.${seasonYear - 2}`);
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
      // Same team = same (division_code, team_name) pair, null-safe.
      const sameTeam =
        (p.division_code ?? null) === (divisionCode ?? null) &&
        (p.team_name ?? null) === (teamName ?? null);

      if (sameTeam) {
        hardClashes.push(p);
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
  } else {
    // Widget path: YOB-window clash logic (ALLOCATION_LOGIC.md rules).
    // Note: hasU8Division requires an async query but smartCheckNumber is called
    // per-number so we pass hasU8=false here (conservative: uses ±1 window for U10).
    // The proactive filter in suggestNumbersForClubRanked does the full U8 check.
    if (typeof yearOfBirth !== "number" || !Number.isFinite(yearOfBirth)) {
      // No YOB at all — flag all active holders as clashes (safe fallback)
      hardClashes = allNumberHolders.filter(
        (p) => p.bc_last_seen_season === null || (p.bc_last_seen_season ?? 0) >= seasonYear - 2
      );
    } else {
      const clashWin = getClashYobWindow(yearOfBirth, seasonYear, /* hasU8 */ false);
      hardClashes = allNumberHolders.filter((p) => {
        // Inactive players don't block numbers
        if (p.bc_last_seen_season !== null && p.bc_last_seen_season !== undefined &&
            p.bc_last_seen_season < seasonYear - 2) {
          return false;
        }
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
    }
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
      const hasCrossPoolClash = crossPoolCheck && hardClashes.some(
        (p) => !((p.division_code ?? null) === (divisionCode ?? null) &&
                 (p.team_name ?? null) === (teamName ?? null))
      );
      statusMessage = hasCrossPoolClash
        ? hasStock
          ? "This number is worn by another team in the same age group (cross-pool check) — choose a different number."
          : "This number is worn by another team in the same age group and there is no available stock."
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
  teamContext?: Pick<SmartCheckOptions, "divisionCode" | "teamName" | "ageGroup">
): Promise<NumberSuggestion[]> {
  const { data, error } = await supabase
    .from("inventory")
    .select("jersey_number")
    .eq("club_id", clubId)
    .eq("status", STATUS_AVAILABLE)
    .eq("size", size);

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

  const results: NumberSuggestion[] = [];

  for (const candidate of candidates) {
    const { clashes } = await smartCheckNumber(
      clubId,
      candidate.jersey_number,
      teamContext ?? {}
    );
    if (clashes.length === 0) results.push(candidate);
    if (results.length >= limit) break;
  }

  return results;
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
}): Promise<NumberSuggestion[]> {
  const limit = Math.max(1, input.limit ?? 10);
  // cohortWindowYears / adjacentCohortYears kept in the signature for API compatibility
  // but the widget path now uses age-group-derived windows (ALLOCATION_LOGIC.md).
  // Team-aware path: an actual team identity is known. ageGroup alone does NOT imply
  // team context — see matching comment in smartCheckNumber.
  const hasTeamContext =
    input.divisionCode !== undefined || input.teamName !== undefined;

  const currentYear = input.seasonYear || new Date().getFullYear();
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
    // Team-aware: block numbers worn by ACTIVE players on the SAME team. Inactive/released
    // players (bc_last_seen_season < currentYear - 2) must not block their old number here
    // either -- this filter previously only applied in the YOB-window fallback branch.
    const sameTeamQuery = supabase
      .from("players")
      .select("final_shirt")
      .eq("club_id", input.clubId)
      .in("final_shirt", candidateNums)
      .or(`bc_last_seen_season.is.null,bc_last_seen_season.gte.${currentYear - 2}`);

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
  } else {
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

    // Single query: all active holders of candidate numbers at this club.
    // "Active" = bc_last_seen_season IS NULL (transitional) OR >= currentYear - 2.
    let allHoldersQuery = supabase
      .from("players")
      .select("final_shirt, year_of_birth, estimated_yob_min, estimated_yob_max, age_group")
      .eq("club_id", input.clubId)
      .in("final_shirt", candidateNums)
      .or(`bc_last_seen_season.is.null,bc_last_seen_season.gte.${currentYear - 2}`);
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

      if (yobOverlapsWindow(exactYob, estMin, estMax, ageGrp, currentYear, clashWindow)) {
        blockedNums.add(n);
      } else if (yobOverlapsWindow(exactYob, estMin, estMax, ageGrp, currentYear, adjWindow)) {
        adjCounts.set(n, (adjCounts.get(n) ?? 0) + 1);
      }
    }

    // Source 2: active pending reservations / purchases
    const { data: resBlock, error: rbErr } = await supabase
      .from("pending_allocations")
      .select("jersey_number, year_of_birth, expires_at, status")
      .eq("club_id", input.clubId)
      .in("jersey_number", candidateNums)
      .in("status", ["reserved", "purchased"]);

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
      if (resYob >= clashWindow.min && resYob <= clashWindow.max) {
        blockedNums.add(n);
      } else if (resYob >= adjWindow.min && resYob <= adjWindow.max) {
        adjCounts.set(n, (adjCounts.get(n) ?? 0) + 1);
      }
    }
  }

  // ── Cross-pool blocking: additionally hard-block same-age-group numbers ──────
  // Runs in BOTH team-aware and widget paths when crossPoolCheck is active.
  // Inactive players (bc_last_seen_season < currentYear - 2) are excluded.
  if (input.crossPoolCheck && input.ageGroup) {
    let cpQuery = supabase
      .from("players")
      .select("final_shirt")
      .eq("club_id", input.clubId)
      .in("age_group", ageGroupBucketSiblings(input.ageGroup))
      .in("final_shirt", candidateNums)
      .or(`bc_last_seen_season.is.null,bc_last_seen_season.gte.${currentYear - 2}`);
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
  }

  // Team path adjacent penalty (runs when hasTeamContext)
  if (hasTeamContext) {
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
        .select("final_shirt, division_code, team_name")
        .eq("club_id", input.clubId)
        .in("final_shirt", candidateNums)
        .in("age_group", adjacentGroups)
        .or(`bc_last_seen_season.is.null,bc_last_seen_season.gte.${currentYear - 2}`);
      if (input.excludePlayerId) {
        adjQuery = adjQuery.neq("id", input.excludePlayerId);
      }
      const { data: adjPlayers } = await adjQuery;

      for (const p of adjPlayers ?? []) {
        const n = Number((p as any).final_shirt);
        if (!Number.isFinite(n)) continue;
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

  const scored: NumberSuggestion[] = [];
  for (const n of candidateNums) {
    if (blockedNums.has(n)) continue;

    const stockDepth = stockCounts.get(n) ?? 0;
    const adjUse = adjCounts.get(n) ?? 0;
    const lowNumberPenalty = n >= 0 && n <= 10 ? 2 : 0;
    const score = adjUse * 100 + lowNumberPenalty * 10 - stockDepth * 2;

    scored.push({ jersey_number: n, total_stock: stockDepth, score });
  }

  scored.sort((a, b) => {
    const as = a.score ?? 0;
    const bs = b.score ?? 0;
    if (as !== bs) return as - bs;
    return a.jersey_number - b.jersey_number;
  });

  return scored.slice(0, limit);
}

/**
 * Reserve (hard lock): inventory Available -> Allocated
 */
export async function allocateNumberForClub(
  clubId: string,
  jerseyNumber: number,
  size: string
): Promise<{ success: boolean; inventoryId?: string; message?: string }> {
  const { data, error } = await supabase
    .from("inventory")
    .select("id")
    .eq("club_id", clubId)
    .eq("status", STATUS_AVAILABLE)
    .eq("jersey_number", jerseyNumber)
    .eq("size", size)
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
  };

  const { error } = await supabase.from("allocations").insert(insertPayload);

  if (error) {
    console.error("logAllocationEvent insert error", error);
    return { success: false };
  }

  return { success: true };
}

export async function createPendingAllocation(input: {
  clubId: string;
  inventoryId: string;
  jerseyNumber: number;
  size: string;
  seasonYear: number;
  yearOfBirth: number;
  teamId?: string | null;
  expiresMinutes?: number;
}): Promise<{ success: boolean; row?: PendingAllocationRow; message?: string }> {
  const expiresMinutes = Math.max(1, input.expiresMinutes ?? 15);
  const expiresAtIso = new Date(Date.now() + expiresMinutes * 60_000).toISOString();

  const payload = {
    club_id: input.clubId,
    inventory_id: input.inventoryId,
    jersey_number: input.jerseyNumber,
    size: input.size,
    season_year: input.seasonYear,
    year_of_birth: input.yearOfBirth,
    team_id: input.teamId ?? null,
    status: "reserved",
    expires_at: expiresAtIso,
  };

  const { data, error } = await supabase
    .from("pending_allocations")
    .insert(payload)
    .select("*")
    .limit(1);

  if (error) {
    console.error("createPendingAllocation insert error", error);
    return { success: false, message: "Failed to create pending allocation record." };
  }

  const row = (data ?? [])[0] as PendingAllocationRow | undefined;
  if (!row) return { success: false, message: "Pending allocation insert returned no row." };

  return { success: true, row };
}

/**
 * Look up an existing player by name + YOB within a club.
 */
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
  const firstTrimmed = firstName.trim();
  const lastTrimmed = lastName.trim();

  const cohortFilter = ageGroup
    ? `year_of_birth.eq.${yearOfBirth},age_group.eq.${ageGroup}`
    : `year_of_birth.eq.${yearOfBirth}`;

  const { data: exact } = await supabase
    .from("players")
    .select("id, first_name, last_name, final_shirt, year_of_birth, division_code, team_name")
    .eq("club_id", clubId)
    .ilike("first_name", firstTrimmed)
    .ilike("last_name", lastTrimmed)
    .or(cohortFilter)
    .limit(1);

  let player = (exact ?? [])[0] as any;

  if (!player) {
    const { data: fuzzy } = await supabase
      .from("players")
      .select("id, first_name, last_name, final_shirt, year_of_birth, division_code, team_name")
      .eq("club_id", clubId)
      .ilike("last_name", lastTrimmed)
      .or(cohortFilter)
      .limit(5);

    const candidates = (fuzzy ?? []) as any[];
    if (candidates.length > 0) {
      const firstLower = firstTrimmed.toLowerCase();
      player =
        candidates.find(
          (p) =>
            firstLower.length >= 3 &&
            (p.first_name ?? "").toLowerCase().startsWith(firstLower.slice(0, 3))
        ) ?? candidates[0];
    }
  }

  if (!player) return { found: false };

  let previousInventoryId: string | null = null;
  if (player.final_shirt) {
    const { data: invData } = await supabase
      .from("inventory")
      .select("id")
      .eq("club_id", clubId)
      .eq("jersey_number", player.final_shirt)
      .eq("status", "Allocated")
      .eq("product_type", productType)
      .limit(1);
    previousInventoryId = ((invData ?? [])[0] as any)?.id ?? null;
  }

  return {
    found: true,
    playerId: player.id,
    matchedFirstName: player.first_name ?? undefined,
    matchedLastName: player.last_name ?? undefined,
    currentJerseyNumber: player.final_shirt ?? null,
    previousInventoryId,
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

export async function returnJerseyToStock(
  clubId: string,
  jerseyNumber: number,
  size: string
): Promise<{ success: boolean; message: string }> {
  const { data, error } = await supabase
    .from("inventory")
    .select("id, status")
    .eq("club_id", clubId)
    .eq("jersey_number", jerseyNumber)
    .eq("size", size)
    .in("status", [STATUS_ALLOCATED, STATUS_AVAILABLE])
    .limit(1);

  if (error) {
    console.error("returnJerseyToStock select error", error);
    return { success: false, message: "Failed to read inventory while returning jersey." };
  }

  const row = (data ?? [])[0];
  if (!row) {
    return {
      success: false,
      message: "No matching inventory row found. Nothing to return.",
    };
  }

  const inventoryId = row.id as string;

  const { error: updateError } = await supabase
    .from("inventory")
    .update({
      status: STATUS_AVAILABLE,
      allocated_player_id: null,
      allocation_date: null,
      return_date_due: null,
    })
    .eq("id", inventoryId);

  if (updateError) {
    console.error("returnJerseyToStock update error", updateError);
    return {
      success: false,
      message: "Failed to update inventory while returning jersey.",
    };
  }

  await logAllocationEvent({
    allocation_type: "return",
    club_id: clubId,
    player_id: null,
    jersey_number: jerseyNumber,
    size,
    note: "Warehouse return to stock",
  });

  return {
    success: true,
    message: `Jersey #${jerseyNumber} (${size}) marked Available.`,
  };
}
