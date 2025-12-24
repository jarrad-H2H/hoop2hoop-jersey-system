// FILE: api/shopify/orders-create.ts
import type { VercelRequest, VercelResponse } from "@vercel/node";
import crypto from "crypto";
import { createClient } from "@supabase/supabase-js";

type ShopifyLineItemProperty =
  | { name?: string; value?: any }
  | { key?: string; value?: any };

type ShopifyLineItem = {
  id?: number | string;
  quantity?: number;
  properties?: any;
  name?: string;
};

type ShopifyOrderPayload = {
  id?: number | string;
  name?: string; // e.g. "#1001" (sometimes)
  order_number?: number | string;
  line_items?: ShopifyLineItem[];
  created_at?: string;
};

function readRawBody(req: VercelRequest): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => (data += chunk));
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

function timingSafeEqual(a: string, b: string): boolean {
  try {
    const ab = Buffer.from(a, "utf8");
    const bb = Buffer.from(b, "utf8");
    if (ab.length !== bb.length) return false;
    return crypto.timingSafeEqual(ab, bb);
  } catch {
    return false;
  }
}

function verifyShopifyHmac(rawBody: string, hmacHeader: string | undefined, secret: string): boolean {
  if (!hmacHeader) return false;
  const digest = crypto.createHmac("sha256", secret).update(rawBody, "utf8").digest("base64");
  return timingSafeEqual(digest, hmacHeader);
}

