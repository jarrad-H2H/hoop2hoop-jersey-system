// FILE: api/shopify/orders-cancelled.ts
// Handles Shopify orders/cancelled webhook.
// Removes MTO preorder_requests records and returns stock-mode inventory to Available.
import type { VercelRequest, VercelResponse } from "@vercel/node";
import crypto from "crypto";
import { createClient } from "@supabase/supabase-js";

export const config = { api: { bodyParser: false } };

function readRawBody(req: VercelRequest): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => (data += chunk));
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

function verifyShopifyHmac(rawBody: string, hmacHeader: string | undefined, secret: string): boolean {
  if (!hmacHeader) return false;
  const digest = crypto.createHmac("sha256", secret).update(rawBody, "utf8").digest("base64");
  try {
    const a = Buffer.from(digest, "utf8");
    const b = Buffer.from(hmacHeader, "utf8");
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  } catch { return false; }
}

async function logEvent(supabase: any, event: {
  order_id?: string | null; order_number?: string | null;
  level?: "info" | "warn" | "error"; message: string; meta?: any;
}) {
  try {
    await supabase.from("webhook_events").insert({
      topic: "orders/cancelled",
      order_id: event.order_id ?? null,
      order_number: event.order_number ?? null,
      reservation_id: null,
      level: event.level ?? "info",
      message: event.message,
      meta: event.meta ?? null,
    });
  } catch { /* logging must not break webhook processing */ }
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ ok: false, error: "Method Not Allowed" });
  }

  const SUPABASE_URL = process.env.SUPABASE_URL || "";
  const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
  const SHOPIFY_SECRET = process.env.SHOPIFY_WEBHOOK_SECRET || process.env.SHOPIFY_APP_SECRET || "";

  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY || !SHOPIFY_SECRET) {
    return res.status(500).json({ ok: false, error: "Server not configured" });
  }

  let rawBody = "";
  try { rawBody = await readRawBody(req); } catch {
    return res.status(400).json({ ok: false, error: "Failed to read body." });
  }

  const hmacHeader = (req.headers["x-shopify-hmac-sha256"] as string | undefined) ?? undefined;
  if (!verifyShopifyHmac(rawBody, hmacHeader, SHOPIFY_SECRET)) {
    return res.status(401).json({ ok: false, error: "Invalid webhook signature." });
  }

  let payload: any;
  try { payload = JSON.parse(rawBody); } catch {
    return res.status(400).json({ ok: false, error: "Invalid JSON." });
  }

  const orderId = payload?.id != null ? String(payload.id) : "";
  const orderNumber = payload?.order_number != null ? String(payload.order_number)
    : payload?.name != null ? String(payload.name) : "";

  if (!orderId) return res.status(200).json({ ok: true, note: "No order id in payload." });

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  });

  let actions = 0;

  // ── 1. MTO: remove preorder_requests rows for this order ───────────────────
  const { data: poRows, error: poFetchErr } = await supabase
    .from("preorder_requests")
    .select("id")
    .eq("shopify_order_id", orderId);

  if (poFetchErr) {
    await logEvent(supabase, { order_id: orderId, order_number: orderNumber, level: "error",
      message: "Failed to query preorder_requests on cancellation", meta: { detail: poFetchErr.message } });
  } else if (poRows && poRows.length > 0) {
    const ids = (poRows as any[]).map(r => r.id);
    const { error: poDelErr } = await supabase
      .from("preorder_requests")
      .delete()
      .in("id", ids);
    if (poDelErr) {
      await logEvent(supabase, { order_id: orderId, order_number: orderNumber, level: "error",
        message: "Failed to delete preorder_requests on cancellation", meta: { detail: poDelErr.message } });
    } else {
      actions += ids.length;
      await logEvent(supabase, { order_id: orderId, order_number: orderNumber, level: "info",
        message: `Cancelled: removed ${ids.length} preorder_request(s)`, meta: { ids } });
    }
  }

  // ── 2. Stock-mode: return Allocated inventory to Available ─────────────────
  // Find our orders records for this Shopify order to get the reservation_id,
  // then trace it back to the inventory row.
  const { data: ourOrders, error: ordFetchErr } = await supabase
    .from("orders")
    .select("reservation_id")
    .eq("shopify_order_id", orderId);

  if (ordFetchErr) {
    await logEvent(supabase, { order_id: orderId, order_number: orderNumber, level: "error",
      message: "Failed to query orders table on cancellation", meta: { detail: ordFetchErr.message } });
  } else {
    for (const row of (ourOrders ?? []) as any[]) {
      const reservationId = row.reservation_id;
      if (!reservationId) continue;

      const { data: pa } = await supabase
        .from("pending_allocations")
        .select("inventory_id, product_type")
        .eq("id", reservationId)
        .maybeSingle();

      const invId = (pa as any)?.inventory_id;
      if (!invId) continue;

      const { data: returned } = await supabase
        .from("inventory")
        .update({ status: "Available", allocation_date: null })
        .eq("id", invId)
        .eq("status", "Allocated")
        .select("id");

      if (returned && returned.length > 0) {
        actions += 1;
        await logEvent(supabase, { order_id: orderId, order_number: orderNumber, level: "info",
          message: "Cancelled: returned inventory to Available", meta: { invId, reservationId } });
      }
    }
  }

  if (actions === 0) {
    await logEvent(supabase, { order_id: orderId, order_number: orderNumber, level: "info",
      message: "Cancellation webhook received — no matching records found (may have already been cleaned up)" });
  }

  return res.status(200).json({ ok: true, orderId, orderNumber, actions });
}
