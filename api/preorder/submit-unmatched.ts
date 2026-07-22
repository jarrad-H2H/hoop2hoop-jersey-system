// FILE: api/preorder/submit-unmatched.ts
// Called when a customer cannot find their record in the pre-allocated list.
// Creates a preorder_requests row with status='unmatched' and null assigned_number.
// The club reviews these in PreOrderManager and manually assigns a number before finalisation.
// POST { clubId, season?, productType?, firstName, lastName, yearOfBirth?, size }
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { createClient } from "@supabase/supabase-js";

export const maxDuration = 15;

const CURRENT_YEAR = String(new Date().getFullYear());

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
  const clubId = String(body.clubId ?? "").trim();
  const firstName = String(body.firstName ?? "").trim();
  const lastName = String(body.lastName ?? "").trim();
  const size = String(body.size ?? "").trim();
  const requestedSeason = String(body.season ?? "").trim();
  const productType = String(body.productType ?? "").trim() || "unisex";
  const yearOfBirth = Number(body.yearOfBirth);

  if (!clubId) return res.status(400).json({ ok: false, error: "clubId is required" });
  if (!firstName || !lastName) return res.status(400).json({ ok: false, error: "firstName and lastName are required" });
  if (!size) return res.status(400).json({ ok: false, error: "size is required" });

  const supabase = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

  // Verify the club's pre-order window is open
  const { data: club } = await supabase
    .from("clubs")
    .select("preorder_mode")
    .eq("id", clubId)
    .maybeSingle();

  if (!club || club.preorder_mode !== "open") {
    return res.status(409).json({ ok: false, error: "The pre-order window for this club is not currently open." });
  }

  // Infer the active season from existing records for this club so the unmatched
  // row lands in the same season bucket as the rest of the pre-order batch.
  let season = requestedSeason;
  if (!season) {
    const { data: latestRow } = await supabase
      .from("preorder_requests")
      .select("season")
      .eq("club_id", clubId)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    season = (latestRow as any)?.season ?? CURRENT_YEAR;
  }

  const { data, error } = await supabase
    .from("preorder_requests")
    .insert({
      club_id: clubId,
      season,
      product_type: productType,
      first_name: firstName,
      last_name: lastName,
      year_of_birth: Number.isFinite(yearOfBirth) && yearOfBirth > 1900 ? yearOfBirth : null,
      size,
      jersey_name: lastName.trim().toUpperCase(),
      status: "unmatched",
      assigned_number: null,
      any_number: false,
      pref_1: null,
      pref_2: null,
      pref_3: null,
    })
    .select("id")
    .single();

  if (error) {
    return res.status(500).json({ ok: false, error: error.message });
  }

  return res.status(200).json({ ok: true, preorderRequestId: (data as any).id });
}
