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

type ShopifyLineItem = {
  id?: number | string;
  quantity?: number;
  properties?: any;
};

type ShopifyOrderPayload = {
  id?: number | string;
  name?: string;
  order_number?: number | string;
  line_items?: ShopifyLineItem[];
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
        .select("id, status, expires_at, inventory_id")
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
          // Look up player name via their allocated jersey number + club
          let playerName = "";
          if (pending.club_id && pending.jersey_number) {
            const { data: playerRow } = await supabase
              .from("players")
              .select("first_name, last_name")
              .eq("club_id", pending.club_id)
              .eq("final_shirt", pending.jersey_number)
              .maybeSingle();
            if (playerRow) {
              playerName = `${playerRow.first_name ?? ""} ${playerRow.last_name ?? ""}`.trim();
            }
          }

          // Look up club name
          let clubName = "";
          if (pending.club_id) {
            const { data: clubRow } = await supabase
              .from("clubs")
              .select("name")
              .eq("id", pending.club_id)
              .maybeSingle();
            clubName = (clubRow as any)?.name ?? "";
          }

          await supabase.from("orders").insert({
            id: reservationId,
            reservation_id: reservationId,
            shopify_order_id: orderId,
            order_number: orderNumber || null,
            order_date: nowIso,
            player_name: playerName,
            club_id: String(pending.club_id ?? ""),
            team_name: String((pending as any).team_id ?? ""),
            product_name: clubName,
            size: String((pending as any).size ?? ""),
            number: String((pending as any).jersey_number ?? jerseyNumber),
            jersey_number: Number((pending as any).jersey_number) || null,
            year_of_birth: Number((pending as any).year_of_birth) || null,
            season_year: Number((pending as any).season_year) || null,
            purchased_at: nowIso,
          });
        } catch {
          // Sales log write must never break webhook processing
        }
      }
    } catch (e: any) {
      issues.push({ reservationId, issue: "Unhandled exception.", detail: e?.message ?? String(e) });
      await logEvent(supabase, {
        order_id: orderId, order_number: orderNumber, reservation_id: reservationId,
        level: "error", message: "Unhandled exception processing reservation",
        meta: { detail: e?.message ?? String(e) },
      });
    }
  }

  // Always 200 — Shopify retries non-2xx, and our failures are logged for review
  return res.status(200).json({ ok: true, orderId, processed, issues });
}
