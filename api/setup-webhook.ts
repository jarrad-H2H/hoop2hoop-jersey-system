// ONE-USE endpoint — register the orders/create Shopify webhook.
// Hit once, then delete this file and deploy again.
import type { VercelRequest, VercelResponse } from "@vercel/node";

export default async function handler(_req: VercelRequest, res: VercelResponse) {
  const token = process.env.SHOPIFY_ADMIN_TOKEN;
  if (!token) return res.status(500).json({ error: "SHOPIFY_ADMIN_TOKEN not set" });

  const shop = "cimc-hoop2hoop.myshopify.com";
  const callbackUrl = "https://hoop2hoop-jersey-system.vercel.app/api/shopify/orders-create";

  const response = await fetch(
    `https://${shop}/admin/api/2024-01/webhooks.json`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": token,
      },
      body: JSON.stringify({
        webhook: {
          topic: "orders/create",
          address: callbackUrl,
          format: "json",
        },
      }),
    }
  );

  const data = await response.json();
  return res.status(response.status).json(data);
}
