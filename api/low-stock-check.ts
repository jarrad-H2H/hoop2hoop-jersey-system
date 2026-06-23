// FILE: api/low-stock-check.ts
// Runs daily (see vercel.json cron) and emails an alert via Resend when any
// live club's available stock for a size/product_type drops at or below that
// club's min_buffer_units threshold (same threshold Stock Planner uses for
// its WATCH/REORDER NOW flags, so this is just an early warning of the same
// thing landing in your inbox instead of needing to check the page).

import type { VercelRequest, VercelResponse } from "@vercel/node";
import { createClient } from "@supabase/supabase-js";

const ALERT_TO_EMAIL = "jarrad@cimcgroup.com.au";
const DEFAULT_MIN_BUFFER_UNITS = 5;

interface LowStockRow {
  clubName: string;
  size: string;
  productType: string;
  available: number;
  threshold: number;
}

async function sendAlertEmail(rows: LowStockRow[]): Promise<{ ok: boolean; error?: string }> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    return { ok: false, error: "RESEND_API_KEY is not set" };
  }

  const tableRows = rows
    .map(
      (r) =>
        `<tr><td style="padding:4px 12px;border-bottom:1px solid #eee;">${r.clubName}</td><td style="padding:4px 12px;border-bottom:1px solid #eee;">${r.size}</td><td style="padding:4px 12px;border-bottom:1px solid #eee;">${r.productType}</td><td style="padding:4px 12px;border-bottom:1px solid #eee;text-align:right;color:${r.available === 0 ? "#dc2626" : "#d97706"};font-weight:600;">${r.available}</td><td style="padding:4px 12px;border-bottom:1px solid #eee;text-align:right;">${r.threshold}</td></tr>`
    )
    .join("");

  const html = `
    <div style="font-family:Arial,sans-serif;color:#1f2937;">
      <h2 style="color:#1d4fa8;">H2H Jersey Allocator — Low Stock Alert</h2>
      <p>${rows.length} size/product combination(s) across your live clubs are at or below their reorder buffer:</p>
      <table style="border-collapse:collapse;width:100%;max-width:600px;">
        <thead>
          <tr style="background:#eef3fb;text-align:left;">
            <th style="padding:6px 12px;">Club</th>
            <th style="padding:6px 12px;">Size</th>
            <th style="padding:6px 12px;">Product</th>
            <th style="padding:6px 12px;text-align:right;">Available</th>
            <th style="padding:6px 12px;text-align:right;">Buffer</th>
          </tr>
        </thead>
        <tbody>${tableRows}</tbody>
      </table>
      <p style="margin-top:16px;font-size:13px;color:#6b7280;">
        Check the Stock Planner page in the admin panel for reorder quantity recommendations.
      </p>
    </div>
  `;

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: "H2H Jersey Allocator <onboarding@resend.dev>",
      to: ALERT_TO_EMAIL,
      subject: `Low stock alert — ${rows.length} size(s) need attention`,
      html,
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    return { ok: false, error: `Resend API error ${res.status}: ${text}` };
  }

  return { ok: true };
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // If CRON_SECRET is set, only accept requests carrying it -- Vercel automatically
  // attaches "Authorization: Bearer <CRON_SECRET>" to its own scheduled invocations
  // of this route, so this blocks anyone else from hitting it and spamming emails.
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret && req.headers.authorization !== `Bearer ${cronSecret}`) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  const SUPABASE_URL = process.env.SUPABASE_URL || "";
  const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";

  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    res.status(500).json({ error: "Missing Supabase service credentials." });
    return;
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  try {
    const [clubsRes, sizesRes, inventoryRes, settingsRes] = await Promise.all([
      supabase.from("clubs").select("id, name").eq("is_client", true),
      supabase.from("club_sizes").select("club_id, size_label, product_type"),
      supabase.from("inventory").select("club_id, size, product_type, status"),
      supabase.from("club_settings").select("club_id, min_buffer_units"),
    ]);

    if (clubsRes.error || sizesRes.error || inventoryRes.error || settingsRes.error) {
      res.status(500).json({
        error: "Failed to load data from Supabase.",
        details: [clubsRes.error, sizesRes.error, inventoryRes.error, settingsRes.error]
          .filter(Boolean)
          .map((e: any) => e.message),
      });
      return;
    }

    const clubs = clubsRes.data ?? [];
    const clubNameById = new Map(clubs.map((c: any) => [c.id, c.name]));
    const liveClubIds = new Set(clubs.map((c: any) => c.id));

    const bufferByClub = new Map<string, number>();
    for (const row of settingsRes.data ?? []) {
      bufferByClub.set(row.club_id, row.min_buffer_units ?? DEFAULT_MIN_BUFFER_UNITS);
    }

    const availableByKey = new Map<string, number>(); // `${club_id}::${size}::${product_type}`
    for (const row of inventoryRes.data ?? []) {
      if (row.status !== "Available") continue;
      if (!liveClubIds.has(row.club_id)) continue;
      const key = `${row.club_id}::${row.size}::${row.product_type ?? "default"}`;
      availableByKey.set(key, (availableByKey.get(key) ?? 0) + 1);
    }

    const lowStock: LowStockRow[] = [];

    for (const sizeRow of sizesRes.data ?? []) {
      if (!liveClubIds.has(sizeRow.club_id)) continue;

      const key = `${sizeRow.club_id}::${sizeRow.size_label}::${sizeRow.product_type ?? "default"}`;
      const available = availableByKey.get(key) ?? 0;
      const threshold = bufferByClub.get(sizeRow.club_id) ?? DEFAULT_MIN_BUFFER_UNITS;

      if (available <= threshold) {
        lowStock.push({
          clubName: clubNameById.get(sizeRow.club_id) ?? sizeRow.club_id,
          size: sizeRow.size_label,
          productType: sizeRow.product_type ?? "default",
          available,
          threshold,
        });
      }
    }

    if (lowStock.length === 0) {
      res.status(200).json({ success: true, lowStockCount: 0, message: "No low stock found." });
      return;
    }

    const emailResult = await sendAlertEmail(lowStock);

    res.status(200).json({
      success: true,
      lowStockCount: lowStock.length,
      lowStock,
      emailSent: emailResult.ok,
      emailError: emailResult.error,
    });
  } catch (err: any) {
    console.error("low-stock-check error", err);
    res.status(500).json({ error: err.message ?? "Unexpected error." });
  }
}
