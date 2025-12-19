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
  score?: number; // lower is better (ranked suggestions only)
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
  size: string;
  season_year: number;
  year_of_birth: number;
  status: "reserved" | "purchased" | "expired" | "cancelled" | "reconciled";
  created_at: string;
  expires_at: string;

  // Optional columns (safe if they exist)
  team_id?: string | null;
  order_id?: string | null;
  order_number?: string | null;
  shopify_line_item_id?: string | null;
  purchased_at?: string | null;
  cancelled_at?: string | null;
  expired_at?: string | null;
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
 * Existing (basic) suggestion function - kept for backward compatibility.
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
 * NEW: Ranked suggestions (size-aware + cohort-aware + reservation-aware).
 *
 * IMPORTANT: Reservation blocking is done via pending_allocations.inventory_id
 * so we do NOT rely on pending_allocations having jersey_number columns.
 */
export async function suggestNumbersForClubRanked(input: {
  clubId: string;
  size: string;
  seasonYear: number;
  yearOfBirth: number;
  limit?: number;
  cohortWindowYears?: number; // default 0 (same age group only)
  adjacentCohortYears?: number; // default 1
}): Promise<NumberSuggestion[]> {
  const limit = Math.max(1, input.limit ?? 10);
  const cohortWindowYears = Math.max(0, input.cohortWindowYears ?? 0);
  const adjacentCohortYears = Math.max(0, input.adjacentCohortYears ?? 1);

  const targetAge = input.seasonYear - input.yearOfBirth;
  const yobForAge = (age: number) => input.seasonYear - age;

  // 1) Available inventory in this size -> candidate counts
  const { data: invRows, error: invErr } = await supabase
    .from("inventory")
    .select("id, jersey_number")
    .eq("club_id", input.clubId)
    .eq("status", "Available")
    .eq("size", input.size);

  if (invErr) {
    console.error("suggestNumbersForClubRanked inventory error", invErr);
    throw new Error("Failed to load inventory for ranked suggestions.");
  }

  const stockCounts = new Map<number, number>();
  for (const r of invRows ?? []) {
    const n = Number((r as any).jersey_number);
    if (!Number.isFinite(n)) continue; // allow 0
    stockCounts.set(n, (stockCounts.get(n) ?? 0) + 1);
  }

  const candidateNums = Array.from(stockCounts.keys());
  if (candidateNums.length === 0) return [];

  // 2) Players in same cohort window (hard block list)
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

  const blockedNums = new Set<number>();
  for (const p of playersBlock ?? []) {
    const n = Number((p as any).final_shirt);
    if (!Number.isFinite(n)) continue;
    blockedNums.add(n);
  }

  // 3) Reservations in same cohort window should also block (inventory_id -> jersey_number)
  const { data: resRows, error: rbErr } = await supabase
    .from("pending_allocations")
    .select("inventory_id, year_of_birth, expires_at, status, size, season_year")
    .eq("club_id", input.clubId)
    .eq("size", input.size)
    .eq("season_year", input.seasonYear)
    .eq("status", "reserved");

  if (rbErr) {
    console.error("reservations block query error", rbErr);
    throw new Error("Failed to load reservation data for ranked suggestions.");
  }

  const now = Date.now();
  const activeRes = (resRows ?? []).filter((r: any) => {
    const exp = Date.parse(String(r.expires_at));
    return Number.isFinite(exp) && exp > now;
  });

  const reservedInventoryIds = activeRes.map((r: any) => String(r.inventory_id)).filter(Boolean);

  // Pull jersey numbers for reserved inventory rows (so we can block numbers)
  let reservedInventoryToNumber = new Map<string, number>();
  if (reservedInventoryIds.length > 0) {
    const { data: invRes, error: invResErr } = await supabase
      .from("inventory")
      .select("id, jersey_number")
      .in("id", reservedInventoryIds);

    if (invResErr) {
      console.error("reservations inventory lookup error", invResErr);
      throw new Error("Failed to resolve reserved inventory numbers.");
    }

    for (const r of invRes ?? []) {
      reservedInventoryToNumber.set(String((r as any).id), Number((r as any).jersey_number));
    }
  }

  for (const r of activeRes) {
    const yob = Number((r as any).year_of_birth);
    if (!Number.isFinite(yob)) continue;
    const age = input.seasonYear - yob;
    if (age < minAgeBlock || age > maxAgeBlock) continue;

    const invId = String((r as any).inventory_id);
    const n = reservedInventoryToNumber.get(invId);
    if (Number.isFinite(n as any)) blockedNums.add(n as number);
  }

  // 4) Adjacent cohort usage (spillover risk)
  const minAgeAdj = targetAge - adjacentCohortYears;
  const maxAgeAdj = targetAge + adjacentCohortYears;
  const minYobAdj = yobForAge(maxAgeAdj);
  const maxYobAdj = yobForAge(minAgeAdj);

  const { data: playersAdj, error: paErr } = await supabase
    .from("players")
    .select("final_shirt, year_of_birth")
    .eq("club_id", input.clubId)
    .in("final_shirt", candidateNums)
    .gte("year_of_birth", minYobAdj)
    .lte("year_of_birth", maxYobAdj);

  if (paErr) {
    console.error("players adjacent query error", paErr);
    throw new Error("Failed to load adjacent cohort usage for ranking.");
  }

  const adjCounts = new Map<number, number>();
  for (const p of playersAdj ?? []) {
    const n = Number((p as any).final_shirt);
    if (!Number.isFinite(n)) continue;
    adjCounts.set(n, (adjCounts.get(n) ?? 0) + 1);
  }

  // Reservations in adjacent cohorts count too (same reserved inventory mapping)
  for (const r of activeRes) {
    const yob = Number((r as any).year_of_birth);
    if (!Number.isFinite(yob)) continue;
    const age = input.seasonYear - yob;
    if (age < minAgeAdj || age > maxAgeAdj) continue;

    const invId = String((r as any).inventory_id);
    const n = reservedInventoryToNumber.get(invId);
    if (!Number.isFinite(n as any)) continue;

    adjCounts.set(n as number, (adjCounts.get(n as number) ?? 0) + 1);
  }

  // 5) Score each candidate (lower is better)
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
 * Reserve a specific inventory row for a club/number/size.
 *
 * IMPORTANT:
 * - This sets inventory.status = 'Reserved' (NOT Allocated)
 * - Allocated only happens on "paid order" finalization (webhook)
 */
export async function reserveInventoryForClub(input: {
  clubId: string;
  jerseyNumber: number;
  size: string;
  expiresMinutes?: number;
}): Promise<{ success: boolean; inventoryId?: string; message?: string; expiresAtIso?: string }> {
  const expiresMinutes = Math.max(1, input.expiresMinutes ?? 15);
  const expiresAtIso = new Date(Date.now() + expiresMinutes * 60_000).toISOString();

  const { data, error } = await supabase
    .from("inventory")
    .select("id")
    .eq("club_id", input.clubId)
    .eq("status", "Available")
    .eq("jersey_number", input.jerseyNumber)
    .eq("size", input.size)
    .limit(1);

  if (error) {
    console.error("reserveInventoryForClub select error", error);
    return { success: false, message: "Failed to read inventory while reserving." };
  }

  const row = (data ?? [])[0];
  if (!row) {
    return { success: false, message: "No available inventory row for that size/number." };
  }

  const inventoryId = row.id as string;

  // return_date_due is a DATE column in your schema. We store expiry date (not time) as a helper only.
  const expiryDateOnly = expiresAtIso.slice(0, 10);

  const { error: updateError } = await supabase
    .from("inventory")
    .update({
      status: "Reserved",
      return_date_due: expiryDateOnly,
      allocation_date: null,
      allocated_player_id: null,
    })
    .eq("id", inventoryId)
    .eq("status", "Available"); // guard against race

  if (updateError) {
    console.error("reserveInventoryForClub update error", updateError);
    return { success: false, message: "Failed to mark inventory row as reserved." };
  }

  return { success: true, inventoryId, expiresAtIso };
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
 *
 * NOTE:
 * Some installs may not have team_id column yet.
 * We attempt insert with team_id, then retry without if needed.
 */
export async function createPendingAllocation(input: {
  clubId: string;
  inventoryId: string;
  size: string;
  seasonYear: number;
  yearOfBirth: number;
  teamId?: string | null;
  expiresMinutes?: number;
}): Promise<{ success: boolean; row?: PendingAllocationRow; message?: string }> {
  const expiresMinutes = Math.max(1, input.expiresMinutes ?? 15);
  const expiresAtIso = new Date(Date.now() + expiresMinutes * 60_000).toISOString();

  const payloadWithTeam: any = {
    club_id: input.clubId,
    inventory_id: input.inventoryId,
    size: input.size,
    season_year: input.seasonYear,
    year_of_birth: input.yearOfBirth,
    team_id: input.teamId ?? null,
    status: "reserved",
    expires_at: expiresAtIso,
  };

  const payloadNoTeam: any = {
    club_id: input.clubId,
    inventory_id: input.inventoryId,
    size: input.size,
    season_year: input.seasonYear,
    year_of_birth: input.yearOfBirth,
    status: "reserved",
    expires_at: expiresAtIso,
  };

  // Try with team_id first
  let insertData: any[] | null = null;
  let insertError: any = null;

  {
    const { data, error } = await supabase
      .from("pending_allocations")
      .insert(payloadWithTeam)
      .select("*")
      .limit(1);

    insertData = data ?? null;
    insertError = error ?? null;
  }

  // If team_id column doesn't exist, retry without it
  if (insertError && String(insertError.message || "").toLowerCase().includes('column "team_id"')) {
    const { data, error } = await supabase
      .from("pending_allocations")
      .insert(payloadNoTeam)
      .select("*")
      .limit(1);

    insertData = data ?? null;
    insertError = error ?? null;
  }

  if (insertError) {
    console.error("createPendingAllocation insert error", insertError);
    return { success: false, message: "Failed to create pending allocation record." };
  }

  const row = (insertData ?? [])[0] as PendingAllocationRow | undefined;
  if (!row) return { success: false, message: "Pending allocation insert returned no row." };

  return { success: true, row };
}

/**
 * One-call helper for the widget:
 * - reserve inventory row (status -> Reserved)
 * - create pending allocation record
 * - log event
 *
 * IMPORTANT: If pending allocation fails, we ROLLBACK the inventory row to Available.
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
  expiresAtIso?: string;
}> {
  const reserved = await reserveInventoryForClub({
    clubId: input.clubId,
    jerseyNumber: input.jerseyNumber,
    size: input.size,
    expiresMinutes: input.expiresMinutes,
  });

  if (!reserved.success || !reserved.inventoryId) {
    return { success: false, message: reserved.message ?? "Failed to reserve inventory." };
  }

  const pending = await createPendingAllocation({
    clubId: input.clubId,
    inventoryId: reserved.inventoryId,
    size: input.size,
    seasonYear: input.seasonYear,
    yearOfBirth: input.yearOfBirth,
    teamId: input.teamId ?? null,
    expiresMinutes: input.expiresMinutes,
  });

  if (!pending.success || !pending.row) {
    // Roll back inventory immediately so stock isn’t stranded in Reserved
    try {
      await supabase
        .from("inventory")
        .update({
          status: "Available",
          allocated_player_id: null,
          allocation_date: null,
          return_date_due: null,
        })
        .eq("id", reserved.inventoryId);
    } catch (e) {
      console.error("reserveNumberForPurchase rollback failed", e);
    }

    return {
      success: false,
      message: "Pending allocation failed to save - inventory was returned to Available. Please try again.",
      inventoryId: reserved.inventoryId,
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
    note: "Reserved via widget (pending allocation)",
  });

  return {
    success: true,
    message: `Reserved jersey #${input.jerseyNumber} (${input.size}).`,
    pendingAllocationId: pending.row.id,
    inventoryId: reserved.inventoryId,
    expiresAtIso: reserved.expiresAtIso,
  };
}

/**
 * Cancel a reservation:
 * - Marks pending_allocation cancelled (only if still reserved and unexpired)
 * - Returns the inventory row to Available
 */
export async function cancelReservation(input: {
  pendingAllocationId: string;
}): Promise<{ success: boolean; message: string }> {
  const { data: pending, error: pErr } = await supabase
    .from("pending_allocations")
    .select("*")
    .eq("id", input.pendingAllocationId)
    .limit(1);

  if (pErr) {
    console.error("cancelReservation pending load error", pErr);
    return { success: false, message: "Failed to load pending allocation." };
  }

  const row = (pending ?? [])[0] as PendingAllocationRow | undefined;
  if (!row) return { success: false, message: "Pending allocation not found." };

  const expiresAt = Date.parse(String(row.expires_at));
  const now = Date.now();
  if (!Number.isFinite(expiresAt) || expiresAt <= now) {
    return { success: false, message: "This reservation has already expired." };
  }
  if (row.status !== "reserved") {
    return { success: false, message: `This reservation is not cancellable (status: ${row.status}).` };
  }

  const { error: updPendingErr } = await supabase
    .from("pending_allocations")
    .update({ status: "cancelled" })
    .eq("id", row.id)
    .eq("status", "reserved");

  if (updPendingErr) {
    console.error("cancelReservation pending update error", updPendingErr);
    return { success: false, message: "Failed to cancel the reservation record." };
  }

  const { error: invErr } = await supabase
    .from("inventory")
    .update({
      status: "Available",
      allocated_player_id: null,
      allocation_date: null,
      return_date_due: null,
    })
    .eq("id", row.inventory_id);

  if (invErr) {
    console.error("cancelReservation inventory update error", invErr);
    return { success: false, message: "Reservation cancelled, but failed to return inventory to available." };
  }

  await logAllocationEvent({
    allocation_type: "return",
    club_id: row.club_id,
    player_id: null,
    jersey_number: null,
    size: row.size,
    note: "Reservation cancelled (widget) - returned to stock",
  });

  return { success: true, message: "Reservation cancelled. Inventory returned to available." };
}

/**
 * Finalize a reservation on PAID checkout:
 * - Sets inventory.status = 'Allocated'
 * - Deletes pending_allocations row (your requirement)
 */
export async function finalizeReservationForOrder(input: {
  pendingAllocationId: string;
  orderRef?: string | null;
}): Promise<{ success: boolean; message: string }> {
  const { data: pending, error: pErr } = await supabase
    .from("pending_allocations")
    .select("*")
    .eq("id", input.pendingAllocationId)
    .limit(1);

  if (pErr) {
    console.error("finalizeReservationForOrder pending load error", pErr);
    return { success: false, message: "Failed to load pending allocation." };
  }

  const row = (pending ?? [])[0] as PendingAllocationRow | undefined;
  if (!row) return { success: false, message: "Pending allocation not found." };

  const expiresAt = Date.parse(String(row.expires_at));
  const now = Date.now();
  if (!Number.isFinite(expiresAt) || expiresAt <= now) {
    return { success: false, message: "This reservation has expired. Please reserve again." };
  }
  if (row.status !== "reserved") {
    return { success: false, message: `This reservation cannot be finalized (status: ${row.status}).` };
  }

  // Move inventory -> Allocated (guard: must currently be Reserved)
  const { error: invUpdErr } = await supabase
    .from("inventory")
    .update({
      status: "Allocated",
      allocation_date: new Date().toISOString(),
    })
    .eq("id", row.inventory_id)
    .eq("status", "Reserved");

  if (invUpdErr) {
    console.error("finalizeReservationForOrder inventory update error", invUpdErr);
    return { success: false, message: "Failed to allocate inventory on purchase." };
  }

  // Remove pending allocation record (your requirement)
  const { error: delErr } = await supabase
    .from("pending_allocations")
    .delete()
    .eq("id", row.id);

  if (delErr) {
    console.error("finalizeReservationForOrder pending delete error", delErr);
    // Inventory is already allocated; don't rollback. Just surface clear message.
    return { success: false, message: "Inventory allocated, but failed to remove pending allocation record." };
  }

  await logAllocationEvent({
    allocation_type: "new",
    club_id: row.club_id,
    player_id: null,
    jersey_number: null,
    size: row.size,
    note: input.orderRef ? `Purchased - orderRef: ${input.orderRef}` : "Purchased - finalize reservation",
  });

  return { success: true, message: "Purchase finalized. Inventory moved to Allocated." };
}

/**
 * Return a jersey to stock (admin/warehouse).
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
    .in("status", ["Allocated", "Reserved", "Available"])
    .limit(1);

  if (error) {
    console.error("returnJerseyToStock select error", error);
    return { success: false, message: "Failed to read inventory while returning jersey." };
  }

  const row = (data ?? [])[0];
  if (!row) {
    return { success: false, message: "No matching inventory row found. Nothing to return." };
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
    note: "Warehouse return to stock",
  });

  return { success: true, message: `Jersey #${jerseyNumber} (${size}) marked back as Available.` };
}
