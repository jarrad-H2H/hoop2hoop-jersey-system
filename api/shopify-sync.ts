// FILE: api/shopify-sync.ts
// Syncs available jersey inventory counts from Supabase → Shopify variant stock levels.
// POST /api/shopify-sync  { clubId: string }
// A club may have multiple Shopify products (e.g. mens + womens). All are synced in one call.
// Uses GraphQL Admin API (inventorySetOnHandQuantities mutation).

import type { VercelRequest, VercelResponse } from "@vercel/node";
import { createClient } from "@supabase/supabase-js";

const SHOPIFY_API_VERSION = "2025-07";

function shopifyGraphQL(
  query: string,
  variables: Record<string, unknown> = {}
): Promise<Response> {
  const domain = process.env.SHOPIFY_STORE_DOMAIN ?? "";
  const token = process.env.SHOPIFY_ADMIN_TOKEN ?? "";

  return fetch(
    `https://${domain}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`,
    {
      method: "POST",
      headers: {
        "X-Shopify-Access-Token": token,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query, variables }),
    }
  );
}

interface VariantNode {
  id: string;
  title: string;
  inventoryItem: { id: string; tracked: boolean };
}

interface LocationNode {
  id: string;
  name: string;
  isActive: boolean;
}

async function getActiveLocation(): Promise<{ id: string; name: string } | null> {
  const res = await shopifyGraphQL(`
    query {
      locations(first: 10) {
        nodes { id name isActive }
      }
    }
  `);
  if (!res.ok) return null;
  const body = (await res.json()) as { data?: { locations?: { nodes: LocationNode[] } } };
  const nodes = body.data?.locations?.nodes ?? [];
  const active = nodes.find((l) => l.isActive) ?? nodes[0] ?? null;
  return active ? { id: active.id, name: active.name } : null;
}

async function getProductVariants(productGid: string): Promise<VariantNode[]> {
  const res = await shopifyGraphQL(
    `query getVariants($id: ID!) {
      product(id: $id) {
        variants(first: 250) {
          nodes {
            id
            title
            inventoryItem { id tracked }
          }
        }
      }
    }`,
    { id: productGid }
  );
  if (!res.ok) return [];
  const body = (await res.json()) as {
    data?: { product?: { variants?: { nodes: VariantNode[] } } };
  };
  return body.data?.product?.variants?.nodes ?? [];
}

async function enableTrackingForVariants(variants: VariantNode[]): Promise<number> {
  const untracked = variants.filter((v) => !v.inventoryItem.tracked);
  if (untracked.length === 0) return 0;

  // Batch all updates into one GraphQL mutation using aliases
  const aliases = untracked
    .map(
      (v, i) =>
        `v${i}: inventoryItemUpdate(id: "${v.inventoryItem.id}", input: {tracked: true}) { userErrors { field message } }`
    )
    .join("\n");

  const res = await shopifyGraphQL(`mutation { ${aliases} }`);
  if (!res.ok) {
    const text = await res.text();
    console.error("shopify-sync: enableTracking HTTP error", res.status, text);
    return 0;
  }

  console.log(`shopify-sync: enabled inventory tracking on ${untracked.length} variant(s)`);
  return untracked.length;
}

