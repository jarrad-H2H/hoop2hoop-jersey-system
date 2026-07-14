// FILE: api/shopify/orders-create.ts
// Canonical Shopify order webhook (orders/create). Supersedes orders-paid.ts
// and supabase/functions/shopify-order-created — do not register those.
//
// Responsibilities:
//  1. Verify Shopify HMAC signature (raw body)
//  2. For each line item carrying a reservation id: mark the pending
//     allocation purchased, ensure inventory is Allocated, attach order info
//  3. Handle edge cases (expired hold, missing inventory) as "reconciled"
//     and log everything to webhook_events for the admin to review
import type { VercelRequest, VercelResponse } from "@vercel/node";
import crypto from "crypto";
import { createClient } from "@supabase/supabase-js";

// Vercel must NOT pre-parse the body — we need the raw bytes for HMAC verification.
// Without this, Vercel consumes the stream and rawBody reads as "", breaking HMAC.
export const config = {
  api: {
    bodyParser: false,
  },
};

type ShopifyLineItem = {
  id?: number | string;
  quantity?: number;
  properties?: any;
};

type ShopifyCustomer = {
  id?: number | string;
  first_name?: string;
  last_name?: string;
  email?: string;
};

type ShopifyOrderPayload = {
  id?: number | string;
  name?: string;
  order_number?: number | string;
  line_items?: ShopifyLineItem[];
  customer?: ShopifyCustomer;
};

function readRawBody(req: VercelRequest): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => (data += chunk));
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

function timingSafeEqual(a: string, b: string): boolean {
  try {
    const ab = Buffer.from(a, "utf8");
    const bb = Buffer.from(b, "utf8");
    if (ab.length !== bb.length) return false;
    return crypto.timingSafeEqual(ab, bb);
  } catch {
    return false;
  }
}

function verifyShopifyHmac(rawBody: string, hmacHeader: string | undefined, secret: string): boolean {
  if (!hmacHeader) return false;
  const digest = crypto.createHmac("sha256", secret).update(rawBody, "utf8").digest("base64");
  return timingSafeEqual(digest, hmacHeader);
}

function normalizeKey(s: any): string {
  return String(s ?? "").trim().toLowerCase().replace(/[\s_]+/g, " ");
}

// Tolerant property extraction: accepts "Reservation ID", "H2H Reservation ID",
// "h2h_pending_allocation_id", "Pending Allocation ID", and array/object shapes.
function extractProperties(props: any): { reservationId: string; jerseyNumber: string } {
  let reservationId = "";
  let jerseyNumber = "";

  const consider = (rawName: any, rawValue: any) => {
    const name = normalizeKey(rawName);
    if (!name) return;
    const value = String(rawValue ?? "").trim();

    if (!reservationId && (name.includes("reservation") || name.includes("pending allocation"))) {
      reservationId = value;
    }
    if (!jerseyNumber && name.includes("jersey") && name.includes("number")) {
      jerseyNumber = value;
    }
  };

  if (Array.isArray(props)) {
    for (const p of props) consider((p as any)?.name ?? (p as any)?.key, (p as any)?.value);
  } else if (props && typeof props === "object") {
    for (const [k, v] of Object.entries(props)) consider(k, v);
  }

  return { reservationId, jerseyNumber };
}

function extractPreorderProperties(props: any): {
  isPreorder: boolean; pref1: number | null; pref2: number | null; pref3: number | null;
  anyNumber: boolean; claimedCurrent: number | null;
  firstName: string; lastName: string; yob: number | null;
  ageGroup: string | null; clubId: string; size: string; gender: string | null;
} {
  const get = (key: string): string => {
    if (Array.isArray(props)) {
      const p = props.find((p: any) => normalizeKey(p?.name ?? p?.key) === normalizeKey(key));
      return String(p?.value ?? "").trim();
    }
    if (props && typeof props === "object") return String(props[key] ?? "").trim();
    return "";
  };
  const toInt = (s: string): number | null => {
    if (!s) return null;
    const n = Number(s);
    return Number.isFinite(n) && Number.isInteger(n) ? n : null;
  };
  return {
    isPreorder: get("_h2h_preorder_mode") === "true",
    pref1: toInt(get("_h2h_pref_1")),
    pref2: toInt(get("_h2h_pref_2")),
    pref3: toInt(get("_h2h_pref_3")),
    anyNumber: get("_h2h_any_number") === "true",
    claimedCurrent: toInt(get("_h2h_claimed_current")),
    firstName: get("_h2h_first_name"),
    lastName: get("_h2h_last_name"),
    yob: toInt(get("_h2h_yob")),
    ageGroup: get("_h2h_age_group") || null,
    clubId: get("_h2h_club_id"),
    size: get("_h2h_size"),
    gender: get("_h2h_gender") || null,
  };
}

