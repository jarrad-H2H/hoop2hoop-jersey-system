import type { VercelRequest, VercelResponse } from "@vercel/node";

// TEMPORARY one-use endpoint — delete this file after running.
// Visit: https://YOUR_VERCEL_URL/api/setup-script-tag?confirm=yes
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.query.confirm !== "yes") {
    return res.status(400).json({ error: "Add ?confirm=yes to the URL to proceed." });
  }

  const token = process.env.SHOPIFY_ADMIN_TOKEN;
  if (!token) {
    return res.status(500).json({ error: "SHOPIFY_ADMIN_TOKEN not set in environment." });
  }

  // Vercel injects VERCEL_PROJECT_PRODUCTION_URL for the production domain
  const host =
    process.env.VERCEL_PROJECT_PRODUCTION_URL ||
    process.env.VERCEL_URL ||
    req.headers.host;

  const widgetSrc = `https://${host}/widget.js`;

  const shopDomain = process.env.SHOPIFY_STORE_DOMAIN || "cimc-hoop2hoop.myshopify.com";

  const response = await fetch(
    `https://${shopDomain}/admin/api/2025-10/script_tags.json`,
    {
      method: "POST",
      headers: {
        "X-Shopify-Access-Token": token,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        script_tag: {
          event: "onload",
          src: widgetSrc,
        },
      }),
    }
  );

  const data = await response.json();

  if (!response.ok) {
    return res.status(response.status).json({ error: "Shopify API error", details: data });
  }

  return res.status(200).json({
    success: true,
    message: "ScriptTag registered. Delete api/setup-script-tag.ts now.",
    script_tag: data.script_tag,
    widget_src: widgetSrc,
  });
}
