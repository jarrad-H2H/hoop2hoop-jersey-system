/// <reference lib="deno.ns" />
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

type ShopifyLineItem = {
  id?: number | string;
  quantity?: number;
  properties?: any;
};

type ShopifyOrderPayload = {
  id?: number | string;
  order_number?: number | string;
  name?: string;
  line_items?: ShopifyLineItem[];
};

function json(resBody: any, status = 200) {
  return new Response(JSON.stringify(resBody), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function safeGetHeader(req: Request, name: string) {
  return (req.headers.get(name) || req.headers.get(name.toLowerCase()) || "").trim();
}

// Shopify sends HMAC as base64 of HMAC-SHA256(raw_body, secret)
async function verifyShopifyHmac(rawBody: string, hmacBase64: string, secret: string) {
  if (!rawBody || !hmacBase64 || !secret) return false;

  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );

  const sigBuf = await crypto.subtle.sign("HMAC", key, enc.encode(rawBody));
  const sigB64 = btoa(String.fromCharCode(...new Uint8Array(sigBuf)));

  // constant-time-ish compare
  if (sigB64.length !== hmacBase64.length) return false;
  let out = 0;
  for (let i = 0; i < sigB64.length; i++) out |= sigB64.charCodeAt(i) ^ hmacBase64.charCodeAt(i);
  return out === 0;
}

// Shopify line_item.properties can be array [{name,value}] or object {key:value}
function readProperty(props: any, key: string): string {
  if (!props) return "";
  const target = key.toLowerCase().trim();

  // Array form
  if (Array.isArray(props)) {
    for (const p of props) {
      const n = String(p?.name ?? "").toLowerCase().trim();
      if (n === target) return String(p?.value ?? "").trim();
    }
  }

  // Object form
  if (typeof props === "object") {
    for (const k of Object.keys(props)) {
      if (String(k).toLowerCase().trim() === target) return String(props[k] ?? "").trim();
    }
  }

  return "";
}

async function tryLogEvent(supabaseAdmin: any, payload: any) {
  // Optional: only works if you create a webhook_events table later.
  // If it doesn't exist, we silently ignore.
  try {
    await supabaseAdmin.from("webhook_events").insert({
      topic: payload.topic ?? null,
      order_id: payload.order_id ?? null,
      order_number: payload.order_number ?? null,
      reservation_id: payload.reservation_id ?? null,
      level: payload.level ?? "info",
      message: payload.message ?? null,
      meta: payload.meta ?? null,
    });
  } catch (_) {
    // ignore
  }
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ ok: false, error: "Method not allowed" }, 405);

  const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
  const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
  const SHOPIFY_WEBHOOK_SECRET = Deno.env.get("SHOPIFY_WEBHOOK_SECRET") || "";

  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return json({ ok: false, error: "Missing Supabase env vars" }, 500);
  }
  if (!SHOPIFY_WEBHOOK_SECRET) {
    return json({ ok: false, error: "Missing SHOPIFY_WEBHOOK_SECRET" }, 500);
  }

  const rawBody = await req.text();

  const hmacHeader = safeGetHeader(req, "x-shopify-hmac-sha256");
  const okHmac = await verifyShopifyHmac(rawBody, hmacHeader, SHOPIFY_WEBHOOK_SECRET);
  if (!okHmac) return json({ ok: false, error: "Invalid webhook signature" }, 401);

  let order: ShopifyOrderPayload;
  try {
    order = JSON.parse(rawBody);
  } catch {
    return json({ ok: false, error: "Invalid JSON body" }, 400);
  }

  const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  });

  const orderId = String(order?.id ?? "");
  const orderNumber = String(order?.order_number ?? order?.name ?? "");

  const lineItems = Array.isArray(order?.line_items) ? order.line_items : [];

  // Process each jersey line that includes Reservation ID
  const results: any[] = [];
  const nowIso = new Date().toISOString();

  for (const li of lineItems) {
    const props = li.properties;

    const reservationId = readProperty(props, "Reservation ID");
    const jerseyNumber = readProperty(props, "Jersey Number");

    if (!reservationId) continue; // ignore non-widget items

    const qty = Number(li.quantity ?? 1);
    const lineItemId = String(li.id ?? "");

    // Safety: your system only reserves ONE inventory row per reservation id
    // If Shopify cart quantity was increased, we will:
    // - mark the reservation as purchased once
    // - flag this line for manual review
    const qtyIssue = Number.isFinite(qty) && qty > 1;

    // 1) Load the pending allocation
    const { data: pending, error: pErr } = await supabaseAdmin
      .from("pending_allocations")
      .select("id, status, expires_at, inventory_id, club_id, jersey_number, size, season_year, year_of_birth")
      .eq("id", reservationId)
      .maybeSingle();

    if (pErr || !pending) {
      results.push({
        reservationId,
        ok: false,
        error: "Reservation ID not found in pending_allocations",
        lineItemId,
        qty,
      });
      await tryLogEvent(supabaseAdmin, {
        topic: "orders/create",
        order_id: orderId,
        order_number: orderNumber,
        reservation_id: reservationId,
        level: "error",
        message: "Reservation ID not found",
        meta: { lineItemId, qty, jerseyNumber },
      });
      continue;
    }

    // If already purchased, idempotent success
    if (pending.status === "purchased") {
      results.push({
        reservationId,
        ok: true,
        alreadyPurchased: true,
        lineItemId,
        qty,
      });
      continue;
    }

    // If expired/cancelled, do NOT re-allocate silently. Flag for manual review.
    const expiresAtMs = Date.parse(String(pending.expires_at));
    const isExpiredByTime = Number.isFinite(expiresAtMs) ? expiresAtMs < Date.now() : false;

    if (pending.status !== "reserved" || isExpiredByTime) {
      results.push({
        reservationId,
        ok: false,
        error: "Reservation is not active (expired/cancelled/not reserved). Manual review needed.",
        status: pending.status,
        lineItemId,
        qty,
      });

      await tryLogEvent(supabaseAdmin, {
        topic: "orders/create",
        order_id: orderId,
        order_number: orderNumber,
        reservation_id: reservationId,
        level: "error",
        message: "Reservation not active at order create",
        meta: { status: pending.status, isExpiredByTime, lineItemId, qty, jerseyNumber },
      });
      continue;
    }

    // 2) Mark pending allocation purchased
    const { error: uErr } = await supabaseAdmin
      .from("pending_allocations")
      .update({
        status: "purchased",
        purchased_at: nowIso,
        order_id: orderId || null,
        order_number: orderNumber || null,
        shopify_line_item_id: lineItemId || null,
      })
      .eq("id", reservationId)
      .eq("status", "reserved");

    if (uErr) {
      results.push({
        reservationId,
        ok: false,
        error: "Failed to update pending_allocations to purchased",
        lineItemId,
        qty,
      });
      await tryLogEvent(supabaseAdmin, {
        topic: "orders/create",
        order_id: orderId,
        order_number: orderNumber,
        reservation_id: reservationId,
        level: "error",
        message: "Failed to mark pending allocation purchased",
        meta: { lineItemId, qty, jerseyNumber, uErr: String(uErr.message ?? uErr) },
      });
      continue;
    }

    // 3) Ensure inventory stays Allocated (belt + braces)
    // (Widget already flips Available -> Allocated at reservation time)
    try {
      await supabaseAdmin
        .from("inventory")
        .update({ status: "Allocated" })
        .eq("id", pending.inventory_id);
    } catch (_) {
      // ignore - not critical
    }

    if (qtyIssue) {
      await tryLogEvent(supabaseAdmin, {
        topic: "orders/create",
        order_id: orderId,
        order_number: orderNumber,
        reservation_id: reservationId,
        level: "warn",
        message: "Line item quantity > 1 for a reserved jersey. Manual review needed.",
        meta: { qty, jerseyNumber, lineItemId },
      });
    }

    results.push({
      reservationId,
      ok: true,
      purchased: true,
      lineItemId,
      qty,
      warning: qtyIssue ? "quantity_gt_1_manual_review" : null,
    });
  }

  return json({ ok: true, processed: results.length, results });
});
