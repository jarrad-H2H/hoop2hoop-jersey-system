import type { VercelRequest, VercelResponse } from "@vercel/node";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const token = process.env.SHOPIFY_ADMIN_TOKEN;
  if (!token) return res.status(500).json({ error: "SHOPIFY_ADMIN_TOKEN not set" });

  const shop = "cimc-hoop2hoop.myshopify.com";
  const webhookUrl = "https://hoop2hoop-jersey-system.vercel.app/api/shopify/orders-create";

  const response = await fetch(`https://${shop}/admin/api/2024-01/webhooks.json`, {
    method: "POST",
    headers: {
      "X-Shopify-Access-Token": token,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      webhook: {
        topic: "orders/create",
        address: webhookUrl,
        format: "json",
      },
    }),
  });

  const data = await response.json();
  return res.status(response.ok ? 200 : 400).json(data);
}
