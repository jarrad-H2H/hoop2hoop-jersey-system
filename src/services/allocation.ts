// FILE: src/services/allocation.ts
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
  seasonYear?: number;      // optional explicit season year
  yearOfBirth?: number;     // player's YOB
  cohortWindowYears?: number; // e.g. 1 => ±1 age band (we'll use it as a tolerance)
}

export interface SmartCheckResult {
  clashes: ClashPlayer[];
  stockBySize: StockBySize[];
  statusMessage: string;
}

/**
 * Cohort-aware clash + stock check for a given number in a club.
 *
 * If yearOfBirth is provided:
 *   - We compute an "age group" as (seasonYear - yearOfBirth).
 *   - Only players in the same age band (±cohortWindowYears) are treated as clashes.
 *   - Players with null year_of_birth are ignored for YOB-based clashes.
 *
 * If yearOfBirth is NOT provided:
 *   - Any player in the club with that number is treated as a clash.
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

  // Default season year = current calendar year if not provided
  const seasonYear =
    typeof optSeasonYear === "number" && Number.isFinite(optSeasonYear)
      ? optSeasonYear
      : new Date().getFullYear();

  // Compute requested age group if YOB provided
  const requestedAgeGroup =
    typeof yearOfBirth === "number" && Number.isFinite(yearOfBirth)
      ? seasonYear - yearOfBirth
      : undefined;

  // 1) Load all players in this club currently using this jersey number
  const { data: clashRows, error: clashError } = await supabase
    .from("players")
    .select(
      "id, first_name, last_name, team_id, final_shirt, year_of_birth"
    )
    .eq("club_id", clubId)
    .eq("final_shirt", jerseyNumber);

  if (clashError) {
    console.error("smartCheckNumber: clash query error", clashError);
    throw new Error("Failed to check clashes for this number.");
  }

  const allNumberHolders = (clashRows ?? []) as ClashPlayer[];

  // 2) Apply cohort logic
  let effectiveClashes: ClashPlayer[];

  if (requestedAgeGroup === undefined) {
    // No YOB → treat ANY holder in the club as a clash
    effectiveClashes = allNumberHolders;
  } else {
    const window = Math.max(0, cohortWindowYears);
    effectiveClashes = allNumberHolders.filter((p) => {
      if (
        typeof p.year_of_birth !== "number" ||
        !Number.isFinite(p.year_of_birth)
      ) {
        // No YOB stored on existing player → ignore them for cohort-specific clashes
        return false;
      }
      const playerAgeGroup = seasonYear - p.year_of_birth;
      return Math.abs(playerAgeGroup - requestedAgeGroup) <= window;
    });
  }

  // 3) Build stock summary for this club + number
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
    const sizeLabel = String(row.size ?? "");
    if (!sizeLabel) continue;

    if (row.status === "Available") {
      stockMap.set(sizeLabel, (stockMap.get(sizeLabel) ?? 0) + 1);
    }
  }

  const stockBySize: StockBySize[] = Array.from(stockMap.entries()).map(
    ([size, count]) => ({ size, count })
  );

  // 4) Status message for UI
  let statusMessage = "";

  const hasClash = effectiveClashes.length > 0;
  const hasStock = stockBySize.length > 0;

  if (requestedAgeGroup !== undefined) {
    // Cohort-aware wording
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
    // Fallback wording when YOB isn't known
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
 * Suggest clash-free numbers with stock for a given club + size.
 *
 * – Finds numbers that have Available stock for the given size.
 * – For each, runs smartCheckNumber with NO YOB (club-wide clash safety).
 * – Returns up to `limit` results sorted by jersey number.
 */
export async function suggestNumbersForClub(
  clubId: string,
  size: string,
  limit: number = 10
): Promise<NumberSuggestion[]> {
  // 1) Get available inventory rows for this size
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
    // Allow 0 as a valid jersey number
    if (!Number.isFinite(n)) return;
    counts.set(n, (counts.get(n) ?? 0) + 1);
  });

  const candidates = Array.from(counts.entries())
    .map(([jersey_number, total_stock]) => ({ jersey_number, total_stock }))
    .sort((a, b) => a.jersey_number - b.jersey_number);

  const results: NumberSuggestion[] = [];

  // 2) For each candidate, run clash check with NO YOB (club-wide clash)
  for (const candidate of candidates) {
    const { clashes } = await smartCheckNumber(
      clubId,
      candidate.jersey_number,
      {}
    );

    if (clashes.length === 0) {
      results.push(candidate);
    }
    if (results.length >= limit) break;
  }

  return results;
}

/**
 * Reserve a specific inventory row for a club/number/size.
 *
 * – Finds the first Available row.
 * – Marks it Allocated + timestamps.
 */
export async function allocateNumberForClub(
  clubId: string,
  jerseyNumber: number,
  size: string
): Promise<{ success: boolean; inventoryId?: string; message?: string }> {
  // 1) Find an available row
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

  const inventoryId = row.id as string;

  // 2) Mark it allocated
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
 * Log allocation events into the `allocations` table.
 *
 * This is the single helper used by admin allocations, swaps, end-allocation
 * and warehouse returns, so everything flows into one audit table.
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
      typeof payload.jersey_number === "number"
        ? payload.jersey_number
        : null,
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
 * Return a jersey to stock for a given club/number/size.
 *
 * – Finds an inventory row for that jersey that is currently Allocated OR Available.
 * – Marks it Available and clears any player linkage.
 * – Logs a "return" allocation event (without a player_id).
 */
export async function returnJerseyToStock(
  clubId: string,
  jerseyNumber: number,
  size: string
): Promise<{ success: boolean; message: string }> {
  // 1) Find a matching row (prefer Allocated, but fall back to Available)
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

  const inventoryId = row.id as string;

  // 2) Mark it Available + clear any allocation metadata
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

  // 3) Log event – warehouse return, no player_id
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
