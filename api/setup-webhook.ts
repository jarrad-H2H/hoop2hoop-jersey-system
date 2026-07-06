import type { VercelRequest, VercelResponse } from "@vercel/node";

const SHOP = "cimc-hoop2hoop.myshopify.com";
const WEBHOOK_URL = "https://hoop2hoop-jersey-system.vercel.app/api/shopify/orders-create";
const API_BASE = `https://${SHOP}/admin/api/2024-01`;

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const token = process.env.SHOPIFY_ADMIN_TOKEN;
  if (!token) return res.status(500).json({ error: "SHOPIFY_ADMIN_TOKEN not set" });

  const headers = { "X-Shopify-Access-Token": token, "Content-Type": "application/json" };

  // 1. List all existing webhooks
  const listRes = await fetch(`${API_BASE}/webhooks.json`, { headers });
  const listData = await listRes.json() as { webhooks?: Array<{ id: number; topic: string; address: string }> };
  const existing = (listData.webhooks ?? []).filter(
    (w) => w.topic === "orders/create" && w.address === WEBHOOK_URL
  );

  // 2. Delete any conflicting registrations
  const deleted: number[] = [];
  for (const w of existing) {
    const delRes = await fetch(`${API_BASE}/webhooks/${w.id}.json`, { method: "DELETE", headers });
    if (delRes.ok || delRes.status === 204) deleted.push(w.id);
  }

  // 3. Register fresh
  const createRes = await fetch(`${API_BASE}/webhooks.json`, {
    method: "POST",
    headers,
    body: JSON.stringify({ webhook: { topic: "orders/create", address: WEBHOOK_URL, format: "json" } }),
  });
  const createData = await createRes.json();

  return res.status(createRes.ok ? 200 : 400).json({ deleted, result: createData });
}
