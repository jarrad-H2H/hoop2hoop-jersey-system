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
  seasonYear?: number;
  yearOfBirth?: number;
  cohortWindowYears?: number;
}

export interface SmartCheckResult {
  clashes: ClashPlayer[];
  stockBySize: StockBySize[];
  statusMessage: string;
}

export interface PendingAllocationRow {
  id: string;
  club_id: string;
  inventory_id: string;
  jersey_number: number;
  size: string;
  season_year: number;
  year_of_birth: number;
  team_id: string | null;
  status: "reserved" | "purchased" | "expired" | "cancelled" | "reconciled";
  created_at: string;
  expires_at: string;
}

/**
 * Cohort-aware clash + stock check for a given number in a club.
 */
export async function smartCheckNumber(
  clubId: string,
  jerseyNumber: number,
  options: SmartCheckOptions = {}
): Promise<SmartCheckResult> {
  const { seasonYear: optSeasonYear, yearOfBirth, cohortWindowYears = 0 } = options;

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

  let effectiveClashes: ClashPlayer[] = [];
  if (requestedAgeGroup === undefined) {
    effectiveClashes = allNumberHolders;
  } else {
    const window = Math.max(0, cohortWindowYears);
    effectiveClashes = allNumberHolders.filter((p) => {
      if (typeof p.year_of_birth !== "number" || !Number.isFinite(p.year_of_birth)) return false;
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

  const stockBySize: StockBySize[] = Array.from(stockMap.entries()).map(([size, count]) => ({
    size,
    count,
  }));

  const hasClash = effectiveClashes.length > 0;
  const hasStock = stockBySize.length > 0;

  let statusMessage = "";
  if (requestedAgeGroup !== undefined) {
    if (hasClash && hasStock) {
      statusMessage =
        "This number is already used in the same age group for this club, but inventory exists. Proceed with caution.";
    } else if (hasClash && !hasStock) {
      statusMessage = "This number clashes in the same age group and there is no available stock.";
    } else if (!hasClash && hasStock) {
      statusMessage = "No cohort clash found for this number and there is available stock.";
    } else {
      statusMessage = "No cohort clash found, but there is no available inventory for this number in this club.";
    }
  } else {
    if (hasClash && hasStock) {
      statusMessage = "This number is already used in this club, but inventory exists. Proceed with caution.";
    } else if (hasClash && !hasStock) {
      statusMessage = "This number is already used in this club and there is no available stock.";
    } else if (!hasClash && hasStock) {
      statusMessage = "This number is not currently used in this club and there is available stock.";
    } else {
      statusMessage = "This number is not currently used in this club, but there is no available inventory for it.";
    }
  }

  return { clashes: effectiveClashes, stockBySize, statusMessage };
}

/**
 * Suggest clash-free numbers with stock for a given club + size.
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
    if (!Number.isFinite(n)) return; // allow 0
    counts.set(n, (counts.get(n) ?? 0) + 1);
  });

  const candidates = Array.from(counts.entries())
    .map(([jersey_number, total_stock]) => ({ jersey_number, total_stock }))
    .sort((a, b) => a.jersey_number - b.jersey_number);

  const results: NumberSuggestion[] = [];

  for (const candidate of candidates) {
    const { clashes } = await smartCheckNumber(clubId, candidate.jersey_number, {});
    if (clashes.length === 0) results.push(candidate);
    if (results.length >= limit) break;
  }

  return results;
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
      status: "Allocated",
      allocation_date: new Date().toISOString(),
    })
    .eq("id", inventoryId);

  if (updateError) {
    console.error("allocateNumberForClub update error", updateError);
    return { success: false, message: "Failed to mark inventory row as allocated." };
  }

  return { success: true, inventoryId };
}

/**
 * Log allocation events into the allocations table.
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
    jersey_number: typeof payload.jersey_number === "number" ? payload.jersey_number : null,
    size: payload.size ?? null,
    previous_jersey_number:
      typeof payload.previous_jersey_number === "number" ? payload.previous_jersey_number : null,
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
 * Create a pending allocation record (reservation) in Supabase.
 */
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
 * One-call helper for the demo widget:
 * - allocate inventory row (hard lock)
 * - create pending allocation record
 * - log allocation event
 */
export async function reserveNumberForPurchase(input: {
  clubId: string;
  jerseyNumber: number;
  size: string;
  seasonYear: number;
  yearOfBirth: number;
  teamId?: string | null;
  expiresMinutes?: number;
}): Promise<{
  success: boolean;
  message: string;
  pendingAllocationId?: string;
  inventoryId?: string;
}> {
  const alloc = await allocateNumberForClub(input.clubId, input.jerseyNumber, input.size);
  if (!alloc.success || !alloc.inventoryId) {
    return { success: false, message: alloc.message ?? "Failed to reserve inventory." };
  }

  const pending = await createPendingAllocation({
    clubId: input.clubId,
    inventoryId: alloc.inventoryId,
    jerseyNumber: input.jerseyNumber,
    size: input.size,
    seasonYear: input.seasonYear,
    yearOfBirth: input.yearOfBirth,
    teamId: input.teamId ?? null,
    expiresMinutes: input.expiresMinutes,
  });

  if (!pending.success || !pending.row) {
    return {
      success: false,
      message:
        "Inventory was reserved, but pending allocation record failed to save. (You may want to return the jersey to stock.)",
      inventoryId: alloc.inventoryId,
    };
  }

  await logAllocationEvent({
    allocation_type: "new",
    club_id: input.clubId,
    player_id: null,
    jersey_number: input.jerseyNumber,
    size: input.size,
    previous_jersey_number: null,
    previous_size: null,
    note: "Reserved via widget demo (pending allocation)",
  });

  return {
    success: true,
    message: `Reserved jersey #${input.jerseyNumber} (${input.size}). Pending allocation created.`,
    pendingAllocationId: pending.row.id,
    inventoryId: alloc.inventoryId,
  };
}

/**
 * Return a jersey to stock (used by admin/warehouse).
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
    return { success: false, message: "Failed to read inventory while returning jersey." };
  }

  const row = (data ?? [])[0];
  if (!row) {
    return {
      success: false,
      message: "No matching inventory row found for that size/number. Nothing to return.",
    };
  }

  const inventoryId = row.id as string;

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
    return { success: false, message: "Failed to update inventory while returning jersey." };
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
