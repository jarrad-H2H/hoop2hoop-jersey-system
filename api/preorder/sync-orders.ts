// FILE: api/preorder/sync-orders.ts
// After pre-order finalisation, writes each player's allocated jersey number
// to the Shopify order as note_attributes so it appears on the packing slip.
// Single child:    "Jersey # - Sophie Test: 10"
// Multi-child:     one note_attribute per child, each clearly labelled
// POST { orders: [{shopifyOrderId, shopifyLineItemId, jerseyNumber, firstName, lastName}] }
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
  const raw: Array<{ shopifyOrderId: string; shopifyLineItemId: string; jerseyNumber: number; jerseyNumberDisplay?: string | null; firstName: string; lastName: string; jerseyName?: string | null }> =
    Array.isArray(body.orders) ? body.orders : [];

  if (raw.length === 0) {
    return res.status(200).json({ ok: true, updated: 0, errors: [] });
  }

  // Group by shopifyOrderId — one PUT per order even when a parent bought for two kids
  const grouped = new Map<string, Array<{ jerseyNumber: number; jerseyNumberDisplay: string | null; firstName: string; lastName: string; jerseyName: string | null }>>();
  for (const o of raw) {
    const orderId = String(o.shopifyOrderId ?? "").trim();
    if (!orderId) continue;
    if (!grouped.has(orderId)) grouped.set(orderId, []);
    grouped.get(orderId)!.push({
      jerseyNumber: Number(o.jerseyNumber),
      jerseyNumberDisplay: o.jerseyNumberDisplay ? String(o.jerseyNumberDisplay).trim() : null,
      firstName: String(o.firstName ?? "").trim(),
      lastName: String(o.lastName ?? "").trim(),
      jerseyName: o.jerseyName ? String(o.jerseyName).trim() : null,
    });
  }

  let updated = 0;
  const errors: string[] = [];

  const results = await Promise.allSettled(
    Array.from(grouped.entries()).map(async ([shopifyOrderId, players]) => {
      const baseUrl = `https://${STORE_DOMAIN}/admin/api/${SHOPIFY_API_VERSION}`;
      const headers = { "Content-Type": "application/json", "X-Shopify-Access-Token": ADMIN_TOKEN };

      // GET existing order note so we can append rather than overwrite
      const getResp = await fetch(`${baseUrl}/orders/${shopifyOrderId}.json?fields=id,note`, { headers });
      if (!getResp.ok) {
        const text = await getResp.text().catch(() => getResp.statusText);
        throw new Error(`Order ${shopifyOrderId} GET: HTTP ${getResp.status} — ${text.slice(0, 200)}`);
      }
      const { order: existingOrder } = await getResp.json() as { order: { id: number; note: string | null } };

      // Build the jersey allocation block — one line per player
      // Pre-allocated mode supplies a confirmed jersey name (last name only);
      // FCFS mode uses the full first+last name from the order.
      const allocationLines = players
        .map(p => {
          const displayName = p.jerseyName ? p.jerseyName : `${p.firstName} ${p.lastName}`;
          return `${displayName} — Jersey #${p.jerseyNumberDisplay ?? p.jerseyNumber}`;
        })
        .join("\n");
      const allocationBlock = `JERSEY ALLOCATIONS:\n${allocationLines}`;

      // Append to existing note if present, otherwise set as the note
      const existingNote = (existingOrder.note ?? "").trim();
      const newNote = existingNote ? `${existingNote}\n\n${allocationBlock}` : allocationBlock;

      const putResp = await fetch(`${baseUrl}/orders/${shopifyOrderId}.json`, {
        method: "PUT",
        headers,
        body: JSON.stringify({ order: { id: Number(shopifyOrderId), note: newNote } }),
      });

      if (!putResp.ok) {
        const text = await putResp.text().catch(() => putResp.statusText);
        throw new Error(`Order ${shopifyOrderId} PUT: HTTP ${putResp.status} — ${text.slice(0, 200)}`);
      }
    })
  );

  for (const r of results) {
    if (r.status === "fulfilled") updated++;
    else errors.push((r.reason as Error)?.message ?? "unknown error");
  }

  return res.status(200).json({ ok: true, updated, errors });
}