async function syncProduct(
  productId: string,
  gender: string,
  countsBySize: Record<string, number>,
  locationId: string,
  locationName: string
): Promise<{
  productId: string;
  gender: string;
  success: boolean;
  results: { variantTitle: string; available: number; matched: boolean; ok: boolean }[];
  warnings: { unmatchedVariants?: string[]; unmatchedSizes?: string[] };
}> {
  const productGid = `gid://shopify/Product/${productId}`;
  const variants = await getProductVariants(productGid);

  if (variants.length === 0) {
    console.error("shopify-sync: no variants returned for product", productId);
    return { productId, gender, success: false, results: [], warnings: {} };
  }

  // Auto-enable inventory tracking on any variants that don't have it
  await enableTrackingForVariants(variants);

  // Build the setQuantities payload: one entry per variant
  const setQuantities = variants.map((v) => ({
    inventoryItemId: v.inventoryItem.id,
    locationId,
    quantity: countsBySize[v.title.trim()] ?? 0,
  }));

  const mutationRes = await shopifyGraphQL(
    `mutation setInventory($input: InventorySetOnHandQuantitiesInput!) {
      inventorySetOnHandQuantities(input: $input) {
        inventoryAdjustmentGroup { id }
        userErrors { field message }
      }
    }`,
    {
      input: {
        reason: "correction",
        setQuantities,
      },
    }
  );

  const mutationOk = mutationRes.ok;
  let userErrors: { field: string[]; message: string }[] = [];

  if (mutationOk) {
    const mutBody = (await mutationRes.json()) as {
      data?: {
        inventorySetOnHandQuantities?: {
          userErrors?: { field: string[]; message: string }[];
        };
      };
      errors?: unknown;
    };
    userErrors = mutBody.data?.inventorySetOnHandQuantities?.userErrors ?? [];
    if (!mutationOk || userErrors.length > 0) {
      console.error("shopify-sync: mutation userErrors", JSON.stringify(userErrors));
    }
  } else {
    const text = await mutationRes.text();
    console.error("shopify-sync: mutation HTTP error", mutationRes.status, text);
  }

  const overallOk = mutationOk && userErrors.length === 0;

  const results = variants.map((v) => {
    const sizeLabel = v.title.trim();
    return {
      variantTitle: sizeLabel,
      available: countsBySize[sizeLabel] ?? 0,
      matched: sizeLabel in countsBySize,
      ok: overallOk,
    };
  });

  const unmatchedVariants = results.filter((r) => !r.matched).map((r) => r.variantTitle);
  const unmatchedSizes = Object.keys(countsBySize).filter(
    (s) => !variants.some((v) => v.title.trim() === s)
  );

  return {
    productId,
    gender,
    success: overallOk,
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

  // 1. Look up ALL Shopify products mapped to this club
  const { data: mappings, error: mapErr } = await supabase
    .from("shopify_product_club_map")
    .select("shopify_product_id, gender, product_type")
    .eq("club_id", clubId);

  if (mapErr) {
    console.error("shopify-sync: mapping lookup error", mapErr);
    return res.status(500).json({ error: "Failed to look up product mappings" });
  }
  if (!mappings || mappings.length === 0) {
    return res.status(404).json({ error: "No Shopify products mapped for this club" });
  }

  // 2. Count available jerseys per size, per product_type
  const { data: inventory, error: invErr } = await supabase
    .from("inventory")
    .select("size, product_type")
    .eq("club_id", clubId)
    .eq("status", "Available");

  if (invErr) {
    console.error("shopify-sync: inventory lookup error", invErr);
    return res.status(500).json({ error: "Failed to read inventory" });
  }

  const countsByProductTypeAndSize: Record<string, Record<string, number>> = {};
  for (const row of inventory ?? []) {
    const size = String((row as { size: string }).size ?? "").trim();
    const productType =
      String((row as { product_type: string | null }).product_type ?? "default").trim() ||
      "default";
    if (!size) continue;
    countsByProductTypeAndSize[productType] ??= {};
    countsByProductTypeAndSize[productType][size] =
      (countsByProductTypeAndSize[productType][size] ?? 0) + 1;
  }

  // 3. Get active Shopify location (GraphQL)
  const location = await getActiveLocation();
  if (!location) {
    return res.status(502).json({ error: "No active Shopify location found" });
  }

  // 4. Sync each product against its own product_type counts
  const productResults = await Promise.all(
    (
      mappings as {
        shopify_product_id: string;
        gender: string;
        product_type: string;
      }[]
    ).map((m) =>
      syncProduct(
        m.shopify_product_id,
        m.gender,
        countsByProductTypeAndSize[m.product_type || "default"] ?? {},
        location.id,
        location.name
      )
    )
  );

  const allOk = productResults.every((r) => r.success);

  return res.status(200).json({
    success: allOk,
    location: location.name,
    products: productResults,
  });
}
