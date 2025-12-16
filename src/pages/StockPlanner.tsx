// FILE: src/pages/StockPlanner.tsx
import React, { useEffect, useMemo, useState } from "react";
import { supabase } from "../services/supabase";

type AllocationType = "new" | "swap" | "end" | "return";

interface Club {
  id: string;
  name: string;
  is_client: boolean;
}

interface InventoryRow {
  size: string | null;
  status: "Available" | "Allocated" | string;
  jersey_number: number | null;
}

interface AllocationRow {
  id: string;
  allocation_type: AllocationType;
  size: string | null;
  created_at: string;
}

interface PendingAllocationRow {
  id: string;
  size: string | null;
  jersey_number: number | null;
  status: "reserved" | "purchased" | "expired" | "cancelled" | "reconciled" | string;
  expires_at: string | null;
}

interface ClubSettings {
  club_id: string;
  lead_time_weeks: number;
  target_weeks_cover: number;
  min_buffer_units: number;
}

interface SizePlanRow {
  size: string;

  // Raw inventory + reservation picture
  availableStock: number;
  reservedStock: number;
  effectiveStock: number;

  // Number flexibility signals (club-wide)
  distinctNumbersAvailable: number;
  numberEntropy: number | null; // normalized 0..1 (higher = healthier)
  constrainedNumbers: string; // "5(1), 9(1), 0(2)" format

  // Usage-based planning
  weeklyUsage: number;
  weeksOfCover: number | null;
  recommendedOrder: number;
  status: "OK" | "WATCH" | "ORDER_NOW";
  notes: string;
}

const USAGE_WINDOW_WEEKS = 12;

// Simple safe entropy calculation
// - Uses available jersey_number depths in that size (after subtracting reservations)
// - Returns normalized 0..1 (1 = very even, 0 = very uneven)
function computeNormalizedEntropy(depths: number[]): number | null {
  const total = depths.reduce((a, b) => a + b, 0);
  if (!Number.isFinite(total) || total <= 0) return null;

  const probs = depths.map((d) => d / total).filter((p) => p > 0);
  if (probs.length <= 1) return 0;

  // Shannon entropy
  let h = 0;
  for (const p of probs) {
    h += -p * Math.log(p);
  }

  // Normalize by max entropy for N outcomes
  const hMax = Math.log(probs.length);
  if (hMax <= 0) return 0;

  const norm = h / hMax;
  // Clamp 0..1
  return Math.max(0, Math.min(1, Number(norm.toFixed(3))));
}

