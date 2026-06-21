// FILE: api/shopify-sync.ts
// Syncs available jersey inventory counts from Supabase → Shopify variant stock levels.
// POST /api/shopify-sync  { clubId: string }
// A club may have multiple Shopify products (e.g. mens + womens). All are synced in one call.

import type { VercelRequest, VercelResponse } from "@vercel/node";
import { createClient } from "@supabase/supabase-js";

const SHOPIFY_API_VERSION = "2024-01";

function shopifyFetch(
  path: string,
  options: RequestInit = {}
): Promise<Response> {
  const domain = process.env.SHOPIFY_STORE_DOMAIN ?? "";
  const token = process.env.SHOPIFY_ADMIN_TOKEN ?? "";

  return fetch(
    `https://${domain}/admin/api/${SHOPIFY_API_VERSION}/${path}`,
    {
      ...options,
      headers: {
        "X-Shopify-Access-Token": token,
        "Content-Type": "application/json",
        ...(options.headers ?? {}),
      },
    }
  );
}

async function syncProduct(
  productId: string,
  gender: string,
  countsBySize: Record<string, number>,
  locationId: number
): Promise<{
  productId: string;
  gender: string;
  success: boolean;
  results: {
    variantTitle: string;
    inventoryItemId: number;
    available: number;
    matched: boolean;
    ok: boolean;
    status?: number;
  }[];
  warnings: {
    unmatchedVariants?: string[];
    unmatchedSizes?: string[];
  };
}> {
  // Fetch Shopify variants for this product
  const variantsRes = await shopifyFetch(
    `products/${productId}/variants.json?limit=250`
  );
  if (!variantsRes.ok) {
    const text = await variantsRes.text();
    console.error("shopify-sync: variants fetch error", productId, variantsRes.status, text);
    return {
      productId,
      gender,
      success: false,
      results: [],
      warnings: {},
    };
  }
  const { variants } = (await variantsRes.json()) as {
    variants: { id: number; title: string; inventory_item_id: number }[];
  };

  const results: {
    variantTitle: string;
    inventoryItemId: number;
    available: number;
    matched: boolean;
    ok: boolean;
    status?: number;
  }[] = [];

  for (const variant of variants) {
    const sizeLabel = variant.title.trim();
    const matched = sizeLabel in countsBySize;
    const available = countsBySize[sizeLabel] ?? 0;

    const setRes = await shopifyFetch("inventory_levels/set.json", {
      method: "POST",
      body: JSON.stringify({
        location_id: locationId,
        inventory_item_id: variant.inventory_item_id,
        available,
      }),
    });

    results.push({
      variantTitle: sizeLabel,
      inventoryItemId: variant.inventory_item_id,
      available,
      matched,
      ok: setRes.ok,
      status: setRes.status,
    });

    if (!setRes.ok) {
      const text = await setRes.text();
      console.error(
        `shopify-sync: set inventory failed for product ${productId} variant "${sizeLabel}"`,
        setRes.status,
        text
      );
    }
  }

  const allOk = results.every((r) => r.ok);
  const unmatchedVariants = results.filter((r) => !r.matched).map((r) => r.variantTitle);
  const unmatchedSizes = Object.keys(countsBySize).filter(
    (s) => !variants.some((v) => v.title.trim() === s)
  );

  return {
    productId,
    gender,
    success: allOk,
    results,
    warnings: {
      unmatchedVariants: unmatchedVariants.length > 0 ? unmatchedVariants : undefined,
      unmatchedSizes: unmatchedSizes.length > 0 ? unmatchedSizes : undefined,
    },
  };
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { clubId } = req.body as { clubId?: string };
  if (!clubId) {
    return res.status(400).json({ error: "clubId is required" });
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !supabaseKey) {
    return res.status(500).json({ error: "Supabase env vars not configured" });
  }
  if (!process.env.SHOPIFY_ADMIN_TOKEN || !process.env.SHOPIFY_STORE_DOMAIN) {
    return res.status(500).json({ error: "Shopify env vars not configured" });
  }

  const supabase = createClient(supabaseUrl, supabaseKey);

  // 1. Look up ALL Shopify products mapped to this club (may be multiple — e.g. mens + womens)
  const { data: mappings, error: mapErr } = await supabase
    .from("shopify_product_club_map")
    .select("shopify_product_id, gender")
    .eq("club_id", clubId);

  if (mapErr) {
    console.error("shopify-sync: mapping lookup error", mapErr);
    return res.status(500).json({ error: "Failed to look up product mappings" });
  }
  if (!mappings || mappings.length === 0) {
    return res.status(404).json({ error: "No Shopify products mapped for this club" });
  }

  // 2. Count available jerseys per size
  const { data: inventory, error: invErr } = await supabase
    .from("inventory")
    .select("size")
    .eq("club_id", clubId)
    .eq("status", "Available");

  if (invErr) {
    console.error("shopify-sync: inventory lookup error", invErr);
    return res.status(500).json({ error: "Failed to read inventory" });
  }

  const countsBySize: Record<string, number> = {};
  for (const row of inventory ?? []) {
    const size = String(row.size ?? "").trim();
    if (size) countsBySize[size] = (countsBySize[size] ?? 0) + 1;
  }

  // 3. Fetch Shopify locations (use first active location)
  const locationsRes = await shopifyFetch("locations.json");
  if (!locationsRes.ok) {
    const text = await locationsRes.text();
    console.error("shopify-sync: locations fetch error", locationsRes.status, text);
    return res.status(502).json({ error: `Shopify locations fetch failed: ${locationsRes.status}` });
  }
  const { locations } = (await locationsRes.json()) as {
    locations: { id: number; name: string; active: boolean }[];
  };

  const activeLocation = locations.find((l) => l.active) ?? locations[0];
  if (!activeLocation) {
    return res.status(502).json({ error: "No Shopify location found" });
  }

  // 4. Sync each product
  const productResults = await Promise.all(
    (mappings as { shopify_product_id: string; gender: string }[]).map((m) =>
      syncProduct(m.shopify_product_id, m.gender, countsBySize, activeLocation.id)
    )
  );

  const allOk = productResults.every((r) => r.success);

  return res.status(200).json({
    success: allOk,
    location: activeLocation.name,
    products: productResults,
  });
}
