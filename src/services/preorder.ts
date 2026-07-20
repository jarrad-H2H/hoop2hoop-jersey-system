// FILE: src/services/preorder.ts
// FCFS batch allocation engine for pre-order mode.
// Read ALLOCATION_LOGIC.md Section 17 before editing.
import { supabase, fetchAllPages } from "./supabase";

export interface PreorderRequest {
  id: string;
  club_id: string;
  first_name: string;
  last_name: string;
  year_of_birth: number | null;
  size: string;
  age_group: string | null;
  pref_1: number | null;
  pref_2: number | null;
  pref_3: number | null;
  any_number: boolean;
  claimed_current: number | null;
  gender: "Male" | "Female" | null;
  assigned_number: number | null;
  shopify_order_id: string | null;
  order_number: string | null;
  paid_at: string | null;
  status: "pending" | "allocated" | "overflow" | "locked";
  created_at: string;
}

const VALID_NUMBERS = Array.from({ length: 100 }, (_, i) => i).filter(n => n !== 69);

/**
 * Runs the FCFS batch allocation for all pending preorder_requests for a club + season.
 *
 * Within each age-group pool:
 *  1. Sort by paid_at ASC (earlier payers get priority).
 *  2. claimed_current is tried first (reclaim existing jersey).
 *  3. Then pref_1, pref_2, pref_3 in order.
 *  4. Then any remaining number (for any_number=true, or when all prefs are taken).
 *  5. Overflow status if pool is exhausted (>99 players in one pool).
 *
 * Multi-round safe: already-allocated requests are loaded to seed the taken set,
 * so round-2 requests won't collide with numbers assigned in round 1.
 */
export async function runFcfsAllocation(
  clubId: string,
  season: string
): Promise<{ allocated: number; overflow: number; pools: Record<string, { allocated: number; overflow: number }> }> {
  // Fetch all non-overflow requests to seed already-taken numbers from prior rounds
  const allRequests = await fetchAllPages<PreorderRequest>((from, to) =>
    supabase
      .from("preorder_requests")
      .select("id, club_id, first_name, last_name, year_of_birth, gender, size, age_group, pref_1, pref_2, pref_3, any_number, claimed_current, assigned_number, paid_at, status, created_at, shopify_order_id, order_number")
      .eq("club_id", clubId)
      .eq("season", season)
      .neq("status", "overflow")
      .order("paid_at", { ascending: true, nullsFirst: false })
      .order("created_at", { ascending: true })
      .range(from, to)
  );

  // Split into already-allocated (from prior rounds) and new pending
  const priorAllocated = allRequests.filter(r => r.status === "allocated" || r.status === "locked");
  const pending = allRequests.filter(r => r.status === "pending");

  if (pending.length === 0) {
    return { allocated: 0, overflow: 0, pools: {} };
  }

  // Group by age_group pool
  const poolMap = new Map<string, { prior: PreorderRequest[]; pending: PreorderRequest[] }>();

  for (const req of [...priorAllocated, ...pending]) {
    const pool = req.age_group ?? "unknown";
    if (!poolMap.has(pool)) poolMap.set(pool, { prior: [], pending: [] });
    if (req.status === "pending") {
      poolMap.get(pool)!.pending.push(req);
    } else {
      poolMap.get(pool)!.prior.push(req);
    }
  }

  let totalAllocated = 0;
  let totalOverflow = 0;
  const poolSummary: Record<string, { allocated: number; overflow: number }> = {};
  const updates: Array<{ id: string; assigned_number: number | null; status: string }> = [];

  for (const [pool, { prior, pending: poolPending }] of poolMap) {
    if (poolPending.length === 0) continue;

    // Seed taken set from numbers already assigned in prior allocation rounds
    const taken = new Set<number>(
      prior
        .filter(r => r.assigned_number != null)
        .map(r => r.assigned_number!)
    );

    let poolAllocated = 0;
    let poolOverflow = 0;

    for (const req of poolPending) {
      let assigned: number | null = null;

      // 1. Reclaim: try claimed_current first
      if (req.claimed_current != null && !taken.has(req.claimed_current)) {
        assigned = req.claimed_current;
      }

      // 2. Stated preferences in order
      if (assigned == null) {
        for (const pref of [req.pref_1, req.pref_2, req.pref_3]) {
          if (pref != null && !taken.has(pref)) {
            assigned = pref;
            break;
          }
        }
      }

      // 3. Any available number — for any_number=true, or when all stated prefs are taken
      if (assigned == null) {
        const prefs = [req.pref_1, req.pref_2, req.pref_3].filter((p): p is number => p != null);
        const allPrefsTaken = prefs.length > 0 && prefs.every(p => taken.has(p));
        if (req.any_number || allPrefsTaken || prefs.length === 0) {
          for (const n of VALID_NUMBERS) {
            if (!taken.has(n)) {
              assigned = n;
              break;
            }
          }
        }
      }

      if (assigned != null) {
        taken.add(assigned);
        poolAllocated++;
        updates.push({ id: req.id, assigned_number: assigned, status: "allocated" });
      } else {
        poolOverflow++;
        updates.push({ id: req.id, assigned_number: null, status: "overflow" });
      }
    }

    totalAllocated += poolAllocated;
    totalOverflow += poolOverflow;
    poolSummary[pool] = { allocated: poolAllocated, overflow: poolOverflow };
  }

  // Write all assignments in parallel
  await Promise.all(
    updates.map(u =>
      supabase
        .from("preorder_requests")
        .update({ assigned_number: u.assigned_number, status: u.status })
        .eq("id", u.id)
    )
  );

  return { allocated: totalAllocated, overflow: totalOverflow, pools: poolSummary };
}

