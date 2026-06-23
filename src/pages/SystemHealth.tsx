// FILE: src/pages/SystemHealth.tsx
import React, { useCallback, useEffect, useState } from "react";
import { supabase } from "../services/supabase";
import { Activity, AlertTriangle, CheckCircle2, RefreshCw, Mail } from "lucide-react";
import { SkeletonCards } from "../components/ui/Skeleton";

type Severity = "error" | "warning";

interface CheckResult {
  id: string;
  title: string;
  severity: Severity;
  explanation: string;
  howToFix: string;
  affected: string[]; // human-readable list of affected items, empty = healthy
}

const CARD_COPY: Record<
  string,
  { title: string; explanation: string; howToFix: string; severity: Severity }
> = {
  unmapped_live_clubs: {
    title: "Live clubs with no Shopify product mapped",
    severity: "error",
    explanation:
      "This club is marked as live (is_client = true) but has no row in shopify_product_club_map. The widget has nothing to attach to, so it cannot function on this club's product page at all — customers would see a broken or missing widget.",
    howToFix:
      "Go to Product Mapping, add a row linking this club's Shopify product ID(s) to the club, then re-check.",
  },
  clubs_without_sizes: {
    title: "Live clubs with no sizes configured",
    severity: "error",
    explanation:
      "This club is live but has zero rows in club_sizes. Bulk Stock Upload has nothing to attach numbers to, and the widget can't offer any size options.",
    howToFix:
      "Go to Bulk Stock Upload, select this club, and add at least one size before uploading stock.",
  },
  clubs_no_available_stock: {
    title: "Live clubs with zero available stock",
    severity: "warning",
    explanation:
      "This club is live and has sizes configured, but every inventory row is Allocated, Pending, or Written Off — there is nothing left for a new customer to buy right now.",
    howToFix:
      "Go to Bulk Stock Upload for this club and add more stock, or check Stock Planner for a reorder recommendation.",
  },
  stuck_pending_allocations: {
    title: "Stuck pending reservations (past their 30-minute hold)",
    severity: "error",
    explanation:
      "These reservations are still marked 'reserved' well past their expiry time. Normally a background job (pg_cron) automatically expires holds after 30 minutes and frees the number back to Available. If holds are piling up instead, that job may have stopped running — numbers will look unavailable to customers even though no one is actually buying them.",
    howToFix:
      "Check the pg_cron job 'expire_pending_allocations' is still scheduled in Supabase. As an immediate fix, these specific rows can be manually set to status='expired' so their jersey numbers free up again.",
  },
  recent_webhook_errors: {
    title: "Shopify webhook errors in the last 7 days",
    severity: "warning",
    explanation:
      "The orders/create or orders/paid webhook logged an error recently. This usually means an order came through that the system couldn't fully process — e.g. a reservation that couldn't be confirmed — and may need manual follow-up with the customer or their jersey number.",
    howToFix:
      "Open Allocation History and Sales History for the affected order number and confirm the player actually got their number. Check Vercel function logs for the full error if needed.",
  },
  player_number_drift: {
    title: "Numbers the system allocated, but inventory doesn't show as Allocated",
    severity: "warning",
    explanation:
      "The allocations log's most recent event for this club + number says it was allocated or swapped to someone, but there's no inventory row for that exact club + number currently marked Allocated. This means the system itself lost track of a real allocation — most likely the inventory row was changed (or never created) outside the normal allocate/return flow. This check intentionally ignores players whose number came from BC import history or a direct Players-page edit, since those were never expected to have a corresponding inventory row in the first place.",
    howToFix:
      "Go to Inventory for this club and check whether that number exists and is marked Allocated. If not, use the Allocation page to properly allocate it, or write off the discrepancy.",
  },
};

