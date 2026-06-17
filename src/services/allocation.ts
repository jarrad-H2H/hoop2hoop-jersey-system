// FILE: src/services/allocation.ts
import { supabase } from "./supabase";

// ─── Age group helpers ─────────────────────────────────────────────────────────
// Used to determine adjacent cohort warnings (different team, close age group).
const AGE_GROUP_ORDER = ["U8", "U10", "U12", "U14", "U16", "U18", "U20", "SLG"];

function ageGroupIndex(ag: string | null | undefined): number {
  if (!ag) return -1;
  return AGE_GROUP_ORDER.indexOf(ag.trim().toUpperCase());
}

/** Returns true if the two age groups are the same or one step apart in the ladder. */
function isAdjacentOrSameAgeGroup(ag1?: string | null, ag2?: string | null): boolean {
  const i1 = ageGroupIndex(ag1);
  const i2 = ageGroupIndex(ag2);
  if (i1 === -1 || i2 === -1) return false;
  return Math.abs(i1 - i2) <= 1;
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
  } = options;

  const seasonYear =
    typeof optSeasonYear === "number" && Number.isFinite(optSeasonYear)
      ? optSeasonYear
      : new Date().getFullYear();

  // Fetch all players in this club wearing this jersey number.
  const { data: clashRows, error: clashError } = await supabase
    .from("players")
    .select("id, first_name, last_name, division_code, team_name, age_group, final_shirt, year_of_birth")
    .eq("club_id", clubId)
    .eq("final_shirt", jerseyNumber);

  if (clashError) {
    console.error("smartCheckNumber: clash query error", clashError);
    throw new Error("Failed to check clashes for this number.");
  }

  const allNumberHolders = (clashRows ?? []) as ClashPlayer[];

  let hardClashes: ClashPlayer[] = [];
  let softWarnings: ClashPlayer[] = [];

  // Team-aware path: at least one of divisionCode / teamName / ageGroup was supplied.
  const hasTeamContext =
    divisionCode !== undefined || teamName !== undefined || ageGroup !== undefined;

  if (hasTeamContext) {
    for (const p of allNumberHolders) {
      // Same team = same (division_code, team_name) pair, null-safe.
      const sameTeam =
        (p.division_code ?? null) === (divisionCode ?? null) &&
        (p.team_name ?? null) === (teamName ?? null);

      if (sameTeam) {
        hardClashes.push(p);
      } else {
        // Different team — soft warning if same or adjacent age group.
        if (isAdjacentOrSameAgeGroup(ageGroup, p.age_group)) {
          softWarnings.push(p);
        }
      }
    }
  } else {
    // Backward-compat: cohort-based logic (used by widget, no team info available).
    const requestedAgeGroup =
      typeof yearOfBirth === "number" && Number.isFinite(yearOfBirth)
        ? seasonYear - yearOfBirth
        : undefined;

    if (requestedAgeGroup === undefined) {
      hardClashes = allNumberHolders;
    } else {
      const window = Math.max(0, cohortWindowYears);
      hardClashes = allNumberHolders.filter((p) => {
        if (typeof p.year_of_birth !== "number" || !Number.isFinite(p.year_of_birth))
          return false;
        const playerAge = seasonYear - p.year_of_birth;
        return Math.abs(playerAge - requestedAgeGroup) <= window;
      });
    }
  }

  // ── Inventory check ──────────────────────────────────────────────────────────
  const { data: inventoryRows, error: invError } = await supabase
    .from("inventory")
    .select("size, status")
    .eq("club_id", clubId)
    .eq("jersey_number", jerseyNumber);

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
      statusMessage = hasStock
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
}): Promise<NumberSuggestion[]> {
  const limit = Math.max(1, input.limit ?? 10);
  const cohortWindowYears = Math.max(0, input.cohortWindowYears ?? 0);
  const adjacentCohortYears = Math.max(0, input.adjacentCohortYears ?? 1);
  const hasTeamContext =
    input.divisionCode !== undefined ||
    input.teamName !== undefined ||
    input.ageGroup !== undefined;

  const targetAge = input.seasonYear - input.yearOfBirth;

  const { data: invRows, error: invErr } = await supabase
    .from("inventory")
    .select("jersey_number")
    .eq("club_id", input.clubId)
    .eq("status", STATUS_AVAILABLE)
    .eq("size", input.size);

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

  const yobForAge = (age: number) => input.seasonYear - age;
  const blockedNums = new Set<number>();

  if (hasTeamContext) {
    // Team-aware: block numbers worn by players on the SAME team.
    const sameTeamQuery = supabase
      .from("players")
      .select("final_shirt")
      .eq("club_id", input.clubId)
      .in("final_shirt", candidateNums);

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
    // Cohort-based blocking (backward compat — widget path).
    const minAgeBlock = targetAge - cohortWindowYears;
    const maxAgeBlock = targetAge + cohortWindowYears;
    const minYobBlock = yobForAge(maxAgeBlock);
    const maxYobBlock = yobForAge(minAgeBlock);

    const { data: playersBlock, error: pbErr } = await supabase
      .from("players")
      .select("final_shirt, year_of_birth")
      .eq("club_id", input.clubId)
      .in("final_shirt", candidateNums)
      .gte("year_of_birth", minYobBlock)
      .lte("year_of_birth", maxYobBlock);

    if (pbErr) {
      console.error("players block query error", pbErr);
      throw new Error("Failed to load player clash data for ranked suggestions.");
    }
    for (const p of playersBlock ?? []) {
      const n = Number((p as any).final_shirt);
      if (Number.isFinite(n)) blockedNums.add(n);
    }
  }

  // Reservation block (same in both paths)
  const { data: resBlock, error: rbErr } = await supabase
    .from("pending_allocations")
    .select("jersey_number, year_of_birth, season_year, expires_at, status, size")
    .eq("club_id", input.clubId)
    .eq("size", input.size)
    .eq("season_year", input.seasonYear)
    .eq("status", "reserved");

  if (rbErr) {
    console.error("reservations block query error", rbErr);
    throw new Error("Failed to load reservation data for ranked suggestions.");
  }

  const now = Date.now();
  if (!hasTeamContext) {
    // Only apply reservation blocking in cohort mode (widget path)
    const minAgeBlock = targetAge - cohortWindowYears;
    const maxAgeBlock = targetAge + cohortWindowYears;
    for (const r of resBlock ?? []) {
      const expiresAt = Date.parse(String((r as any).expires_at));
      if (!Number.isFinite(expiresAt) || expiresAt <= now) continue;
      const yob = Number((r as any).year_of_birth);
      const n = Number((r as any).jersey_number);
      if (!Number.isFinite(yob) || !Number.isFinite(n)) continue;
      const age = input.seasonYear - yob;
      if (age >= minAgeBlock && age <= maxAgeBlock) blockedNums.add(n);
    }
  }

  // Adjacent cohort penalty: penalise numbers used in nearby age groups (different team).
  const adjCounts = new Map<number, number>();

  if (hasTeamContext) {
    // Fetch players in adjacent age groups (using age_group column)
    const adjacentGroups = AGE_GROUP_ORDER.filter((ag) => {
      const reqIdx = ageGroupIndex(input.ageGroup);
      const agIdx = ageGroupIndex(ag);
      return reqIdx !== -1 && agIdx !== -1 && Math.abs(reqIdx - agIdx) <= 1;
    });

    if (adjacentGroups.length > 0) {
      const { data: adjPlayers } = await supabase
        .from("players")
        .select("final_shirt, division_code, team_name")
        .eq("club_id", input.clubId)
        .in("final_shirt", candidateNums)
        .in("age_group", adjacentGroups);

      for (const p of adjPlayers ?? []) {
        const n = Number((p as any).final_shirt);
        if (!Number.isFinite(n)) continue;
        // Only penalise if NOT on the same team
        const sameTeam =
          ((p as any).division_code ?? null) === (input.divisionCode ?? null) &&
          ((p as any).team_name ?? null) === (input.teamName ?? null);
        if (!sameTeam) {
          adjCounts.set(n, (adjCounts.get(n) ?? 0) + 1);
        }
      }
    }
  } else {
    // Original adjacent cohort penalty (YOB-based, widget path)
    const minAgeAdj = targetAge - adjacentCohortYears;
    const maxAgeAdj = targetAge + adjacentCohortYears;
    const minYobAdj = yobForAge(maxAgeAdj);
    const maxYobAdj = yobForAge(minAgeAdj);

    const { data: playersAdj, error: paErr } = await supabase
      .from("players")
      .select("final_shirt")
      .eq("club_id", input.clubId)
      .in("final_shirt", candidateNums)
      .gte("year_of_birth", minYobAdj)
      .lte("year_of_birth", maxYobAdj);

    if (paErr) {
      console.error("players adjacent query error", paErr);
      throw new Error("Failed to load adjacent cohort usage for ranking.");
    }
    for (const p of playersAdj ?? []) {
      const n = Number((p as any).final_shirt);
      if (!Number.isFinite(n)) continue;
      adjCounts.set(n, (adjCounts.get(n) ?? 0) + 1);
    }

    for (const r of resBlock ?? []) {
      const expiresAt = Date.parse(String((r as any).expires_at));
      if (!Number.isFinite(expiresAt) || expiresAt <= now) continue;
      const yob = Number((r as any).year_of_birth);
      const n = Number((r as any).jersey_number);
      if (!Number.isFinite(yob) || !Number.isFinite(n)) continue;
      const age = input.seasonYear - yob;
      if (age >= minAgeAdj && age <= maxAgeAdj) {
        adjCounts.set(n, (adjCounts.get(n) ?? 0) + 1);
      }
    }
  }

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
}): Promise<{
  found: boolean;
  playerId?: string;
  matchedFirstName?: string;
  matchedLastName?: string;
  currentJerseyNumber?: number | null;
  previousInventoryId?: string | null;
}> {
  const { clubId, firstName, lastName, yearOfBirth, ageGroup } = params;
  const firstTrimmed = firstName.trim();
  const lastTrimmed = lastName.trim();

  const cohortFilter = ageGroup
    ? `year_of_birth.eq.${yearOfBirth},age_group.eq.${ageGroup}`
    : `year_of_birth.eq.${yearOfBirth}`;

  const { data: exact } = await supabase
    .from("players")
    .select("id, first_name, last_name, final_shirt, year_of_birth")
    .eq("club_id", clubId)
    .ilike("first_name", firstTrimmed)
    .ilike("last_name", lastTrimmed)
    .or(cohortFilter)
    .limit(1);

  let player = (exact ?? [])[0] as any;

  if (!player) {
    const { data: fuzzy } = await supabase
      .from("players")
      .select("id, first_name, last_name, final_shirt, year_of_birth")
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
    p_expires_minutes: input.expiresMinutes ?? 15,
    p_player_first_name: input.playerFirstName ?? null,
    p_player_last_name: input.playerLastName ?? null,
    p_is_new_player: input.isNewPlayer ?? null,
    p_keep_existing_jersey: input.keepExistingJersey ?? null,
    p_previous_jersey_number: input.previousJerseyNumber ?? null,
    p_previous_inventory_id: input.previousInventoryId ?? null,
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
