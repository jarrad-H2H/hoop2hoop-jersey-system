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
  yearOfBirth?: number;
  cohortWindowYears?: number; // e.g. 1 => ±1 year
}

export interface SmartCheckResult {
  clashes: ClashPlayer[];
  stockBySize: StockBySize[];
  statusMessage: string;
}

/**
 * Helper – load players in a club who currently have a given jersey number.
 */
async function loadPlayersWithNumber(
  clubId: string,
  jerseyNumber: number
): Promise<ClashPlayer[]> {
  const { data, error } = await supabase
    .from("players")
    .select(
      "id, first_name, last_name, team_id, final_shirt, year_of_birth"
    )
    .eq("club_id", clubId)
    .eq("final_shirt", jerseyNumber);

  if (error) {
    console.error("loadPlayersWithNumber error", error);
    throw new Error("Failed to load players for clash check.");
  }

  return (data ?? []) as ClashPlayer[];
}

/**
 * Helper – load inventory rows for a given club + number that are Available.
 */
async function loadInventoryForNumber(
  clubId: string,
  jerseyNumber: number
): Promise<StockBySize[]> {
  const { data, error } = await supabase
    .from("inventory")
    .select("size")
    .eq("club_id", clubId)
    .eq("status", "Available")
    .eq("jersey_number", jerseyNumber);

  if (error) {
    console.error("loadInventoryForNumber error", error);
    throw new Error("Failed to load inventory for this number.");
  }

  const sizeCounts = new Map<string, number>();
  (data ?? []).forEach((row: any) => {
    const size = String(row.size ?? "");
    if (!size) return;
    sizeCounts.set(size, (sizeCounts.get(size) ?? 0) + 1);
  });

  return Array.from(sizeCounts.entries()).map(([size, count]) => ({
    size,
    count,
  }));
}

/**
 * Smart clash + stock check for a given number in a club.
 *
 * – Uses YOB cohort logic if provided:
 *   - If you pass yearOfBirth, we only consider clashes where the other player
 *     ALSO has year_of_birth AND is within ±cohortWindowYears.
 *   - Players with null year_of_birth are ignored for YOB-based clashes,
 *     so missing data doesn’t block everything.
 * – If you don't pass yearOfBirth, all players with that number are treated as clashes.
 */
export async function smartCheckNumber(
  clubId: string,
  jerseyNumber: number,
  options: SmartCheckOptions = {}
): Promise<SmartCheckResult> {
  const { yearOfBirth, cohortWindowYears = 1 } = options;

  // 1) Load raw players with this number
  const players = await loadPlayersWithNumber(clubId, jerseyNumber);

  let clashes: ClashPlayer[] = [];

  if (yearOfBirth && Number.isFinite(yearOfBirth)) {
    const minY = yearOfBirth - cohortWindowYears;
    const maxY = yearOfBirth + cohortWindowYears;

    // Only treat players with a known YOB in this band as clashes.
    clashes = players.filter((p) => {
      if (p.year_of_birth == null) return false; // ignore unknown YOB
      return p.year_of_birth >= minY && p.year_of_birth <= maxY;
    });
  } else {
    // No YOB provided → any player with that number is treated as a clash
    clashes = players;
  }

  // 2) Load inventory stock for this number (by size)
  const stockBySize = await loadInventoryForNumber(clubId, jerseyNumber);

  // 3) Status message
  let statusMessage = "";
  if (clashes.length === 0 && stockBySize.length === 0) {
    statusMessage =
      "No clashes found and no stock in this club for this number.";
  } else if (clashes.length === 0 && stockBySize.length > 0) {
    statusMessage = "No clashes found and stock is available.";
  } else if (clashes.length > 0 && stockBySize.length === 0) {
    statusMessage =
      "There are clashes in this cohort and no available stock for this number.";
  } else {
    statusMessage =
      "There are cohort clashes and some inventory in this number. Consider using the suggestion tool.";
  }

  return {
    clashes,
    stockBySize,
    statusMessage,
  };
}

/**
 * Suggest clash-free numbers that have available stock for a given size.
 *
 * – Looks at inventory for that club + size.
 * – For each candidate jersey number, runs a light version of the clash logic.
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
    if (!Number.isFinite(n)) return;
    counts.set(n, (counts.get(n) ?? 0) + 1);
  });

  const candidates = Array.from(counts.entries())
    .map(([jersey_number, total_stock]) => ({ jersey_number, total_stock }))
    .sort((a, b) => a.jersey_number - b.jersey_number);

  const results: NumberSuggestion[] = [];

  // 2) For each candidate, run clash check with NO YOB (club-wide clash safety)
  for (const candidate of candidates) {
    const { clashes } = await smartCheckNumber(clubId, candidate.jersey_number, {
      // No yearOfBirth → "hard" club-wide clash check
    });

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
