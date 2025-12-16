import { supabase } from "./supabase";

/**
 * Types shared with the React components
 */
export interface ClashPlayer {
  id: string;
  first_name: string;
  last_name: string;
  team_id: string | null;
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
}

export interface SmartCheckOptions {
  seasonYear?: number;
  yearOfBirth?: number;
  cohortWindowYears?: number;
}

export interface SmartCheckResult {
  clashes: ClashPlayer[];
  stockBySize: StockBySize[];
  statusMessage: string;
}

/**
 * Cohort-aware clash + stock check for a given number in a club.
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
  } = options;

  const seasonYear =
    typeof optSeasonYear === "number" && Number.isFinite(optSeasonYear)
      ? optSeasonYear
      : new Date().getFullYear();

  const requestedAgeGroup =
    typeof yearOfBirth === "number" && Number.isFinite(yearOfBirth)
      ? seasonYear - yearOfBirth
      : undefined;

  const { data: clashRows, error: clashError } = await supabase
    .from("players")
    .select("id, first_name, last_name, team_id, final_shirt, year_of_birth")
    .eq("club_id", clubId)
    .eq("final_shirt", jerseyNumber);

  if (clashError) {
    console.error("smartCheckNumber: clash query error", clashError);
    throw new Error("Failed to check clashes for this number.");
  }

  const allNumberHolders = (clashRows ?? []) as ClashPlayer[];

  let effectiveClashes: ClashPlayer[];

  if (requestedAgeGroup === undefined) {
    effectiveClashes = allNumberHolders;
  } else {
    const window = Math.max(0, cohortWindowYears);
    effectiveClashes = allNumberHolders.filter((p) => {
      if (typeof p.year_of_birth !== "number" || !Number.isFinite(p.year_of_birth)) {
        return false;
      }
      const playerAgeGroup = seasonYear - p.year_of_birth;
      return Math.abs(playerAgeGroup - requestedAgeGroup) <= window;
    });
  }

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
    if ((row as any).status === "Available") {
      stockMap.set(sizeLabel, (stockMap.get(sizeLabel) ?? 0) + 1);
    }
  }

  const stockBySize: StockBySize[] = Array.from(stockMap.entries()).map(
    ([size, count]) => ({ size, count })
  );

  const hasClash = effectiveClashes.length > 0;
  const hasStock = stockBySize.length > 0;

  let statusMessage = "";

  if (requestedAgeGroup !== undefined) {
    if (hasClash && hasStock) {
      statusMessage =
        "This number is already used in the same age group for this club, but inventory exists. Proceed with caution.";
    } else if (hasClash && !hasStock) {
      statusMessage =
        "This number clashes in the same age group and there is no available stock.";
    } else if (!hasClash && hasStock) {
      statusMessage =
        "No cohort clash found for this number and there is available stock.";
    } else {
      statusMessage =
        "No cohort clash found, but there is no available inventory for this number in this club.";
    }
  } else {
    if (hasClash && hasStock) {
      statusMessage =
        "This number is already used in this club, but inventory exists. Proceed with caution.";
    } else if (hasClash && !hasStock) {
      statusMessage =
        "This number is already used in this club and there is no available stock.";
    } else if (!hasClash && hasStock) {
      statusMessage =
        "This number is not currently used in this club and there is available stock.";
    } else {
      statusMessage =
        "This number is not currently used in this club, but there is no available inventory for it.";
    }
  }

  return {
    clashes: effectiveClashes,
    stockBySize,
    statusMessage,
  };
}

/**
 * Legacy: Suggest clash-free numbers with stock for a given club + size (club-wide, no YOB).
 * Kept to avoid breaking any older callers.
 */
export async function suggestNumbersForClub(
  clubId: string,
  size: string,
  limit: number = 10
): Promise<NumberSuggestion[]> {
  const { data, error } = await supabase
    .from("inventory")
    .select("jersey_number")
    .eq("club_id", clubId)
    .eq("status", "Available")
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
    const { clashes } = await smartCheckNumber(clubId, candidate.jersey_number, {});
    if (clashes.length === 0) {
      results.push(candidate);
    }
    if (results.length >= limit) break;
  }

  return results;
}