const StockPlanner: React.FC = () => {
  const [clubs, setClubs] = useState<Club[]>([]);
  const [selectedClubId, setSelectedClubId] = useState<string>("");

  const [inventoryRows, setInventoryRows] = useState<InventoryRow[]>([]);
  const [allocationRows, setAllocationRows] = useState<AllocationRow[]>([]);
  const [pendingRows, setPendingRows] = useState<PendingAllocationRow[]>([]);

  const [settings, setSettings] = useState<ClubSettings | null>(null);
  const [settingsSaving, setSettingsSaving] = useState(false);

  const [loading, setLoading] = useState(false);
  const [loadingSettings, setLoadingSettings] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [infoMessage, setInfoMessage] = useState<string | null>(null);

  // Load client clubs for dropdown
  useEffect(() => {
    const loadClubs = async () => {
      setError(null);
      const { data, error } = await supabase
        .from("clubs")
        .select("id, name, is_client")
        .eq("is_client", true)
        .order("name", { ascending: true });

      if (error) {
        console.error("StockPlanner loadClubs error", error);
        setError("Failed to load clubs.");
        return;
      }

      const list = (data ?? []) as Club[];
      setClubs(list);
      if (list.length > 0) {
        setSelectedClubId(list[0].id);
      }
    };

    void loadClubs();
  }, []);

  // Load club-specific settings
  useEffect(() => {
    const loadSettings = async () => {
      if (!selectedClubId) {
        setSettings(null);
        return;
      }

      setLoadingSettings(true);
      setError(null);

      try {
        const { data, error } = await supabase
          .from("club_settings")
          .select("club_id, lead_time_weeks, target_weeks_cover, min_buffer_units")
          .eq("club_id", selectedClubId)
          .maybeSingle();

        if (error && error.code !== "PGRST116") {
          console.error("StockPlanner loadSettings error", error);
          setError("Failed to load stock settings for this club.");
          return;
        }

        if (data) {
          setSettings(data as ClubSettings);
        } else {
          setSettings({
            club_id: selectedClubId,
            lead_time_weeks: 4,
            target_weeks_cover: 8,
            min_buffer_units: 5,
          });
        }
      } finally {
        setLoadingSettings(false);
      }
    };

    void loadSettings();
  }, [selectedClubId]);

  // Save / upsert settings
  const handleSaveSettings = async () => {
    if (!selectedClubId || !settings) return;

    setSettingsSaving(true);
    setError(null);
    setInfoMessage(null);

    try {
      const payload = {
        club_id: selectedClubId,
        lead_time_weeks: settings.lead_time_weeks,
        target_weeks_cover: settings.target_weeks_cover,
        min_buffer_units: settings.min_buffer_units,
      };

      const { error } = await supabase.from("club_settings").upsert(payload, {
        onConflict: "club_id",
      });

      if (error) {
        console.error("StockPlanner saveSettings error", error);
        setError("Failed to save settings for this club.");
        return;
      }

      setInfoMessage("Planning settings saved for this club.");
    } finally {
      setSettingsSaving(false);
    }
  };

  // Load inventory + usage + pending reservations for selected club
  useEffect(() => {
    const loadData = async () => {
      if (!selectedClubId) {
        setInventoryRows([]);
        setAllocationRows([]);
        setPendingRows([]);
        return;
      }

      setLoading(true);
      setError(null);
      setInfoMessage(null);

      try {
        // 1) Inventory (jerseys only)
        const { data: invData, error: invError } = await supabase
          .from("inventory")
          .select("size, status, jersey_number")
          .eq("club_id", selectedClubId);

        if (invError) {
          console.error("StockPlanner load inventory error", invError);
          setError("Failed to load inventory for this club.");
          return;
        }

        setInventoryRows((invData ?? []) as InventoryRow[]);

        // 2) Allocation usage for last N weeks (new + swap)
        const windowStart = new Date();
        windowStart.setDate(windowStart.getDate() - USAGE_WINDOW_WEEKS * 7);

        const { data: allocData, error: allocError } = await supabase
          .from("allocations")
          .select("id, allocation_type, size, created_at")
          .eq("club_id", selectedClubId)
          .in("allocation_type", ["new", "swap"])
          .gte("created_at", windowStart.toISOString());

        if (allocError) {
          console.error("StockPlanner load allocations error", allocError);
          setError("Failed to load allocation history for this club.");
          return;
        }

        setAllocationRows((allocData ?? []) as AllocationRow[]);

        // 3) Pending allocations (reservations)
        // Only active reservations matter for planning.
        // We filter client-side to avoid timezone/operator inconsistencies.
        const { data: pendingData, error: pendingError } = await supabase
          .from("pending_allocations")
          .select("id, size, jersey_number, status, expires_at")
          .eq("club_id", selectedClubId);

        if (pendingError) {
          console.error("StockPlanner load pending_allocations error", pendingError);
          setError("Failed to load pending allocations for this club.");
          return;
        }

        setPendingRows((pendingData ?? []) as PendingAllocationRow[]);
      } finally {
        setLoading(false);
      }
    };

    void loadData();
  }, [selectedClubId]);

  const planRows: SizePlanRow[] = useMemo(() => {
    if (!settings) return [];

    const { lead_time_weeks, target_weeks_cover, min_buffer_units } = settings;

    // ---- 1) Available stock counts by size (Available only)
    const availableBySize = new Map<string, number>();

    // Also build depth map: size -> jersey_number -> availableCount
    const availableDepthBySize = new Map<string, Map<number, number>>();

    for (const row of inventoryRows) {
      const size = (row.size ?? "").trim();
      if (!size) continue;
      if (row.status !== "Available") continue;

      availableBySize.set(size, (availableBySize.get(size) ?? 0) + 1);

      const n = typeof row.jersey_number === "number" ? row.jersey_number : null;
      if (n === null || !Number.isFinite(n)) continue;

      const depthMap = availableDepthBySize.get(size) ?? new Map<number, number>();
      depthMap.set(n, (depthMap.get(n) ?? 0) + 1);
      availableDepthBySize.set(size, depthMap);
    }

    // ---- 2) Active reservations by size (reserved AND not expired)
    const reservedBySize = new Map<string, number>();
    const reservedDepthBySize = new Map<string, Map<number, number>>();

    const nowMs = Date.now();

    for (const r of pendingRows) {
      if (r.status !== "reserved") continue;

      const size = (r.size ?? "").trim();
      if (!size) continue;

      const expMs = r.expires_at ? Date.parse(r.expires_at) : NaN;
      if (!Number.isFinite(expMs) || expMs <= nowMs) continue;

      reservedBySize.set(size, (reservedBySize.get(size) ?? 0) + 1);

      const n = typeof r.jersey_number === "number" ? r.jersey_number : null;
      if (n === null || !Number.isFinite(n)) continue;

      const depthMap = reservedDepthBySize.get(size) ?? new Map<number, number>();
      depthMap.set(n, (depthMap.get(n) ?? 0) + 1);
      reservedDepthBySize.set(size, depthMap);
    }

    // ---- 3) Usage events per size over window
    const usageCountBySize = new Map<string, number>();
    for (const row of allocationRows) {
      const size = (row.size ?? "").trim();
      if (!size) continue;
      usageCountBySize.set(size, (usageCountBySize.get(size) ?? 0) + 1);
    }

    // ---- 4) Union of all sizes
    const allSizes = new Set<string>([
      ...Array.from(availableBySize.keys()),
      ...Array.from(reservedBySize.keys()),
      ...Array.from(usageCountBySize.keys()),
    ]);

    const rows: SizePlanRow[] = [];

    for (const size of allSizes) {
      const availableStock = availableBySize.get(size) ?? 0;
      const reservedStock = reservedBySize.get(size) ?? 0;
      const effectiveStock = Math.max(0, availableStock - reservedStock);

      const totalUsageEvents = usageCountBySize.get(size) ?? 0;
      const weeklyUsage = totalUsageEvents > 0 ? totalUsageEvents / USAGE_WINDOW_WEEKS : 0;

      const weeksOfCover = weeklyUsage > 0 ? effectiveStock / weeklyUsage : null;

      const consumptionDuringLead = weeklyUsage * lead_time_weeks;
      const targetStock =
        weeklyUsage * (lead_time_weeks + target_weeks_cover) + min_buffer_units;

      const recommendedOrderRaw = targetStock - effectiveStock;
      const recommendedOrder = recommendedOrderRaw > 0 ? Math.ceil(recommendedOrderRaw) : 0;

      // ---- Number flexibility: availableDepth minus reservedDepth
      const availDepth = availableDepthBySize.get(size) ?? new Map<number, number>();
      const resDepth = reservedDepthBySize.get(size) ?? new Map<number, number>();

      const effectiveDepths: number[] = [];
      const constrained: Array<{ n: number; d: number }> = [];

      for (const [n, dAvail] of availDepth.entries()) {
        const dRes = resDepth.get(n) ?? 0;
        const dEff = dAvail - dRes;
        if (dEff <= 0) continue;
        effectiveDepths.push(dEff);
        constrained.push({ n, d: dEff });
      }

      const distinctNumbersAvailable = constrained.length;

      // Most constrained numbers = lowest depth first (top 3)
      constrained.sort((a, b) => {
        if (a.d !== b.d) return a.d - b.d;
        return a.n - b.n;
      });

      const constrainedNumbers = constrained
        .slice(0, 3)
        .map((x) => `${x.n}(${x.d})`)
        .join(", ");

      const numberEntropy = computeNormalizedEntropy(effectiveDepths);

      // ---- Status logic (now based on effectiveStock)
      let status: SizePlanRow["status"] = "OK";
      let notes = "";

      const lowEntropy = typeof numberEntropy === "number" && numberEntropy < 0.35;
      const lowNumberFlex = distinctNumbersAvailable > 0 && distinctNumbersAvailable <= 5;

      if (weeklyUsage === 0) {
        if (effectiveStock <= min_buffer_units) {
          status = "WATCH";
          notes = "No recent usage, but buffer is thin.";
        } else {
          status = "OK";
          notes = "No recent usage detected.";
        }
      } else {
        if (effectiveStock <= consumptionDuringLead) {
          status = "ORDER_NOW";
          notes = "Risk of stockout before replenishment arrives.";
        } else if (effectiveStock <= consumptionDuringLead + min_buffer_units) {
          status = "WATCH";
          notes = "Stock is within buffer range.";
        } else {
          status = "OK";
          notes = "Stock is above buffer range.";
        }
      }

      // Escalate WATCH if number pool is fragile (even if unit stock is ok)
      // This is the “collision risk” proxy at club-wide level.
      if (status === "OK" && (lowEntropy || lowNumberFlex)) {
        status = "WATCH";
        notes = lowNumberFlex
          ? "Units OK, but very few distinct numbers available (future clash risk)."
          : "Units OK, but number pool is unevenly distributed (future clash risk).";
      }

      rows.push({
        size,
        availableStock,
        reservedStock,
        effectiveStock,
        distinctNumbersAvailable,
        numberEntropy,
        constrainedNumbers: constrainedNumbers || "—",
        weeklyUsage: Number(weeklyUsage.toFixed(2)),
        weeksOfCover: weeksOfCover !== null ? Number(weeksOfCover.toFixed(1)) : null,
        recommendedOrder,
        status,
        notes,
      });
    }

    // Sort: ORDER_NOW first, then WATCH, then OK; within each, by size
    const statusRank: Record<SizePlanRow["status"], number> = {
      ORDER_NOW: 0,
      WATCH: 1,
      OK: 2,
    };

    rows.sort((a, b) => {
      const rankDiff = statusRank[a.status] - statusRank[b.status];
      if (rankDiff !== 0) return rankDiff;
      return a.size.localeCompare(b.size, undefined, { numeric: true });
    });

    return rows;
  }, [inventoryRows, allocationRows, pendingRows, settings]);

  const clubName = clubs.find((c) => c.id === selectedClubId)?.name ?? "—";

  const totalRecommendedOrder = planRows.reduce((sum, row) => sum + row.recommendedOrder, 0);

  const handleExportCsv = () => {
    if (!planRows.length) return;

    const header = [
      "Club",
      "Size",
      "AvailableStock",
      "ReservedStock",
      "EffectiveStock",
      "DistinctNumbersAvailable",
      "NumberEntropy",
      "ConstrainedNumbers",
      "WeeklyUsage",
      "WeeksOfCover",
      "Status",
      "RecommendedOrder",
      "Notes",
    ];

    const lines = [
      header.join(","),
      ...planRows.map((row) =>
        [
          `"${clubName.replace(/"/g, '""')}"`,
          `"${row.size.replace(/"/g, '""')}"`,
          row.availableStock,
          row.reservedStock,
          row.effectiveStock,
          row.distinctNumbersAvailable,
          row.numberEntropy ?? "",
          `"${row.constrainedNumbers.replace(/"/g, '""')}"`,
          row.weeklyUsage,
          row.weeksOfCover ?? "",
          row.status,
          row.recommendedOrder,
          `"${row.notes.replace(/"/g, '""')}"`,
        ].join(",")
      ),
    ];

    const blob = new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);

    const a = document.createElement("a");
    a.href = url;
    a.download = `stock_planner_${clubName.replace(/\s+/g, "_")}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleSettingsChange = (field: keyof ClubSettings, value: number) => {
    if (!settings) return;
    setSettings({ ...settings, [field]: value });
  };

  return (
    <div>
      <h1 className="text-2xl font-bold mb-4">Stock Planner</h1>
      <p className="text-sm text-gray-600 mb-6">
        Club-wide stock planning by size. Uses allocation history to estimate usage and includes
        active reservations (pending allocations) so stock planning reflects reality.
      </p>

      {/* Top controls */}
      <div className="grid grid-cols-1 md:grid-cols-[minmax(0,1fr)_minmax(0,1.5fr)] gap-4 mb-6">
        {/* Club selector */}
        <div>
          <label className="block text-xs font-semibold text-gray-700 mb-1 uppercase tracking-wide">
            Club
          </label>
          <select
            value={selectedClubId}
            onChange={(e) => setSelectedClubId(e.target.value)}
            className="border rounded px-3 py-2 min-w-[220px] text-sm"
          >
            {clubs.length === 0 && <option value="">No client clubs found</option>}
            {clubs.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </div>

        {/* Settings panel */}
        <div className="border border-gray-200 rounded-lg bg-gray-50 p-3">
          <div className="flex items-center justify-between mb-2">
            <div>
              <div className="text-xs font-semibold text-gray-700 uppercase tracking-wide">
                Planning Settings for {clubName}
              </div>
              <div className="text-[11px] text-gray-500">
                Per-club tuning for lead time, cover and buffer.
              </div>
            </div>
            <button
              type="button"
              onClick={handleSaveSettings}
              disabled={settingsSaving || !settings}
              className="px-3 py-1.5 rounded bg-indigo-600 text-white text-xs font-semibold disabled:bg-gray-400"
            >
              {settingsSaving ? "Saving…" : "Save Settings"}
            </button>
          </div>

          {settings && (
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mt-2">
              <div>
                <label className="block text-[11px] font-semibold text-gray-700 mb-1">
                  Lead time (weeks)
                </label>
                <input
                  type="number"
                  min={1}
                  value={settings.lead_time_weeks}
                  onChange={(e) =>
                    handleSettingsChange("lead_time_weeks", Number(e.target.value) || 0)
                  }
                  className="w-full border rounded px-2 py-1.5 text-xs"
                />
              </div>

              <div>
                <label className="block text-[11px] font-semibold text-gray-700 mb-1">
                  Target cover (weeks)
                </label>
                <input
                  type="number"
                  min={0}
                  value={settings.target_weeks_cover}
                  onChange={(e) =>
                    handleSettingsChange("target_weeks_cover", Number(e.target.value) || 0)
                  }
                  className="w-full border rounded px-2 py-1.5 text-xs"
                />
              </div>

              <div>
                <label className="block text-[11px] font-semibold text-gray-700 mb-1">
                  Min buffer units
                </label>
                <input
                  type="number"
                  min={0}
                  value={settings.min_buffer_units}
                  onChange={(e) =>
                    handleSettingsChange("min_buffer_units", Number(e.target.value) || 0)
                  }
                  className="w-full border rounded px-2 py-1.5 text-xs"
                />
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Messages */}
      {error && (
        <div className="mb-4 text-sm text-red-700 bg-red-50 border border-red-200 rounded p-3">
          {error}
        </div>
      )}
      {infoMessage && (
        <div className="mb-4 text-sm text-emerald-700 bg-emerald-50 border border-emerald-200 rounded p-3">
          {infoMessage}
        </div>
      )}

      {/* Summary / export */}
      <div className="flex flex-col md:flex-row md:items-center md:justify-between mb-4 gap-2">
        <div className="text-sm text-gray-700">
          <span className="font-semibold">{planRows.length}</span> sizes analysed for{" "}
          <span className="font-semibold">{clubName}</span>. Recommended total order:{" "}
          <span className="font-semibold">{totalRecommendedOrder}</span> jerseys.
        </div>
        <button
          type="button"
          onClick={handleExportCsv}
          disabled={planRows.length === 0}
          className="self-start md:self-auto px-4 py-2 rounded bg-slate-800 text-white text-sm disabled:bg-gray-400"
        >
          Export CSV for {clubName}
        </button>
      </div>

      {loading && <div className="text-sm text-gray-600 mb-4">Calculating stock plan…</div>}

      {!loading && planRows.length === 0 && (
        <div className="text-sm text-gray-500 mb-4">
          No inventory/usage found for this club yet.
        </div>
      )}

      {!loading && planRows.length > 0 && (
        <div className="overflow-x-auto bg-white rounded-lg shadow">
          <table className="min-w-full text-xs">
            <thead className="bg-gray-100">
              <tr>
                <th className="px-3 py-2 text-left">Size</th>
                <th className="px-3 py-2 text-left">Avail</th>
                <th className="px-3 py-2 text-left">Reserved</th>
                <th className="px-3 py-2 text-left">Effective</th>
                <th className="px-3 py-2 text-left"># Numbers</th>
                <th className="px-3 py-2 text-left">Entropy</th>
                <th className="px-3 py-2 text-left">Constrained #s</th>
                <th className="px-3 py-2 text-left">Weekly Usage</th>
                <th className="px-3 py-2 text-left">Weeks Cover</th>
                <th className="px-3 py-2 text-left">Status</th>
                <th className="px-3 py-2 text-left">Suggested Order</th>
                <th className="px-3 py-2 text-left">Notes</th>
              </tr>
            </thead>
            <tbody>
              {planRows.map((row) => {
                const statusBadgeClasses =
                  row.status === "ORDER_NOW"
                    ? "bg-red-100 text-red-800 border-red-200"
                    : row.status === "WATCH"
                    ? "bg-amber-100 text-amber-800 border-amber-200"
                    : "bg-emerald-100 text-emerald-800 border-emerald-200";

                const statusLabel =
                  row.status === "ORDER_NOW" ? "Order Now" : row.status === "WATCH" ? "Watch" : "OK";

                return (
                  <tr
                    key={row.size}
                    className="border-t border-gray-100 odd:bg-white even:bg-gray-50"
                  >
                    <td className="px-3 py-2 align-top">{row.size}</td>
                    <td className="px-3 py-2 align-top">{row.availableStock}</td>
                    <td className="px-3 py-2 align-top">{row.reservedStock}</td>
                    <td className="px-3 py-2 align-top font-semibold">{row.effectiveStock}</td>
                    <td className="px-3 py-2 align-top">{row.distinctNumbersAvailable}</td>
                    <td className="px-3 py-2 align-top">
                      {row.numberEntropy !== null ? row.numberEntropy.toFixed(2) : "—"}
                    </td>
                    <td className="px-3 py-2 align-top">{row.constrainedNumbers}</td>
                    <td className="px-3 py-2 align-top">{row.weeklyUsage.toFixed(2)}</td>
                    <td className="px-3 py-2 align-top">
                      {row.weeksOfCover !== null ? row.weeksOfCover.toFixed(1) : "—"}
                    </td>
                    <td className="px-3 py-2 align-top">
                      <span
                        className={`inline-flex items-center px-2 py-0.5 rounded-full text-[11px] border ${statusBadgeClasses}`}
                      >
                        {statusLabel}
                      </span>
                    </td>
                    <td className="px-3 py-2 align-top">
                      {row.recommendedOrder > 0 ? (
                        <span className="font-semibold text-gray-800">{row.recommendedOrder}</span>
                      ) : (
                        <span className="text-gray-400">—</span>
                      )}
                    </td>
                    <td className="px-3 py-2 align-top text-[11px] text-gray-600">
                      {row.notes}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
};

export default StockPlanner;
