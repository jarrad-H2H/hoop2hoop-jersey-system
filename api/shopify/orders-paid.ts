// FILE: api/shopify/orders-paid.ts
import crypto from "crypto";
import { createClient } from "@supabase/supabase-js";

function timingSafeEqual(a: string, b: string) {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

async function readRawBody(req: any): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks);
}

function verifyShopifyHmac(rawBody: Buffer, hmacHeader: string | undefined, secret: string) {
  if (!hmacHeader) return false;
  const digest = crypto.createHmac("sha256", secret).update(rawBody).digest("base64");
  return timingSafeEqual(digest, hmacHeader);
}

function getLineItemProperty(lineItem: any, keyName: string): string | null {
  const props = lineItem?.properties;
  if (!Array.isArray(props)) return null;
  const hit = props.find((p: any) => String(p?.name || "").trim() === keyName);
  if (!hit) return null;
  const v = hit?.value;
  if (v === null || v === undefined) return null;
  return String(v).trim();
}

export default async function handler(req: any, res: any) {
  if (req.method !== "POST") {
    res.status(405).send("Method Not Allowed");
    return;
  }

  const SHOPIFY_SECRET = process.env.SHOPIFY_WEBHOOK_SECRET || "";
  const SUPABASE_URL = process.env.SUPABASE_URL || "";
  const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";

  if (!SHOPIFY_SECRET || !SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    res.status(500).send("Server not configured");
    return;
  }

  const rawBody = await readRawBody(req);

  // Shopify HMAC header (REST-style webhooks)
  const hmacHeader =
    (req.headers["x-shopify-hmac-sha256"] as string) ||
    (req.headers["X-Shopify-Hmac-Sha256"] as string);

  // Verify webhook authenticity
  const ok = verifyShopifyHmac(rawBody, hmacHeader, SHOPIFY_SECRET);
  if (!ok) {
    res.status(401).send("Invalid webhook signature");
    return;
  } // HMAC verification guidance is documented by Shopify. :contentReference[oaicite:2]{index=2}

  let payload: any;
  try {
    payload = JSON.parse(rawBody.toString("utf8"));
  } catch {
    res.status(400).send("Invalid JSON");
    return;
  }

  const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  });

  const orderId = payload?.id ? String(payload.id) : null;
  const orderNumber = payload?.name ? String(payload.name) : null;
  const lineItems = Array.isArray(payload?.line_items) ? payload.line_items : [];

  // For each line item, finalize reservation if it contains our reservation id
  for (const li of lineItems) {
    const reservationId = getLineItemProperty(li, "H2H Reservation ID");
    if (!reservationId) continue;

    const jerseyNumberStr = getLineItemProperty(li, "Jersey Number");
    const shopifyLineItemId = li?.id ? String(li.id) : null;

    // Mark pending allocation purchased (this effectively removes it from "active pending")
    const { error } = await supabaseAdmin
      .from("pending_allocations")
      .update({
        status: "purchased",
        purchased_at: new Date().toISOString(),
        order_id: orderId,
        order_number: orderNumber,
        shopify_line_item_id: shopifyLineItemId,
      })
      .eq("id", reservationId)
      .eq("status", "reserved");

    if (error) {
      // Don’t fail the whole webhook - log and continue
      console.error("Failed to finalize pending allocation", {
        reservationId,
        orderId,
        jerseyNumberStr,
        error: error.message,
      });
    }
  }

  // Always 200 so Shopify doesn't keep retrying unless we truly want retries
  res.status(200).send("OK");
}