/**
 * Finalise pre-order: writes assigned numbers to players.final_shirt, creates inventory rows,
 * and marks each request as "locked". Call after running FCFS allocation and reviewing results.
 */
interface FinaliseRow {
  id: string;
  first_name: string;
  last_name: string;
  year_of_birth: number;
  size: string | null;
  age_group: string | null;
  assigned_number: number;
  player_id: string | null;
  product_type: string | null;
  shopify_order_id: string | null;
  shopify_line_item_id: string | null;
  jersey_name: string | null;
}

export interface ShopifyOrderUpdate {
  shopifyOrderId: string;
  shopifyLineItemId: string;
  jerseyNumber: number;
  firstName: string;
  lastName: string;
  jerseyName: string | null;
}

export async function finalisePreorder(
  clubId: string,
  season: string
): Promise<{ locked: number; errors: string[]; shopifyUpdates: ShopifyOrderUpdate[] }> {
  const requests = await fetchAllPages<FinaliseRow>((from, to) =>
    supabase
      .from("preorder_requests")
      .select("id, first_name, last_name, year_of_birth, size, age_group, assigned_number, player_id, product_type, shopify_order_id, shopify_line_item_id, jersey_name")
      .eq("club_id", clubId)
      .eq("season", season)
      .eq("status", "allocated")
      .not("assigned_number", "is", null)
      .range(from, to) as any
  );

  let locked = 0;
  const errors: string[] = [];
  const shopifyUpdates: ShopifyOrderUpdate[] = [];

  for (const req of requests) {
    if (req.assigned_number == null) continue;
    if (!req.size) {
      errors.push(`${req.first_name} ${req.last_name}: no size recorded — skipped (player may not have confirmed their size yet)`);
      continue;
    }
    try {
      if (req.player_id) {
        await supabase.from("players").update({ final_shirt: req.assigned_number }).eq("id", req.player_id);
      } else {
        const { data: existing } = await supabase
          .from("players").select("id")
          .eq("club_id", clubId)
          .ilike("first_name", req.first_name)
          .ilike("last_name", req.last_name)
          .eq("year_of_birth", req.year_of_birth)
          .limit(1);
        const player = (existing ?? [])[0] as { id: string } | undefined;
        if (player?.id) {
          await supabase.from("players").update({ final_shirt: req.assigned_number }).eq("id", player.id);
        } else {
          await supabase.from("players").insert({
            first_name: req.first_name, last_name: req.last_name,
            year_of_birth: req.year_of_birth, club_id: clubId,
            final_shirt: req.assigned_number, age_group: req.age_group,
          });
        }
      }
      await supabase.from("inventory").insert({
        club_id: clubId,
        jersey_number: req.assigned_number,
        size: req.size,
        status: "Allocated",
        product_type: req.product_type ?? "unisex",
      });
      await supabase.from("preorder_requests").update({ status: "locked" }).eq("id", req.id);
      locked++;
      if (req.shopify_order_id && req.shopify_line_item_id) {
        shopifyUpdates.push({
          shopifyOrderId: req.shopify_order_id,
          shopifyLineItemId: req.shopify_line_item_id,
          jerseyNumber: req.assigned_number,
          firstName: req.first_name,
          lastName: req.last_name,
          jerseyName: req.jersey_name ?? null,
        });
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : "unknown error";
      errors.push(`${req.first_name} ${req.last_name}: ${msg}`);
    }
  }

  return { locked, errors, shopifyUpdates };
}

/** Returns ShopifyOrderUpdate entries for all locked requests that have both IDs set.
 *  Used by the re-sync flow to push allocated numbers to Shopify without re-finalising. */
export async function getLockedShopifyUpdates(
  clubId: string,
  season: string
): Promise<ShopifyOrderUpdate[]> {
  const rows = await fetchAllPages<{ shopify_order_id: string; shopify_line_item_id: string; assigned_number: number; first_name: string; last_name: string; jersey_name: string | null }>((from, to) =>
    supabase
      .from("preorder_requests")
      .select("shopify_order_id, shopify_line_item_id, assigned_number, first_name, last_name, jersey_name")
      .eq("club_id", clubId)
      .eq("season", season)
      .eq("status", "locked")
      .not("shopify_order_id", "is", null)
      .not("shopify_line_item_id", "is", null)
      .not("assigned_number", "is", null)
      .range(from, to) as any
  );
  return rows.map(r => ({
    shopifyOrderId: r.shopify_order_id,
    shopifyLineItemId: r.shopify_line_item_id,
    jerseyNumber: r.assigned_number,
    firstName: r.first_name,
    lastName: r.last_name,
    jerseyName: (r as any).jersey_name ?? null,
  }));
}

export interface PreallocatedImportRow {
  first_name: string;
  last_name: string;
  jersey_number: number;
  year_of_birth: number | null;
  gender?: string | null;
  age_group?: string | null;
  parent_1_name?: string | null;
  parent_1_email?: string | null;
  parent_1_mobile?: string | null;
  parent_2_name?: string | null;
  parent_2_email?: string | null;
  parent_2_mobile?: string | null;
}

export interface ImportPreallocatedResult {
  inserted: number;
  updated: number;
  skipped: number;
  errors: string[];
}

/** Imports pre-allocated roster data into preorder_requests for a club+season.
 *  Each row must have a pre-assigned jersey number.
 *  Creates rows with status='needs_size' (awaiting player size confirmation via widget).
 *  Upserts by matching first_name + last_name + year_of_birth within the club+season. */
export async function importPreallocatedRoster(
  clubId: string,
  season: string,
  rows: PreallocatedImportRow[],
  productType: "unisex" | "mens" | "womens" = "unisex"
): Promise<ImportPreallocatedResult> {
  const result: ImportPreallocatedResult = { inserted: 0, updated: 0, skipped: 0, errors: [] };

  // Load existing rows for this club+season to detect duplicates
  const existing = await fetchAllPages<{ id: string; first_name: string; last_name: string; year_of_birth: number }>((from, to) =>
    supabase
      .from("preorder_requests")
      .select("id, first_name, last_name, year_of_birth")
      .eq("club_id", clubId)
      .eq("season", season)
      .range(from, to) as any
  );

  const existingKey = (r: { first_name: string; last_name: string; year_of_birth: number | null }) =>
    `${r.first_name.trim().toLowerCase()}|${r.last_name.trim().toLowerCase()}|${r.year_of_birth ?? ""}`;

  const existingMap = new Map(existing.map(r => [existingKey(r), r.id]));

  for (const row of rows) {
    const key = existingKey({ first_name: row.first_name, last_name: row.last_name, year_of_birth: row.year_of_birth });
    const existingId = existingMap.get(key);

    const payload = {
      club_id: clubId,
      season,
      first_name: row.first_name.trim(),
      last_name: row.last_name.trim(),
      year_of_birth: row.year_of_birth ?? null,
      gender: (row.gender ?? null) as "Male" | "Female" | null,
      age_group: row.age_group ?? null,
      assigned_number: row.jersey_number,
      jersey_name: row.last_name.trim().toUpperCase(),
      status: "needs_size" as const,
      size: null,
      product_type: productType,
      any_number: false,
      pref_1: null,
      pref_2: null,
      pref_3: null,
      parent_1_name: row.parent_1_name ?? null,
      parent_1_email: row.parent_1_email ?? null,
      parent_1_mobile: row.parent_1_mobile ?? null,
      parent_2_name: row.parent_2_name ?? null,
      parent_2_email: row.parent_2_email ?? null,
      parent_2_mobile: row.parent_2_mobile ?? null,
    };

    if (existingId) {
      // Update the existing row's jersey number and parent info (leave size/jersey_name if already confirmed)
      const { error } = await supabase
        .from("preorder_requests")
        .update({
          assigned_number: payload.assigned_number,
          jersey_name: payload.jersey_name,
          gender: payload.gender,
          age_group: payload.age_group,
          parent_1_name: payload.parent_1_name,
          parent_1_email: payload.parent_1_email,
          parent_1_mobile: payload.parent_1_mobile,
          parent_2_name: payload.parent_2_name,
          parent_2_email: payload.parent_2_email,
          parent_2_mobile: payload.parent_2_mobile,
        })
        .eq("id", existingId)
        .in("status", ["needs_size"]);
      if (error) {
        result.errors.push(`${row.first_name} ${row.last_name}: ${error.message}`);
      } else {
        result.updated++;
      }
    } else {
      const { error } = await supabase
        .from("preorder_requests")
        .insert(payload);
      if (error) {
        result.errors.push(`${row.first_name} ${row.last_name}: ${error.message}`);
      } else {
        result.inserted++;
      }
    }
  }

  return result;
}

/** Validates a row from the admin correction Excel import.
 *  Returns an error string, or null if valid. */
export function validateImportRow(
  row: Record<string, unknown>,
  rowNum: number
): string | null {
  const requestId = String(row["request_id"] ?? "").trim();
  if (!requestId) return `Row ${rowNum}: request_id is blank.`;

  const rawAssigned = row["assigned_number"];
  if (rawAssigned === undefined || rawAssigned === null || rawAssigned === "") return null; // blank = leave unchanged

  const n = Number(rawAssigned);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0 || n > 99 || n === 69) {
    return `Row ${rowNum}: assigned_number "${rawAssigned}" is not a valid jersey number (0–99, not 69).`;
  }

  return null;
}