/**
 * NEW: cohort + size suggestions, with optional team-aware fallback
 *
 * Primary suggestions:
 * - Available stock in selected size
 * - No same-age-group clash
 *
 * If none exist and teamId provided:
 * Fallback suggestions:
 * - Allow same-age clashes ONLY if those clashes are in DIFFERENT teams
 */
export async function suggestNumbersForCohortSizeTeam(params: {
  clubId: string;
  size: string;
  seasonYear: number;
  yearOfBirth: number;
  teamId?: string | null;
  limit?: number;
}): Promise<{ suggestions: NumberSuggestion[]; usedTeamFallback: boolean }> {
  const { clubId, size, seasonYear, yearOfBirth, teamId, limit = 10 } = params;

  // 1) Count stock depth per number for the selected size
  const { data: inv, error: invError } = await supabase
    .from("inventory")
    .select("jersey_number")
    .eq("club_id", clubId)
    .eq("status", "Available")
    .eq("size", size);

  if (invError) {
    console.error("suggestNumbersForCohortSizeTeam inventory error", invError);
    throw new Error("Failed to load inventory for suggestions.");
  }

  const stockCount = new Map<number, number>();
  (inv ?? []).forEach((row: any) => {
    const n = Number(row.jersey_number);
    if (!Number.isFinite(n)) return;
    stockCount.set(n, (stockCount.get(n) ?? 0) + 1);
  });

  const candidateNumbers = Array.from(stockCount.keys()).sort((a, b) => a - b);

  // 2) Load all player holders for these numbers in one go (efficiency + consistent logic)
  const { data: holders, error: holdersError } = await supabase
    .from("players")
    .select("final_shirt, year_of_birth, team_id")
    .eq("club_id", clubId)
    .in("final_shirt", candidateNumbers);

  if (holdersError) {
    console.error("suggestNumbersForCohortSizeTeam holders error", holdersError);
    throw new Error("Failed to load player holders for suggestions.");
  }

  const targetAge = seasonYear - yearOfBirth;

  type Hold = { final_shirt: number | null; year_of_birth: number | null; team_id: string | null };
  const holderRows = (holders ?? []) as Hold[];

  const sameAgeCountByNumber = new Map<number, number>();
  const sameAgeSameTeamCountByNumber = new Map<number, number>();
  const adjacentAgeCountByNumber = new Map<number, number>();
  const totalHoldersByNumber = new Map<number, number>();

  for (const h of holderRows) {
    const n = typeof h.final_shirt === "number" ? h.final_shirt : null;
    if (n === null || !Number.isFinite(n)) continue;

    totalHoldersByNumber.set(n, (totalHoldersByNumber.get(n) ?? 0) + 1);

    if (typeof h.year_of_birth !== "number" || !Number.isFinite(h.year_of_birth)) {
      continue;
    }

    const age = seasonYear - h.year_of_birth;

    if (age === targetAge) {
      sameAgeCountByNumber.set(n, (sameAgeCountByNumber.get(n) ?? 0) + 1);
      if (teamId && h.team_id && h.team_id === teamId) {
        sameAgeSameTeamCountByNumber.set(
          n,
          (sameAgeSameTeamCountByNumber.get(n) ?? 0) + 1
        );
      }
    } else if (Math.abs(age - targetAge) === 1) {
      adjacentAgeCountByNumber.set(n, (adjacentAgeCountByNumber.get(n) ?? 0) + 1);
    }
  }

  // 3) Build primary list (no same-age clashes)
  const primary = candidateNumbers
    .map((n) => ({
      jersey_number: n,
      total_stock: stockCount.get(n) ?? 0,
      sameAge: sameAgeCountByNumber.get(n) ?? 0,
      adjacent: adjacentAgeCountByNumber.get(n) ?? 0,
      popularity: totalHoldersByNumber.get(n) ?? 0,
    }))
    .filter((x) => x.sameAge === 0);

  // Ranking: lowest adjacent pressure, lowest popularity, highest stock depth, lowest number
  primary.sort((a, b) => {
    if (a.adjacent !== b.adjacent) return a.adjacent - b.adjacent;
    if (a.popularity !== b.popularity) return a.popularity - b.popularity;
    if (a.total_stock !== b.total_stock) return b.total_stock - a.total_stock;
    return a.jersey_number - b.jersey_number;
  });

  if (primary.length > 0) {
    return {
      suggestions: primary.slice(0, limit).map((x) => ({
        jersey_number: x.jersey_number,
        total_stock: x.total_stock,
      })),
      usedTeamFallback: false,
    };
  }

  // 4) Team fallback - only if teamId provided
  if (!teamId) {
    return { suggestions: [], usedTeamFallback: false };
  }

  const fallback = candidateNumbers
    .map((n) => ({
      jersey_number: n,
      total_stock: stockCount.get(n) ?? 0,
      sameAgeSameTeam: sameAgeSameTeamCountByNumber.get(n) ?? 0,
      adjacent: adjacentAgeCountByNumber.get(n) ?? 0,
      popularity: totalHoldersByNumber.get(n) ?? 0,
    }))
    // allow same-age clashes ONLY if not on same team
    .filter((x) => x.sameAgeSameTeam === 0);

  fallback.sort((a, b) => {
    if (a.adjacent !== b.adjacent) return a.adjacent - b.adjacent;
    if (a.popularity !== b.popularity) return a.popularity - b.popularity;
    if (a.total_stock !== b.total_stock) return b.total_stock - a.total_stock;
    return a.jersey_number - b.jersey_number;
  });

  return {
    suggestions: fallback.slice(0, limit).map((x) => ({
      jersey_number: x.jersey_number,
      total_stock: x.total_stock,
    })),
    usedTeamFallback: true,
  };
}

