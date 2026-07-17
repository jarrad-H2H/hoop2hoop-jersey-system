// FILE: api/preorder/sync-orders.ts
// After pre-order finalisation, writes each player's allocated jersey number
// back to their Shopify line item properties so it appears on the packing slip.
// POST { orders: [{shopifyOrderId, shopifyLineItemId, jerseyNumber}] } — requires authenticated admin JWT.
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { createClient } from "@supabase/supabase-js";

export const maxDuration = 60;

const SHOPIFY_API_VERSION = "2024-01";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ ok: false, error: "Method Not Allowed" });
  }

  const SUPABASE_URL = process.env.SUPABASE_URL ?? "";
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
  const STORE_DOMAIN = process.env.SHOPIFY_STORE_DOMAIN ?? "";
  const ADMIN_TOKEN = process.env.SHOPIFY_ADMIN_TOKEN ?? "";

  if (!SUPABASE_URL || !SERVICE_KEY) {
    return res.status(500).json({ ok: false, error: "Supabase not configured" });
  }
  if (!STORE_DOMAIN || !ADMIN_TOKEN) {
    return res.status(500).json({ ok: false, error: "Shopify not configured — set SHOPIFY_STORE_DOMAIN and SHOPIFY_ADMIN_TOKEN in Vercel env" });
  }

  // Verify caller is an authenticated admin
  const supabase = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });
  const token = (req.headers.authorization ?? "").replace(/^Bearer\s+/i, "").trim();
  if (!token) return res.status(401).json({ ok: false, error: "Unauthorized" });

  const { data: { user } } = await supabase.auth.getUser(token);
  if (!user) return res.status(401).json({ ok: false, error: "Unauthorized" });

  const { data: adminRow } = await supabase
    .from("admin_users")
    .select("user_id")
    .eq("user_id", user.id)
    .maybeSingle();
  if (!adminRow) return res.status(403).json({ ok: false, error: "Admin access required" });

  // Parse body
  const body = req.body ?? {};
  const raw: Array<{ shopifyOrderId: string; shopifyLineItemId: string; jerseyNumber: number }> =
    Array.isArray(body.orders) ? body.orders : [];

  if (raw.length === 0) {
    return res.status(200).json({ ok: true, updated: 0, errors: [] });
  }

  // Group by shopifyOrderId — one PUT per order even when a parent bought for two kids
  const grouped = new Map<string, Array<{ lineItemId: string; jerseyNumber: number }>>();
  for (const o of raw) {
    const orderId = String(o.shopifyOrderId ?? "").trim();
    const lineItemId = String(o.shopifyLineItemId ?? "").trim();
    if (!orderId || !lineItemId) continue;
    if (!grouped.has(orderId)) grouped.set(orderId, []);
    grouped.get(orderId)!.push({ lineItemId, jerseyNumber: Number(o.jerseyNumber) });
  }

  let updated = 0;
  const errors: string[] = [];

  const results = await Promise.allSettled(
    Array.from(grouped.entries()).map(async ([shopifyOrderId, items]) => {
      // One PUT per order: send only the line items being updated.
      // Shopify updates those line items in place, leaving all others untouched.
      // properties is a full replacement — this clears all _h2h_* pre-order fields
      // and writes just "Jersey Number: 42" for a clean packing slip.
      const lineItemsPayload = items.map(({ lineItemId, jerseyNumber }) => ({
        id: Number(lineItemId),
        properties: [{ name: "Jersey Number", value: String(jerseyNumber) }],
      }));

      const url = `https://${STORE_DOMAIN}/admin/api/${SHOPIFY_API_VERSION}/orders/${shopifyOrderId}.json`;
      const resp = await fetch(url, {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          "X-Shopify-Access-Token": ADMIN_TOKEN,
        },
        body: JSON.stringify({
          order: { id: Number(shopifyOrderId), line_items: lineItemsPayload },
        }),
      });

      if (!resp.ok) {
        const text = await resp.text().catch(() => resp.statusText);
        throw new Error(`Order ${shopifyOrderId}: HTTP ${resp.status} — ${text.slice(0, 200)}`);
      }
    })
  );

  for (const r of results) {
    if (r.status === "fulfilled") updated++;
    else errors.push((r.reason as Error)?.message ?? "unknown error");
  }

  return res.status(200).json({ ok: true, updated, errors });
}