const SystemHealth: React.FC = () => {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [results, setResults] = useState<CheckResult[]>([]);
  const [lastChecked, setLastChecked] = useState<Date | null>(null);

  const [lowStockChecking, setLowStockChecking] = useState(false);
  const [lowStockResult, setLowStockResult] = useState<string | null>(null);

  const runLowStockCheckNow = async () => {
    setLowStockChecking(true);
    setLowStockResult(null);
    try {
      const res = await fetch("/api/low-stock-check");
      const data = await res.json();
      if (!res.ok) {
        setLowStockResult(`Failed: ${data.error ?? "unknown error"}`);
        return;
      }
      if (data.lowStockCount === 0) {
        setLowStockResult("Checked now — no low stock found, no email sent.");
      } else if (data.emailSent) {
        setLowStockResult(`Checked now — ${data.lowStockCount} low-stock item(s) found, alert email sent.`);
      } else {
        setLowStockResult(
          `Checked now — ${data.lowStockCount} low-stock item(s) found, but the email failed to send: ${data.emailError ?? "unknown error"}`
        );
      }
    } catch (err: any) {
      setLowStockResult(`Failed: ${err.message ?? "unexpected error"}`);
    } finally {
      setLowStockChecking(false);
    }
  };

  const runChecks = useCallback(async () => {
    setLoading(true);
    setError(null);

    try {
      const [
        clubsRes,
        mappingsRes,
        sizesRes,
        inventoryRes,
        pendingRes,
        webhookRes,
        allocationsLogRes,
      ] = await Promise.all([
        supabase.from("clubs").select("id, name, is_client").eq("is_client", true),
        supabase.from("shopify_product_club_map").select("club_id"),
        supabase.from("club_sizes").select("club_id"),
        supabase.from("inventory").select("club_id, jersey_number, status"),
        supabase
          .from("pending_allocations")
          .select("id, club_id, jersey_number, expires_at, status")
          .eq("status", "reserved")
          .lt("expires_at", new Date(Date.now() - 5 * 60 * 1000).toISOString()),
        supabase
          .from("webhook_events")
          .select("id, order_number, message, created_at")
          .eq("level", "error")
          .gte("created_at", new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString())
          .order("created_at", { ascending: false }),
        supabase
          .from("allocations")
          .select("club_id, jersey_number, allocation_type, player_first_name, player_last_name, created_at")
          .in("allocation_type", ["new", "swap", "end", "return"])
          .order("created_at", { ascending: true }),
      ]);

      const liveClubs = clubsRes.data ?? [];
      const clubNameById = new Map(liveClubs.map((c: any) => [c.id, c.name]));

      const mappedClubIds = new Set((mappingsRes.data ?? []).map((r: any) => r.club_id));
      const sizedClubIds = new Set((sizesRes.data ?? []).map((r: any) => r.club_id));

      const availableByClub = new Map<string, number>();
      const allocatedSet = new Set<string>(); // `${club_id}::${jersey_number}`
      for (const row of inventoryRes.data ?? []) {
        if (row.status === "Available") {
          availableByClub.set(row.club_id, (availableByClub.get(row.club_id) ?? 0) + 1);
        }
        if (row.status === "Allocated") {
          allocatedSet.add(`${row.club_id}::${row.jersey_number}`);
        }
      }

      const unmappedClubs = liveClubs.filter((c: any) => !mappedClubIds.has(c.id));
      const clubsWithoutSizes = liveClubs.filter((c: any) => !sizedClubIds.has(c.id));
      const clubsNoStock = liveClubs.filter(
        (c: any) => sizedClubIds.has(c.id) && (availableByClub.get(c.id) ?? 0) === 0
      );

      const stuckPending = (pendingRes.data ?? []).map(
        (r: any) =>
          `${clubNameById.get(r.club_id) ?? r.club_id} — #${r.jersey_number} (expired ${new Date(
            r.expires_at
          ).toLocaleString()})`
      );

      const webhookErrors = (webhookRes.data ?? []).map(
        (r: any) =>
          `Order ${r.order_number ?? "?"} — ${r.message ?? "no message"} (${new Date(
            r.created_at
          ).toLocaleString()})`
      );

      // Only flag a number when the allocations log's MOST RECENT event for that exact
      // club + number says it's currently held ("new"/"swap") -- if the latest event is
      // "end"/"return", the number is expected to be released and absence of an
      // Allocated row is correct, not drift. Rows are fetched oldest-first, so the last
      // write per key naturally ends up as the latest.
      const latestAllocationByKey = new Map<
        string,
        { allocation_type: string; player_first_name: string | null; player_last_name: string | null; club_id: string }
      >();
      for (const r of allocationsLogRes.data ?? []) {
        const key = `${r.club_id}::${r.jersey_number}`;
        latestAllocationByKey.set(key, r as any);
      }

      const driftEntries = Array.from(latestAllocationByKey.entries()).filter(
        ([key, r]) => (r.allocation_type === "new" || r.allocation_type === "swap") && !allocatedSet.has(key)
      );
      // Group drift count per club for a readable summary instead of one line per number
      const driftByClub = new Map<string, number>();
      for (const [, r] of driftEntries) {
        driftByClub.set(r.club_id, (driftByClub.get(r.club_id) ?? 0) + 1);
      }

      const newResults: CheckResult[] = [
        {
          id: "unmapped_live_clubs",
          ...CARD_COPY.unmapped_live_clubs,
          affected: unmappedClubs.map((c: any) => c.name),
        },
        {
          id: "clubs_without_sizes",
          ...CARD_COPY.clubs_without_sizes,
          affected: clubsWithoutSizes.map((c: any) => c.name),
        },
        {
          id: "clubs_no_available_stock",
          ...CARD_COPY.clubs_no_available_stock,
          affected: clubsNoStock.map((c: any) => c.name),
        },
        {
          id: "stuck_pending_allocations",
          ...CARD_COPY.stuck_pending_allocations,
          affected: stuckPending,
        },
        {
          id: "recent_webhook_errors",
          ...CARD_COPY.recent_webhook_errors,
          affected: webhookErrors,
        },
        {
          id: "player_number_drift",
          ...CARD_COPY.player_number_drift,
          affected: Array.from(driftByClub.entries()).map(
            ([clubId, count]) => `${clubNameById.get(clubId) ?? clubId} — ${count} player(s)`
          ),
        },
      ];

      setResults(newResults);
      setLastChecked(new Date());
    } catch (err: any) {
      console.error("SystemHealth runChecks error", err);
      setError(err.message ?? "Failed to run health checks.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void runChecks();
  }, [runChecks]);

  const problemCount = results.filter((r) => r.affected.length > 0).length;

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <h1 className="text-2xl font-bold flex items-center gap-2">
          <Activity size={22} className="text-brand-600" />
          System Health
        </h1>
        <button
          type="button"
          onClick={() => void runChecks()}
          disabled={loading}
          className="flex items-center gap-2 text-sm px-3 py-2 border rounded hover:bg-gray-50 disabled:opacity-50"
        >
          <RefreshCw size={14} className={loading ? "animate-spin" : ""} />
          Re-check now
        </button>
      </div>

      <p className="text-sm text-gray-600 mb-2">
        Automated checks for the most common ways this system can silently break — a club
        going live without being wired up, stock running out, or background jobs not
        running. Each card below explains in plain English what the flag means and exactly
        what to do about it.
      </p>
      {lastChecked && (
        <p className="text-xs text-gray-400 mb-6">
          Last checked: {lastChecked.toLocaleString()}
        </p>
      )}

      <div className="mb-6 border border-gray-200 rounded-lg bg-white p-4">
        <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-3">
          <div>
            <h2 className="text-sm font-semibold text-gray-800 flex items-center gap-2">
              <Mail size={16} className="text-brand-600" />
              Low stock email alerts
            </h2>
            <p className="text-xs text-gray-500 max-w-xl">
              Runs automatically every morning (8am AEST) and emails {" "}
              <span className="font-medium">jarrad@cimcgroup.com.au</span> if any live
              club's available stock for a size drops to or below its reorder buffer
              (the same buffer used on Stock Planner).
            </p>
          </div>
          <button
            type="button"
            onClick={() => void runLowStockCheckNow()}
            disabled={lowStockChecking}
            className="flex items-center gap-2 text-sm px-3 py-2 border rounded hover:bg-gray-50 disabled:opacity-50 flex-shrink-0"
          >
            <RefreshCw size={14} className={lowStockChecking ? "animate-spin" : ""} />
            Check now
          </button>
        </div>
        {lowStockResult && (
          <p className="text-xs text-gray-700 mt-3 bg-gray-50 border border-gray-200 rounded p-2">
            {lowStockResult}
          </p>
        )}
      </div>

      {error && (
        <div className="mb-4 text-sm text-red-700 bg-red-50 border border-red-200 rounded p-3">
          {error}
        </div>
      )}

      {loading && results.length === 0 && <SkeletonCards count={4} />}

      {!loading && results.length > 0 && (
        <>
          {problemCount === 0 ? (
            <div className="flex items-center gap-2 text-sm text-emerald-700 bg-emerald-50 border border-emerald-200 rounded p-4 mb-6">
              <CheckCircle2 size={18} />
              All checks passed — no issues found.
            </div>
          ) : (
            <div className="flex items-center gap-2 text-sm text-amber-700 bg-amber-50 border border-amber-200 rounded p-4 mb-6">
              <AlertTriangle size={18} />
              {problemCount} check{problemCount === 1 ? "" : "s"} flagged below need attention.
            </div>
          )}

          <div className="space-y-4">
            {results.map((r) => {
              const healthy = r.affected.length === 0;
              return (
                <div
                  key={r.id}
                  className={`border rounded-lg p-4 ${
                    healthy
                      ? "border-gray-200 bg-white"
                      : r.severity === "error"
                      ? "border-red-200 bg-red-50"
                      : "border-amber-200 bg-amber-50"
                  }`}
                >
                  <div className="flex items-start justify-between gap-3">
                    <h3 className="text-sm font-semibold text-gray-800 flex items-center gap-2">
                      {healthy ? (
                        <CheckCircle2 size={16} className="text-emerald-600 flex-shrink-0" />
                      ) : (
                        <AlertTriangle
                          size={16}
                          className={`flex-shrink-0 ${
                            r.severity === "error" ? "text-red-600" : "text-amber-600"
                          }`}
                        />
                      )}
                      {r.title}
                    </h3>
                    {!healthy && (
                      <span
                        className={`text-[10px] uppercase font-bold tracking-wide px-2 py-0.5 rounded-full flex-shrink-0 ${
                          r.severity === "error"
                            ? "bg-red-600 text-white"
                            : "bg-amber-500 text-white"
                        }`}
                      >
                        {r.severity}
                      </span>
                    )}
                  </div>

                  <p className="text-xs text-gray-600 mt-2">{r.explanation}</p>

                  {healthy ? (
                    <p className="text-xs text-emerald-700 mt-2 font-medium">
                      No issues found.
                    </p>
                  ) : (
                    <>
                      <div className="mt-3 text-xs">
                        <span className="font-semibold text-gray-700">Affected:</span>
                        <ul className="list-disc list-inside mt-1 space-y-0.5 text-gray-700">
                          {r.affected.slice(0, 15).map((a, i) => (
                            <li key={i}>{a}</li>
                          ))}
                        </ul>
                        {r.affected.length > 15 && (
                          <p className="text-gray-500 mt-1">
                            …and {r.affected.length - 15} more.
                          </p>
                        )}
                      </div>
                      <div className="mt-3 text-xs bg-white/60 border border-gray-200 rounded p-2">
                        <span className="font-semibold text-gray-700">How to fix:</span>{" "}
                        {r.howToFix}
                      </div>
                    </>
                  )}
                </div>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
};

export default SystemHealth;
