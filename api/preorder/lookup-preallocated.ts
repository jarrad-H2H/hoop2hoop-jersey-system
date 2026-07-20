// FILE: api/preorder/lookup-preallocated.ts
// Fuzzy-searches pre-allocated preorder_requests for a given club+season by player name+YOB.
// Called by the widget's pre-allocated form to find the player's record before they confirm size.
// POST { clubId, season, firstName, lastName, yearOfBirth }
// Returns { candidates: [{ id, firstName, lastName, assignedNumber, defaultJerseyName }] }
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { createClient } from "@supabase/supabase-js";

export const maxDuration = 15;

interface Row {
  id: string;
  first_name: string;
  last_name: string;
  assigned_number: number;
  jersey_name: string | null;
  status: string;
}

function normalize(s: string): string {
  return (s ?? "").toLowerCase().trim().replace(/[^a-z]/g, "");
}

function levenshtein(a: string, b: string): number {
  const m = a.length, n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, (_, i) =>
    Array.from({ length: n + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0))
  );
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  return dp[m][n];
}

function nameSimilarity(query: string, target: string): number {
  const q = normalize(query);
  const t = normalize(target);
  if (!q || !t) return 0;
  if (q === t) return 100;
  if (t.startsWith(q) || q.startsWith(t)) return 80;
  if (t.includes(q) || q.includes(t)) return 60;
  const maxLen = Math.max(q.length, t.length);
  const dist = levenshtein(q, t);
  const score = Math.max(0, Math.round((1 - dist / maxLen) * 50));
  return score;
}

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
  const season = String(body.season ?? "").trim();
  const productType = String(body.productType ?? "").trim();
  const firstName = String(body.firstName ?? "").trim();
  const lastName = String(body.lastName ?? "").trim();
  const yearOfBirth = Number(body.yearOfBirth);

  if (!clubId || !firstName || !lastName) {
    return res.status(400).json({ ok: false, error: "clubId, firstName, lastName are required" });
  }

  const supabase = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

  let query = supabase
    .from("preorder_requests")
    .select("id, first_name, last_name, assigned_number, jersey_name, status, year_of_birth")
    .eq("club_id", clubId)
    .in("status", ["needs_size", "allocated"])
    .not("assigned_number", "is", null);

  if (season) query = query.eq("season", season);
  if (productType === "mens" || productType === "womens") query = query.eq("product_type", productType);

  const { data, error } = await query;

  if (error) {
    return res.status(500).json({ ok: false, error: error.message });
  }

  const rowsWithYob = (data ?? []) as (Row & { year_of_birth: number | null })[];

  const scoredWithYob = rowsWithYob.map(row => {
    const lastScore = nameSimilarity(lastName, row.last_name);
    const firstScore = nameSimilarity(firstName, row.first_name);
    const yobBonus = Number.isFinite(yearOfBirth) && yearOfBirth > 0
      ? (row.year_of_birth === yearOfBirth ? 30 : Math.abs((row.year_of_birth ?? 0) - yearOfBirth) <= 1 ? 10 : 0)
      : 0;
    const total = lastScore * 1.5 + firstScore + yobBonus;
    return { row, total };
  });

  const THRESHOLD = 40;
  const candidates = scoredWithYob
    .filter(s => s.total >= THRESHOLD)
    .sort((a, b) => b.total - a.total)
    .slice(0, 3)
    .map(s => ({
      id: s.row.id,
      firstName: s.row.first_name,
      lastName: s.row.last_name,
      assignedNumber: s.row.assigned_number,
      defaultJerseyName: s.row.jersey_name ?? s.row.last_name,
      alreadyConfirmed: s.row.status === "allocated" && Boolean(s.row.jersey_name),
    }));

  return res.status(200).json({ ok: true, candidates });
}
