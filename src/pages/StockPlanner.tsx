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
}

interface AllocationRow {
  id: string;
  allocation_type: AllocationType;
  size: string | null;
  created_at: string;
}

interface ClubSettings {
  club_id: string;
  lead_time_weeks: number;
  target_weeks_cover: number;
  min_buffer_units: number;
}

interface SizePlanRow {
  size: string;
  currentStock: number;
  weeklyUsage: number;
  weeksOfCover: number | null;
  recommendedOrder: number;
  status: "OK" | "WATCH" | "ORDER_NOW";
}

const USAGE_WINDOW_WEEKS = 12; // lookback window

const StockPlanner: React.FC = () => {
  const [clubs, setClubs] = useState<Club[]>([]);
  const [selectedClubId, setSelectedClubId] = useState<string>("");

  const [inventoryRows, setInventoryRows] = useState<InventoryRow[]>([]);
  const [allocationRows, setAllocationRows] = useState<AllocationRow[]>([]);

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
          .select(
            "club_id, lead_time_weeks, target_weeks_cover, min_buffer_units"
          )
          .eq("club_id", selectedClubId)
          .maybeSingle();

        if (error && error.code !== "PGRST116") {
          // PGRST116 is "Results contain 0 rows" which is fine
          console.error("StockPlanner loadSettings error", error);
          setError("Failed to load stock settings for this club.");
          return;
        }

        if (data) {
          setSettings(data as ClubSettings);
        } else {
          // No settings yet – create local default, not saved until user hits Save
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

      const { error } = await supabase
        .from("club_settings")
        .upsert(payload, {
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

  // Load inventory + usage for selected club
  useEffect(() => {
    const loadData = async () => {
      if (!selectedClubId) {
        setInventoryRows([]);
        setAllocationRows([]);
        return;
      }

      setLoading(true);
      setError(null);
      setInfoMessage(null);

      try {
        // 1) Inventory (Available only, we care about stock on hand)
        const { data: invData, error: invError } = await supabase
          .from("inventory")
          .select("size, status")
          .eq("club_id", selectedClubId);

        if (invError) {
          console.error("StockPlanner load inventory error", invError);
          setError("Failed to load inventory for this club.");
          return;
        }

        setInventoryRows((invData ?? []) as InventoryRow[]);

        // 2) Allocation-based usage for last N weeks
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
      } finally {
        setLoading(false);
      }
    };

    void loadData();
  }, [selectedClubId]);

  // Derived per-size plan rows
  const planRows: SizePlanRow[] = useMemo(() => {
    if (!settings) return [];

    const {
      lead_time_weeks,
      target_weeks_cover,
      min_buffer_units,
    } = settings;

    // Aggregate current stock by size (Available only)
    const stockBySize = new Map<string, number>();
    for (const row of inventoryRows) {
      const size = (row.size ?? "").trim();
      if (!size || row.status !== "Available") continue;
      stockBySize.set(size, (stockBySize.get(size) ?? 0) + 1);
    }

    // Aggregate usage events by size over window
    const usageCountBySize = new Map<string, number>();
    for (const row of allocationRows) {
      const size = (row.size ?? "").trim();
      if (!size) continue;
      // each new/swap treated as one "consumption" for that size
      usageCountBySize.set(size, (usageCountBySize.get(size) ?? 0) + 1);
    }

    const allSizes = new Set<string>([
      ...Array.from(stockBySize.keys()),
      ...Array.from(usageCountBySize.keys()),
    ]);

    const rows: SizePlanRow[] = [];

    for (const size of allSizes) {
      const currentStock = stockBySize.get(size) ?? 0;
      const totalUsageEvents = usageCountBySize.get(size) ?? 0;

      const weeklyUsage =
        totalUsageEvents > 0 ? totalUsageEvents / USAGE_WINDOW_WEEKS : 0;

      const weeksOfCover =
        weeklyUsage > 0 ? currentStock / weeklyUsage : null;

      // Consumption expected during lead time
      const consumptionDuringLead = weeklyUsage * lead_time_weeks;

      // Target stock = cover whole (lead + target) plus a small buffer
      const targetStock =
        weeklyUsage * (lead_time_weeks + target_weeks_cover) +
        min_buffer_units;

      const recommendedOrderRaw = targetStock - currentStock;
      const recommendedOrder =
        recommendedOrderRaw > 0 ? Math.ceil(recommendedOrderRaw) : 0;

      // Status logic:
      // - ORDER_NOW: current stock <= expected consumption before new stock arrives
      // - WATCH: current stock > that, but within buffer range
      // - OK: above that
      let status: SizePlanRow["status"] = "OK";

      if (weeklyUsage === 0) {
        // No usage in the last window – just use buffer as simple guardrail
        if (currentStock <= min_buffer_units) {
          status = "WATCH";
        } else {
          status = "OK";
        }
      } else {
        if (currentStock <= consumptionDuringLead) {
          status = "ORDER_NOW";
        } else if (
          currentStock <= consumptionDuringLead + min_buffer_units
        ) {
          status = "WATCH";
        } else {
          status = "OK";
        }
      }

      rows.push({
        size,
        currentStock,
        weeklyUsage: Number(weeklyUsage.toFixed(2)),
        weeksOfCover:
          weeksOfCover !== null ? Number(weeksOfCover.toFixed(1)) : null,
        recommendedOrder,
        status,
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
  }, [inventoryRows, allocationRows, settings]);

  const clubName =
    clubs.find((c) => c.id === selectedClubId)?.name ?? "—";

  const totalRecommendedOrder = planRows.reduce(
    (sum, row) => sum + row.recommendedOrder,
    0
  );

  const handleExportCsv = () => {
    if (!planRows.length) return;

    const header = [
      "Club",
      "Size",
      "CurrentStock",
      "WeeklyUsage",
      "WeeksOfCover",
      "Status",
      "RecommendedOrder",
    ];

    const lines = [
      header.join(","),
      ...planRows.map((row) =>
        [
          `"${clubName.replace(/"/g, '""')}"`,
          `"${row.size.replace(/"/g, '""')}"`,
          row.currentStock,
          row.weeklyUsage,
          row.weeksOfCover ?? "",
          row.status,
          row.recommendedOrder,
        ].join(",")
      ),
    ];

    const blob = new Blob([lines.join("\n")], {
      type: "text/csv;charset=utf-8;",
    });
    const url = URL.createObjectURL(blob);

    const a = document.createElement("a");
    a.href = url;
    a.download = `stock_planner_${clubName.replace(/\s+/g, "_")}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleSettingsChange = (
    field: keyof ClubSettings,
    value: number
  ) => {
    if (!settings) return;
    setSettings({
      ...settings,
      [field]: value,
    });
  };

  return (
    <div>
      <h1 className="text-2xl font-bold mb-4">Stock Planner</h1>
      <p className="text-sm text-gray-600 mb-6">
        This tool helps plan jersey stock for each club by size, using{" "}
        <span className="font-semibold">actual allocation history</span> to
        estimate weekly usage. It combines that with per-club lead time and
        target weeks of cover to suggest when to{" "}
        <span className="font-semibold">order now</span> vs{" "}
        <span className="font-semibold">monitor</span>.
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
            {clubs.length === 0 && (
              <option value="">No client clubs found</option>
            )}
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
                These settings only affect this club. Karen can tune them over
                time.
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
                    handleSettingsChange(
                      "lead_time_weeks",
                      Number(e.target.value) || 0
                    )
                  }
                  className="w-full border rounded px-2 py-1.5 text-xs"
                />
                <p className="mt-1 text-[10px] text-gray-500">
                  How long from PO to jerseys on shelf.
                </p>
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
                    handleSettingsChange(
                      "target_weeks_cover",
                      Number(e.target.value) || 0
                    )
                  }
                  className="w-full border rounded px-2 py-1.5 text-xs"
                />
                <p className="mt-1 text-[10px] text-gray-500">
                  Extra weeks of stock you want beyond lead time.
                </p>
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
                    handleSettingsChange(
                      "min_buffer_units",
                      Number(e.target.value) || 0
                    )
                  }
                  className="w-full border rounded px-2 py-1.5 text-xs"
                />
                <p className="mt-1 text-[10px] text-gray-500">
                  “Safety” units per size. We treat &le; this as thin.
                </p>
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
          <span className="font-semibold">{planRows.length}</span> sizes
          analysed for{" "}
          <span className="font-semibold">{clubName}</span>. Recommended total
          order:{" "}
          <span className="font-semibold">{totalRecommendedOrder}</span>{" "}
          jerseys (sum of suggested orders).
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

      {/* Loading or empty state */}
      {loading && (
        <div className="text-sm text-gray-600 mb-4">
          Calculating stock plan…
        </div>
      )}

      {!loading && planRows.length === 0 && (
        <div className="text-sm text-gray-500 mb-4">
          No inventory/usage found for this club yet. Once allocations and
          stock are populated, this planner will calculate suggestions by size.
        </div>
      )}

      {/* Planner table */}
      {!loading && planRows.length > 0 && (
        <div className="overflow-x-auto bg-white rounded-lg shadow">
          <table className="min-w-full text-xs">
            <thead className="bg-gray-100">
              <tr>
                <th className="px-3 py-2 text-left">Size</th>
                <th className="px-3 py-2 text-left">Current Stock</th>
                <th className="px-3 py-2 text-left">Weekly Usage (est)</th>
                <th className="px-3 py-2 text-left">Weeks of Cover</th>
                <th className="px-3 py-2 text-left">Status</th>
                <th className="px-3 py-2 text-left">Suggested Order</th>
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
                  row.status === "ORDER_NOW"
                    ? "Order Now"
                    : row.status === "WATCH"
                    ? "Watch"
                    : "OK";

                return (
                  <tr
                    key={row.size}
                    className="border-t border-gray-100 odd:bg-white even:bg-gray-50"
                  >
                    <td className="px-3 py-2 align-top">{row.size}</td>
                    <td className="px-3 py-2 align-top">
                      {row.currentStock}
                    </td>
                    <td className="px-3 py-2 align-top">
                      {row.weeklyUsage.toFixed(2)}
                    </td>
                    <td className="px-3 py-2 align-top">
                      {row.weeksOfCover !== null
                        ? row.weeksOfCover.toFixed(1)
                        : "—"}
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
                        <span className="font-semibold text-gray-800">
                          {row.recommendedOrder}
                        </span>
                      ) : (
                        <span className="text-gray-400">—</span>
                      )}
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
