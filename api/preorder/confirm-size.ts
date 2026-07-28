// FILE: api/preorder/confirm-size.ts
// Called by the widget's pre-allocated form after the player confirms their jersey name and size.
// Updates the preorder_requests row with size + jersey_name and advances status to 'allocated'.
// POST { preorderRequestId, jerseyName, size }
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { createClient } from "@supabase/supabase-js";

export const maxDuration = 15;

const JERSEY_NAME_RE = /^[A-Za-z'\-]+$/;

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ ok: false, error: "Method Not Allowed" });
  }

  const SUPABASE_URL = process.env.SUPABASE_URL ?? "";
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
  if (!SUPABASE_URL || !SERVICE_KEY) {
    return res.status(500).json({ ok: false, error: "Server not configured" });
  }

  const body = req.body ?? {};
  const preorderRequestId = String(body.preorderRequestId ?? "").trim();
  const jerseyName = String(body.jerseyName ?? "").trim().toUpperCase();
  const size = String(body.size ?? "").trim();
  const shopifyProductId = String(body.shopifyProductId ?? "").trim() || null;

  if (!preorderRequestId) {
    return res.status(400).json({ ok: false, error: "preorderRequestId is required" });
  }
  if (!jerseyName) {
    return res.status(400).json({ ok: false, error: "jerseyName is required" });
  }
  if (!JERSEY_NAME_RE.test(jerseyName)) {
    return res.status(400).json({ ok: false, error: "Jersey name may only contain letters, hyphens, and apostrophes (no spaces)." });
  }
  if (jerseyName.length > 25) {
    return res.status(400).json({ ok: false, error: "Jersey name must be 25 characters or fewer." });
  }
  if (!size) {
    return res.status(400).json({ ok: false, error: "Size is required" });
  }

  const supabase = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

  // Fetch the row to verify it exists and is in a confirmable state
  const { data: existing, error: fetchErr } = await supabase
    .from("preorder_requests")
    .select("id, status, assigned_number, jersey_number_display, shopify_product_id, club_id, season, product_type, first_name, last_name, year_of_birth, gender, age_group")
    .eq("id", preorderRequestId)
    .maybeSingle();

  if (fetchErr) {
    return res.status(500).json({ ok: false, error: fetchErr.message });
  }
  if (!existing) {
    return res.status(404).json({ ok: false, error: "Record not found." });
  }
  if (existing.status === "locked") {
    return res.status(409).json({ ok: false, error: "This allocation has already been finalised and cannot be changed." });
  }
  if (!["needs_size", "allocated"].includes(existing.status)) {
    return res.status(409).json({ ok: false, error: `Cannot confirm size for a record with status '${existing.status}'.` });
  }

  // Detect second-product purchase: same player, different Shopify product.
  // When a player already has a confirmed row for product A and now orders via
  // product B (e.g. they bought the bundle and are now buying the standalone
  // singlet), create a new preorder_requests row rather than overwriting theirs.
  const isSecondProduct =
    shopifyProductId !== null &&
    existing.shopify_product_id !== null &&
    existing.shopify_product_id !== shopifyProductId;

  let confirmedId: string;

  if (isSecondProduct) {
    const { data: newRow, error: insertErr } = await supabase
      .from("preorder_requests")
      .insert({
        club_id: existing.club_id,
        season: existing.season,
        product_type: existing.product_type ?? "default",
        first_name: existing.first_name,
        last_name: existing.last_name,
        year_of_birth: existing.year_of_birth,
        gender: existing.gender ?? null,
        age_group: existing.age_group ?? null,
        assigned_number: existing.assigned_number,
        jersey_number_display: existing.jersey_number_display ?? null,
        jersey_name: jerseyName,
        size,
        status: "allocated",
        shopify_product_id: shopifyProductId,
        any_number: false,
      })
      .select("id")
      .single();

    if (insertErr) {
      return res.status(500).json({ ok: false, error: insertErr.message });
    }
    confirmedId = newRow.id;
  } else {
    // Update in place: first confirmation for this product, or re-confirming the same one.
    const { error: updateErr } = await supabase
      .from("preorder_requests")
      .update({
        jersey_name: jerseyName,
        size,
        status: "allocated",
        shopify_product_id: shopifyProductId ?? existing.shopify_product_id,
      })
      .eq("id", preorderRequestId);

    if (updateErr) {
      return res.status(500).json({ ok: false, error: updateErr.message });
    }
    confirmedId = preorderRequestId;
  }

  return res.status(200).json({ ok: true, assignedNumber: existing.assigned_number, jerseyName, size, preorderRequestId: confirmedId });
}