async function logEvent(supabase: any, event: {
  order_id?: string | null;
  order_number?: string | null;
  reservation_id?: string | null;
  level?: "info" | "warn" | "error";
  message: string;
  meta?: any;
}) {
  try {
    await supabase.from("webhook_events").insert({
      topic: "orders/create",
      order_id: event.order_id ?? null,
      order_number: event.order_number ?? null,
      reservation_id: event.reservation_id ?? null,
      level: event.level ?? "info",
      message: event.message,
      meta: event.meta ?? null,
    });
  } catch {
    // logging must never break webhook processing
  }
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ ok: false, error: "Method Not Allowed" });
  }

  const SUPABASE_URL = process.env.SUPABASE_URL || "";
  const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
  // Accept either env var name (earlier versions used both)
  const SHOPIFY_SECRET = process.env.SHOPIFY_WEBHOOK_SECRET || process.env.SHOPIFY_APP_SECRET || "";

  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY || !SHOPIFY_SECRET) {
    return res.status(500).json({ ok: false, error: "Server not configured" });
  }

  let rawBody = "";
  try {
    rawBody = await readRawBody(req);
  } catch {
    return res.status(400).json({ ok: false, error: "Failed to read request body." });
  }

  const hmacHeader = (req.headers["x-shopify-hmac-sha256"] as string | undefined) ?? undefined;
  if (!verifyShopifyHmac(rawBody, hmacHeader, SHOPIFY_SECRET)) {
    return res.status(401).json({ ok: false, error: "Invalid webhook signature." });
  }

  let payload: ShopifyOrderPayload | null = null;
  try {
    payload = JSON.parse(rawBody) as ShopifyOrderPayload;
  } catch {
    return res.status(400).json({ ok: false, error: "Invalid JSON." });
  }

  const orderId = payload?.id != null ? String(payload.id) : "";
  const orderNumber =
    payload?.order_number != null ? String(payload.order_number)
    : payload?.name != null ? String(payload.name) : "";
  const lineItems = Array.isArray(payload?.line_items) ? payload!.line_items! : [];

  // Shopify buyer name — captured for audit trail (fraud/abuse retrospective lookup)
  const shopifyBuyerName =
    [payload?.customer?.first_name, payload?.customer?.last_name]
      .filter(Boolean)
      .join(" ")
      .trim() || null;

  if (!orderId) {
    return res.status(200).json({ ok: true, processed: 0, note: "No order id in payload." });
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  });

  const nowIso = new Date().toISOString();
  let processed = 0;
  const issues: any[] = [];

  for (const li of lineItems) {
    // Pre-order: detect before the reservation check
    const preorderProps = extractPreorderProperties(li.properties);
    if (preorderProps.isPreorder) {
      if (!preorderProps.clubId || !preorderProps.firstName || !preorderProps.lastName || !preorderProps.yob) {
        await logEvent(supabase, {
          order_id: orderId, order_number: orderNumber, level: "error",
          message: "Pre-order line item missing required fields", meta: { preorderProps },
        });
        continue;
      }
      try {
        const { error: poErr } = await supabase.from("preorder_requests").insert({
          club_id: preorderProps.clubId,
          first_name: preorderProps.firstName,
          last_name: preorderProps.lastName,
          year_of_birth: preorderProps.yob,
          size: preorderProps.size || "Unknown",
          age_group: preorderProps.ageGroup,
          pref_1: preorderProps.pref1,
          pref_2: preorderProps.pref2,
          pref_3: preorderProps.pref3,
          any_number: preorderProps.anyNumber,
          claimed_current: preorderProps.claimedCurrent,
          gender: preorderProps.gender,
          shopify_order_id: orderId,
          order_number: orderNumber || null,
          paid_at: nowIso,
          status: "pending",
        });
        if (poErr) {
          await logEvent(supabase, { order_id: orderId, order_number: orderNumber, level: "error", message: "Failed to insert preorder_request", meta: { detail: poErr.message } });
        } else {
          processed += 1;
          await logEvent(supabase, { order_id: orderId, order_number: orderNumber, level: "info", message: "Pre-order preference recorded", meta: { clubId: preorderProps.clubId, name: `${preorderProps.firstName} ${preorderProps.lastName}` } });
        }
      } catch (e: any) {
        await logEvent(supabase, { order_id: orderId, order_number: orderNumber, level: "error", message: "Exception writing preorder_request", meta: { detail: e?.message ?? String(e) } });
      }
      continue; // don't fall through to reservation logic
    }

    const { reservationId, jerseyNumber } = extractProperties(li.properties);
    if (!reservationId) continue; // not a jersey item

    const lineItemId = li?.id != null ? String(li.id) : null;
    const qty = Number(li?.quantity ?? 1);

    if (Number.isFinite(qty) && qty > 1) {
      issues.push({ reservationId, issue: "Quantity > 1; reservation processed once." });
      await logEvent(supabase, {
        order_id: orderId, order_number: orderNumber, reservation_id: reservationId,
        level: "warn", message: "Line item quantity > 1 for a reserved jersey. Manual review needed.",
        meta: { qty, jerseyNumber, lineItemId },
      });
    }

    try {
      const { data: pending, error: pendingErr } = await supabase
        .from("pending_allocations")
        .select("id, status, expires_at, inventory_id, jersey_number, size, season_year, year_of_birth, club_id, team_id, player_first_name, player_last_name, is_new_player, keep_existing_jersey, previous_jersey_number, previous_inventory_id, product_type")
        .eq("id", reservationId)
        .maybeSingle();

      if (pendingErr || !pending) {
        issues.push({ reservationId, issue: "Pending allocation not found." });
        await logEvent(supabase, {
          order_id: orderId, order_number: orderNumber, reservation_id: reservationId,
          level: "error", message: "Reservation ID not found in pending_allocations",
          meta: { lineItemId, qty, jerseyNumber, detail: pendingErr?.message ?? "not found" },
        });
        continue;
      }

      // Idempotency: Shopify retries webhooks — a second delivery is a no-op
      if (pending.status === "purchased" || pending.status === "reconciled") {
        processed += 1;
        continue;
      }

      // Determine whether this is a clean purchase or needs reconciliation
      // (e.g. hold expired before checkout completed, inventory re-released)
      let reconciliationNeeded = pending.status !== "reserved";

      const invId = String((pending as any).inventory_id ?? "");
      if (!invId) {
        reconciliationNeeded = true;
        await logEvent(supabase, {
          order_id: orderId, order_number: orderNumber, reservation_id: reservationId,
          level: "error", message: "Pending allocation missing inventory_id",
        });
      } else {
        const { data: inv } = await supabase
          .from("inventory").select("id, status").eq("id", invId).maybeSingle();

        const invStatus = String((inv as any)?.status ?? "");
        if (!inv) {
          reconciliationNeeded = true;
          await logEvent(supabase, {
            order_id: orderId, order_number: orderNumber, reservation_id: reservationId,
            level: "error", message: "Inventory row missing for reservation",
            meta: { invId },
          });
        } else if (invStatus === "Available") {
          // Hold expired and stock was re-released; claim it back if still free
          const { data: reclaimed } = await supabase
            .from("inventory")
            .update({ status: "Allocated", allocation_date: nowIso })
            .eq("id", invId)
            .eq("status", "Available")
            .select("id");

          if (!reclaimed || reclaimed.length === 0) {
            reconciliationNeeded = true;
            await logEvent(supabase, {
              order_id: orderId, order_number: orderNumber, reservation_id: reservationId,
              level: "error", message: "Could not re-claim expired inventory (taken by someone else). Manual review needed.",
              meta: { invId },
            });
          }
        } else if (invStatus !== "Allocated") {
          reconciliationNeeded = true;
          await logEvent(supabase, {
            order_id: orderId, order_number: orderNumber, reservation_id: reservationId,
            level: "error", message: "Inventory row in unexpected status", meta: { invId, invStatus },
          });
        }
      }

      const newStatus = reconciliationNeeded ? "reconciled" : "purchased";

      const { error: upErr } = await supabase
        .from("pending_allocations")
        .update({
          status: newStatus,
          order_id: orderId,
          order_number: orderNumber || null,
          shopify_line_item_id: lineItemId,
          purchased_at: nowIso,
        })
        .eq("id", reservationId);

      if (upErr) {
        issues.push({ reservationId, issue: "Failed to update pending allocation.", detail: upErr.message });
        await logEvent(supabase, {
          order_id: orderId, order_number: orderNumber, reservation_id: reservationId,
          level: "error", message: "Failed to mark pending allocation purchased",
          meta: { detail: upErr.message },
        });
        continue;
      }

      processed += 1;
      await logEvent(supabase, {
        order_id: orderId, order_number: orderNumber, reservation_id: reservationId,
        level: reconciliationNeeded ? "warn" : "info",
        message: reconciliationNeeded
          ? "Order recorded but flagged 'reconciled' — review in admin"
          : "Reservation purchased",
        meta: { jerseyNumber, lineItemId },
      });

      // Write a sales record to the orders table (for the Sales History admin page).
      // Only write for clean purchases — reconciled orders need manual review first.
      if (!reconciliationNeeded) {
        try {
          const p = pending as any;
          const playerFirstName: string = p.player_first_name ?? "";
          const playerLastName: string = p.player_last_name ?? "";
          const isNewPlayerFlag: boolean | null = p.is_new_player ?? null;
          const keepExistingFlag: boolean | null = p.keep_existing_jersey ?? null;
          const prevJerseyNum: number | null = p.previous_jersey_number ?? null;
          const prevInventoryId: string | null = p.previous_inventory_id ?? null;
          const playerName = [playerFirstName, playerLastName].filter(Boolean).join(" ").trim();
          const clubId = String(p.club_id ?? "");
          const newJerseyNum = Number(p.jersey_number) || null;

          // Look up club name
          let clubName = "";
          if (clubId) {
            const { data: clubRow } = await supabase
              .from("clubs").select("name").eq("id", clubId).maybeSingle();
            clubName = (clubRow as any)?.name ?? "";
          }

          // Resolved below (when player identity is known) and reused by the orders
          // insert further down, so it must live in this outer scope.
          let pendingTeamName: string | null = null;

          // ── Player record management ─────────────────────────────────────────
          if (playerFirstName && playerLastName && p.year_of_birth && clubId) {
            const yob = Number(p.year_of_birth);

            // Resolve the team this specific purchase was for (from the widget's team
            // dropdown, stored as pending_allocations.team_id -> teams.id). A player can
            // have multiple players rows -- one per team membership (this already happens
            // organically via BC import for real multi-team players) -- so matching by
            // name+YOB+club ALONE is not enough to find the right row once a player plays
            // for more than one team (e.g. "playing up" a second jersey for a higher team).
            let pendingTeamAgeGroup: string | null = null;
            const pendingTeamId = (p.team_id ?? "").toString().trim();
            if (pendingTeamId) {
              const { data: teamRow } = await supabase
                .from("teams")
                .select("name, age_group")
                .eq("id", pendingTeamId)
                .maybeSingle();
              pendingTeamName = (teamRow as any)?.name ?? null;
              pendingTeamAgeGroup = (teamRow as any)?.age_group ?? null;
            }

            if (isNewPlayerFlag === true) {
              // New player — insert a fresh player record
              await supabase.from("players").insert({
                first_name: playerFirstName,
                last_name: playerLastName,
                year_of_birth: yob,
                club_id: clubId,
                final_shirt: newJerseyNum,
                team_name: pendingTeamName,
                age_group: pendingTeamAgeGroup,
              });
            } else if (isNewPlayerFlag === false) {
              // Existing player — find the row for THIS specific team (when known) and
              // update its final_shirt. If no row exists for this team — either a brand
              // new team-membership (playing up) or a player not yet recorded — INSERT a
              // new row rather than overwriting an unrelated team's record.
              const { data: existingPlayers } = await supabase
                .from("players")
                .select("id, team_name")
                .eq("club_id", clubId)
                .ilike("first_name", playerFirstName)
                .ilike("last_name", playerLastName)
                .eq("year_of_birth", yob);

              const rows = (existingPlayers ?? []) as any[];
              const existingPlayer = pendingTeamName
                ? rows.find((r) => r.team_name === pendingTeamName)
                : rows[0];

              if (existingPlayer?.id) {
                await supabase
                  .from("players")
                  .update({ final_shirt: newJerseyNum })
                  .eq("id", existingPlayer.id);
              } else {
                // No row for this team — insert a new one (covers both "not found at all"
                // and "found, but only for a different team membership").
                await supabase.from("players").insert({
                  first_name: playerFirstName,
                  last_name: playerLastName,
                  year_of_birth: yob,
                  club_id: clubId,
                  final_shirt: newJerseyNum,
                  team_name: pendingTeamName,
                  age_group: pendingTeamAgeGroup,
                });
              }

              // If they're releasing their old jersey, write it off permanently.
              // The physical jersey leaves H2H's pool (player sells second-hand).
              // NOT returned to Available — drops out of inventory so StockPlanner
              // flags reduced stock and can recommend reprinting that number.
              if (keepExistingFlag === false && prevInventoryId) {
                await supabase
                  .from("inventory")
                  .update({ status: "Written Off", allocation_date: null, allocated_player_id: null })
                  .eq("id", prevInventoryId)
                  .eq("status", "Allocated"); // guard: only write off if still allocated
              }
            }
          }
          // ────────────────────────────────────────────────────────────────────

          const { error: insertErr } = await supabase.from("orders").insert({
            id: reservationId,
            reservation_id: reservationId,
            shopify_order_id: orderId,
            order_number: orderNumber || null,
            order_date: nowIso,
            player_name: playerName,
            player_first_name: playerFirstName || null,
            player_last_name: playerLastName || null,
            is_new_player: isNewPlayerFlag,
            keep_existing_jersey: keepExistingFlag,
            shopify_buyer_name: shopifyBuyerName,
            club_id: clubId,
            team_name: pendingTeamName ?? String(p.team_id ?? ""),
            product_name: clubName,
            size: String(p.size ?? ""),
            number: String(p.jersey_number ?? jerseyNumber),
            jersey_number: newJerseyNum,
            year_of_birth: Number(p.year_of_birth) || null,
            season_year: Number(p.season_year) || null,
            purchased_at: nowIso,
            product_type: p.product_type ?? "default",
          });
          if (insertErr) {
            await logEvent(supabase, {
              order_id: orderId, order_number: orderNumber, reservation_id: reservationId,
              level: "error", message: "Failed to write to orders table",
              meta: { detail: insertErr.message, code: (insertErr as any).code },
            });
          }
        } catch (salesErr: any) {
          await logEvent(supabase, {
            order_id: orderId, order_number: orderNumber, reservation_id: reservationId,
            level: "error", message: "Exception writing to orders table",
            meta: { detail: salesErr?.message ?? String(salesErr) },
          });
        }
      }
    } catch (e: any) {
      issues.push({ reservationId, issue: "Unhandled exception.", detail: e?.message ?? String(e) });
      await logEvent(supabase, {
        level: "error", message: "Unhandled exception processing reservation",
        meta: { detail: e?.message ?? String(e) },
      });
    }
  }

  // Always 200 — Shopify retries non-2xx, and our failures are logged for review
  return res.status(200).json({ ok: true, orderId, processed, issues });
}