function normalizeKey(s: any): string {
  return String(s ?? "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

function extractProperties(props: any): { reservationId: string; jerseyNumber: string } {
  let reservationId = "";
  let jerseyNumber = "";

  // Shopify commonly returns properties as:
  // - array of { name, value }
  // - object map { "Reservation ID": "...", "Jersey Number": "..." }
  // - sometimes nested/odd shapes depending on app/theme
  if (Array.isArray(props)) {
    for (const p of props as ShopifyLineItemProperty[]) {
      const name = normalizeKey((p as any).name ?? (p as any).key);
      const value = (p as any).value;

      if (!name) continue;

      if (!reservationId) {
        if (name === "reservation id" || name.includes("reservation") || name.includes("pending allocation")) {
          reservationId = String(value ?? "").trim();
        }
      }

      if (!jerseyNumber) {
        if (name === "jersey number" || (name.includes("jersey") && name.includes("number"))) {
          jerseyNumber = String(value ?? "").trim();
        }
      }
    }
  } else if (props && typeof props === "object") {
    for (const [k, v] of Object.entries(props)) {
      const name = normalizeKey(k);

      if (!reservationId) {
        if (name === "reservation id" || name.includes("reservation") || name.includes("pending allocation")) {
          reservationId = String(v ?? "").trim();
        }
      }

      if (!jerseyNumber) {
        if (name === "jersey number" || (name.includes("jersey") && name.includes("number"))) {
          jerseyNumber = String(v ?? "").trim();
        }
      }
    }
  }

  return { reservationId, jerseyNumber };
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // Only POST
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ ok: false, error: "Method Not Allowed" });
  }

  const SUPABASE_URL = process.env.SUPABASE_URL || "";
  const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
  const SHOPIFY_APP_SECRET = process.env.SHOPIFY_APP_SECRET || "";

  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY || !SHOPIFY_APP_SECRET) {
    return res.status(500).json({
      ok: false,
      error: "Missing required env vars (SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SHOPIFY_APP_SECRET).",
    });
  }

  // Read raw body (needed for Shopify HMAC verification)
  let rawBody = "";
  try {
    rawBody = await readRawBody(req);
  } catch (e: any) {
    return res.status(400).json({ ok: false, error: "Failed to read request body." });
  }

  const hmacHeader = (req.headers["x-shopify-hmac-sha256"] as string | undefined) ?? undefined;
  const okHmac = verifyShopifyHmac(rawBody, hmacHeader, SHOPIFY_APP_SECRET);

  if (!okHmac) {
    // Important: do NOT log secrets or raw payload
    return res.status(401).json({ ok: false, error: "Invalid webhook signature." });
  }

  let payload: ShopifyOrderPayload | null = null;
  try {
    payload = JSON.parse(rawBody) as ShopifyOrderPayload;
  } catch {
    return res.status(400).json({ ok: false, error: "Invalid JSON." });
  }

  const orderId = payload?.id != null ? String(payload.id) : "";
  const orderNumber =
    payload?.order_number != null ? String(payload.order_number) : payload?.name != null ? String(payload.name) : "";
  const lineItems = Array.isArray(payload?.line_items) ? payload!.line_items! : [];

  if (!orderId) {
    // Still return 200 so Shopify doesn't retry forever
    return res.status(200).json({ ok: true, processed: 0, note: "No order id in payload." });
  }

  // Server-side Supabase client (service role)
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  });

  const nowIso = new Date().toISOString();

  let processed = 0;
  const issues: any[] = [];

  for (const li of lineItems) {
    const { reservationId, jerseyNumber } = extractProperties(li.properties);

    if (!reservationId) continue; // Not one of our jersey items

    const lineItemId = li?.id != null ? String(li.id) : null;
    const qty = typeof li?.quantity === "number" ? li.quantity : Number(li?.quantity ?? 1);

    // We expect qty = 1 for jersey items (by design), but we won't hard-fail here.
    if (qty && qty > 1) {
      issues.push({
        reservationId,
        issue: "Line item quantity > 1. Processed reservation once.",
        quantity: qty,
      });
    }

    try {
      // Fetch pending allocation row
      const { data: pending, error: pendingErr } = await supabase
        .from("pending_allocations")
        .select("id, status, inventory_id, club_id, jersey_number, size, season_year, year_of_birth")
        .eq("id", reservationId)
        .limit(1)
        .maybeSingle();

      if (pendingErr || !pending) {
        issues.push({
          reservationId,
          issue: "Pending allocation not found (or query error).",
          detail: pendingErr?.message ?? "not found",
        });
        continue;
      }

      // Ensure the referenced inventory row is Allocated (handle the edge case where hold expired, but order still created)
      let reconciliationNeeded = false;

      const invId = String((pending as any).inventory_id ?? "");
      if (invId) {
        const { data: inv, error: invErr } = await supabase
          .from("inventory")
          .select("id, status")
          .eq("id", invId)
          .limit(1)
          .maybeSingle();

        if (invErr || !inv) {
          reconciliationNeeded = true;
          issues.push({ reservationId, issue: "Inventory row missing (or query error).", detail: invErr?.message ?? "" });
        } else {
          const status = String((inv as any).status ?? "");
          if (status === "Available") {
            const { error: invUpErr } = await supabase
              .from("inventory")
              .update({ status: "Allocated", allocation_date: nowIso })
              .eq("id", invId)
              .eq("status", "Available");

            if (invUpErr) {
              reconciliationNeeded = true;
              issues.push({
                reservationId,
                issue: "Failed to re-allocate inventory row (was Available).",
                detail: invUpErr.message,
              });
            }
          } else if (status !== "Allocated") {
            // Unexpected state
            reconciliationNeeded = true;
            issues.push({
              reservationId,
              issue: "Inventory row in unexpected status.",
              status,
            });
          }
        }
      } else {
        reconciliationNeeded = true;
        issues.push({ reservationId, issue: "Pending allocation missing inventory_id." });
      }

      const newStatus = reconciliationNeeded ? "reconciled" : "purchased";

      // Mark pending allocation as purchased (or reconciled) and attach order info
      const { error: upErr } = await supabase
        .from("pending_allocations")
        .update({
          status: newStatus,
          order_id: orderId,
          order_number: orderNumber || null,
          shopify_line_item_id: lineItemId,
          purchased_at: nowIso,
        })
        .eq("id", reservationId);

      if (upErr) {
        issues.push({ reservationId, issue: "Failed to update pending allocation.", detail: upErr.message });
        continue;
      }

      processed += 1;
    } catch (e: any) {
      issues.push({ reservationId, issue: "Unhandled exception processing reservation.", detail: e?.message ?? String(e) });
      continue;
    }
  }

  // Always return 200 for Shopify webhooks unless you specifically want retries.
  return res.status(200).json({
    ok: true,
    orderId,
    processed,
    jerseyNumberSeenExample: processed > 0 ? "yes" : "no",
    issues,
  });
}