/**
 * Reserve a specific inventory row for a club/number/size.
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
    .eq("status", "Available")
    .eq("jersey_number", jerseyNumber)
    .eq("size", size)
    .limit(1);

  if (error) {
    console.error("allocateNumberForClub select error", error);
    return {
      success: false,
      message: "Failed to read inventory while allocating.",
    };
  }

  const row = (data ?? [])[0];
  if (!row) {
    return {
      success: false,
      message: "No available inventory row for that size/number.",
    };
  }

  const inventoryId = (row as any).id as string;

  const { error: updateError } = await supabase
    .from("inventory")
    .update({
      status: "Allocated",
      allocation_date: new Date().toISOString(),
    })
    .eq("id", inventoryId);

  if (updateError) {
    console.error("allocateNumberForClub update error", updateError);
    return {
      success: false,
      message: "Failed to mark inventory row as allocated.",
    };
  }

  return { success: true, inventoryId };
}

/**
 * Log allocation events into `allocations`.
 */
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
    jersey_number:
      typeof payload.jersey_number === "number" ? payload.jersey_number : null,
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

/**
 * Return a jersey to stock.
 */
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
    .in("status", ["Allocated", "Available"])
    .limit(1);

  if (error) {
    console.error("returnJerseyToStock select error", error);
    return {
      success: false,
      message: "Failed to read inventory while returning jersey.",
    };
  }

  const row = (data ?? [])[0];
  if (!row) {
    return {
      success: false,
      message:
        "No matching inventory row found for that size/number. Nothing to return.",
    };
  }

  const inventoryId = (row as any).id as string;

  const { error: updateError } = await supabase
    .from("inventory")
    .update({
      status: "Available",
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
    previous_jersey_number: null,
    previous_size: null,
    note: "Warehouse return to stock",
  });

  return {
    success: true,
    message: `Jersey #${jerseyNumber} (${size}) has been marked back as Available for this club.`,
  };
}
