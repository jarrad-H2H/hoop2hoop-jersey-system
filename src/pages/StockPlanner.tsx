// FILE: src/pages/StockPlanner.tsx
import React, { useEffect, useMemo, useState } from "react";
import { supabase } from "../services/supabase";

// ─── Constants ──────────────────────────────────────────────────────────────
const SEASON_YEAR = new Date().getFullYear();
const USAGE_WINDOW_WEEKS = 12;
const TREND_WINDOW_WEEKS = 4;
const EXCLUDED_NUMBERS = new Set([69]);
const ALL_NUMBERS = Array.from({ length: 100 }, (_, i) => i).filter(
  (n) => !EXCLUDED_NUMBERS.has(n)
); // 0–68, 70–99 = 99 candidates

const PRICE_BREAK_TIERS = [1, 10, 50, 100, 200];

const SIZE_ORDER = ["YXS", "YS", "YM", "YL", "XS", "S", "M", "L", "XL", "2XL", "3XL"];

const STATUS_COLORS: Record<string, string> = {
  ORDER_NOW: "bg-red-100 text-red-800 border-red-300",
  WATCH: "bg-amber-100 text-amber-800 border-amber-300",
  OK: "bg-emerald-100 text-emerald-800 border-emerald-300",
  DEAD_STOCK: "bg-gray-100 text-gray-600 border-gray-300",
};

// ─── Types ───────────────────────────────────────────────────────────────────
interface Club {
  id: string;
  name: string;
}

interface InventoryRow {
  size: string | null;
  status: string;
  jersey_number: number | null;
}

interface AllocationRow {
  size: string | null;
  created_at: string;
}

interface OrderRow {
  size: string | null;
  year_of_birth: number | null;
  purchased_at: string;
}

interface PlayerRow {
  age_group: string | null;
  year_of_birth: number | null;
  final_shirt: number | null;
}

interface PendingRow {
  size: string | null;
  jersey_number: number | null;
  status: string;
  expires_at: string | null;
}

interface ClubSettings {
  club_id: string;
  lead_time_weeks: number;
  target_weeks_cover: number;
  min_buffer_units: number;
  min_order_qty: number;
  min_distinct_numbers: number | null;
}

interface SizePlanRow {
  size: string;
  availableStock: number;
  allocatedStock: number;
  reservedStock: number;
  effectiveStock: number;
  writtenOffCount: number;
  distinctNumbersAvailable: number;
  distinctNumbersAllocated: number;
  autoMinDistinct: number;
  effectiveMinDistinct: number;
  constrainedNumbers: string;
  numberEntropy: number | null;
  weeklyUsage: number;
  weeksOfCover: number | null;
  demandTrend: "up" | "down" | "flat" | null;
  trendPct: number | null;
  primaryAgeGroups: string[];
  ageGroupBreakdown: { ageGroup: string; count: number }[];
  recommendedOrder: number;
  suggestedNumbers: number[];
  status: "OK" | "WATCH" | "ORDER_NOW" | "DEAD_STOCK";
  notes: string;
}

// ─── Utilities ───────────────────────────────────────────────────────────────
function deriveAgeGroup(yob: number): string {
  const age = SEASON_YEAR - yob;
  if (age <= 9) return "U10";
  if (age <= 11) return "U12";
  if (age <= 13) return "U14";
  if (age <= 15) return "U16";
  if (age <= 17) return "U18";
  if (age <= 19) return "U20";
  return "SLG";
}

function computeNormalizedEntropy(depths: number[]): number | null {
  const total = depths.reduce((a, b) => a + b, 0);
  if (!Number.isFinite(total) || total <= 0) return null;
  const probs = depths.map((d) => d / total).filter((p) => p > 0);
  if (probs.length <= 1) return 0;
  let h = 0;
  for (const p of probs) h += -p * Math.log(p);
  const hMax = Math.log(probs.length);
  if (hMax <= 0) return 0;
  return Math.max(0, Math.min(1, Number((h / hMax).toFixed(3))));
}

function nextPriceBreak(qty: number): number | null {
  for (const tier of PRICE_BREAK_TIERS) {
    if (tier > qty) return tier;
  }
  return null;
}

// ─── Component ───────────────────────────────────────────────────────────────
const StockPlanner: React.FC = () => {
  const [clubs, setClubs] = useState<Club[]>([]);
  const [selectedClubId, setSelectedClubId] = useState<string>("");

  // Product type (default/mens/womens) -- a dual-product club has a completely
  // separate stock pool per type. Every data source below must be scoped to the
  // same product type, or planning numbers silently combine mens+womens.
  const [productTypeOptions, setProductTypeOptions] = useState<string[]>(["default"]);
  const [selectedProductType, setSelectedProductType] = useState<string>("default");

  const [inventoryRows, setInventoryRows] = useState<InventoryRow[]>([]);
  const [writtenOffRows, setWrittenOffRows] = useState<InventoryRow[]>([]);
  const [allocationRows, setAllocationRows] = useState<AllocationRow[]>([]);
  const [orderRows, setOrderRows] = useState<OrderRow[]>([]);
  const [playerRows, setPlayerRows] = useState<PlayerRow[]>([]);
  const [pendingRows, setPendingRows] = useState<PendingRow[]>([]);
  const [settings, setSettings] = useState<ClubSettings | null>(null);

  const [loading, setLoading] = useState(false);
  const [loadingSettings, setLoadingSettings] = useState(false);
  const [settingsSaving, setSettingsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [infoMessage, setInfoMessage] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);

  // ── Load clubs ──────────────────────────────────────────────────────────
  useEffect(() => {
    supabase
      .from("clubs")
      .select("id, name")
      .eq("is_client", true)
      .order("name")
      .then(({ data }) => {
        const list = (data ?? []) as Club[];
        setClubs(list);
        if (list.length > 0) setSelectedClubId(list[0].id);
      });
  }, []);

  // ── Load which product types this club actually has Shopify products for ──
  useEffect(() => {
    if (!selectedClubId) {
      setProductTypeOptions(["default"]);
      setSelectedProductType("default");
      return;
    }
    supabase
      .from("shopify_product_club_map")
      .select("product_type")
      .eq("club_id", selectedClubId)
      .then(({ data }) => {
        const mapped = Array.from(
          new Set((data ?? []).map((r: any) => (r.product_type || "default").trim()))
        );
        const options = Array.from(new Set(["default", ...mapped]));
        setProductTypeOptions(options);
        setSelectedProductType((prev) => (options.includes(prev) ? prev : "default"));
      });
  }, [selectedClubId]);

  // ── Load settings ───────────────────────────────────────────────────────
  useEffect(() => {
    if (!selectedClubId) { setSettings(null); return; }
    setLoadingSettings(true);
    supabase
      .from("club_settings")
      .select("*")
      .eq("club_id", selectedClubId)
      .maybeSingle()
      .then(({ data }) => {
        if (data) {
          setSettings(data as ClubSettings);
        } else {
          setSettings({
            club_id: selectedClubId,
            lead_time_weeks: 4,
            target_weeks_cover: 8,
            min_buffer_units: 5,
            min_order_qty: 10,
            min_distinct_numbers: null,
          });
        }
        setLoadingSettings(false);
      });
  }, [selectedClubId]);

  // ── Load all data ───────────────────────────────────────────────────────
  useEffect(() => {
    if (!selectedClubId) {
      setInventoryRows([]); setWrittenOffRows([]); setAllocationRows([]);
      setOrderRows([]); setPlayerRows([]); setPendingRows([]);
      return;
    }

    setLoading(true);
    setError(null);

    const windowStart = new Date();
    windowStart.setDate(windowStart.getDate() - USAGE_WINDOW_WEEKS * 7);

    Promise.all([
      // Active inventory (not written off)
      supabase
        .from("inventory")
        .select("size, status, jersey_number")
        .eq("club_id", selectedClubId)
        .eq("product_type", selectedProductType)
        .neq("status", "Written Off"),
      // Written off separately for count
      supabase
        .from("inventory")
        .select("size, status, jersey_number")
        .eq("club_id", selectedClubId)
        .eq("product_type", selectedProductType)
        .eq("status", "Written Off"),
      // Allocations for usage rate (12-week window)
      supabase
        .from("allocations")
        .select("size, created_at")
        .eq("club_id", selectedClubId)
        .eq("product_type", selectedProductType)
        .in("allocation_type", ["new", "swap"])
        .gte("created_at", windowStart.toISOString()),
      // Orders (all-time) for age group × size analysis + demand trend
      supabase
        .from("orders")
        .select("size, year_of_birth, purchased_at")
        .eq("club_id", selectedClubId)
        .eq("product_type", selectedProductType),
      // Players with final jersey assignment (for number exclusion) -- NOT filtered by
      // product_type: players aren't gendered-by-product, and a number already worn by
      // ANY player must still be excluded from print suggestions regardless of pool.
      supabase
        .from("players")
        .select("age_group, year_of_birth, final_shirt")
        .eq("club_id", selectedClubId)
        .not("final_shirt", "is", null),
      // Pending reservations
      supabase
        .from("pending_allocations")
        .select("size, jersey_number, status, expires_at")
        .eq("club_id", selectedClubId)
        .eq("product_type", selectedProductType),
    ]).then(([inv, writtenOff, alloc, orders, players, pending]) => {
      setInventoryRows((inv.data ?? []) as InventoryRow[]);
      setWrittenOffRows((writtenOff.data ?? []) as InventoryRow[]);
      setAllocationRows((alloc.data ?? []) as AllocationRow[]);
      setOrderRows((orders.data ?? []) as OrderRow[]);
      setPlayerRows((players.data ?? []) as PlayerRow[]);
      setPendingRows((pending.data ?? []) as PendingRow[]);
      setLoading(false);
    }).catch(() => {
      setError("Failed to load data. Please refresh.");
      setLoading(false);
    });
  }, [selectedClubId, selectedProductType]);

  // ── Save settings ───────────────────────────────────────────────────────
  const handleSaveSettings = async () => {
    if (!selectedClubId || !settings) return;
    setSettingsSaving(true);
    setError(null);
    setInfoMessage(null);
    const { error: saveErr } = await supabase.from("club_settings").upsert(
      {
        club_id: selectedClubId,
        lead_time_weeks: settings.lead_time_weeks,
        target_weeks_cover: settings.target_weeks_cover,
        min_buffer_units: settings.min_buffer_units,
        min_order_qty: settings.min_order_qty,
        min_distinct_numbers: settings.min_distinct_numbers,
      },
      { onConflict: "club_id" }
    );
    if (saveErr) setError("Failed to save settings.");
    else setInfoMessage("Settings saved.");
    setSettingsSaving(false);
  };

  // ─── Main computation ────────────────────────────────────────────────────
  const planRows: SizePlanRow[] = useMemo(() => {
    if (!settings) return [];

    const { lead_time_weeks, target_weeks_cover, min_buffer_units } = settings;
    const nowMs = Date.now();
    const trendCutMs = nowMs - TREND_WINDOW_WEEKS * 7 * 24 * 3600 * 1000;
    const prevTrendCutMs = trendCutMs - TREND_WINDOW_WEEKS * 7 * 24 * 3600 * 1000;

    // ── 1. Inventory split by status ────────────────────────────────────
    const availableBySize = new Map<string, number>();
    const allocatedBySize = new Map<string, number>();
    const availableDepth = new Map<string, Map<number, number>>();
    const allocatedNumbers = new Map<string, Set<number>>();
    const allActiveNumbers = new Map<string, Set<number>>(); // available + allocated

    for (const row of inventoryRows) {
      const size = (row.size ?? "").trim();
      if (!size) continue;
      const n = typeof row.jersey_number === "number" ? row.jersey_number : null;

      if (row.status === "Available") {
        availableBySize.set(size, (availableBySize.get(size) ?? 0) + 1);
        if (n !== null && Number.isFinite(n)) {
          const dm = availableDepth.get(size) ?? new Map<number, number>();
          dm.set(n, (dm.get(n) ?? 0) + 1);
          availableDepth.set(size, dm);
          const an = allActiveNumbers.get(size) ?? new Set<number>();
          an.add(n);
          allActiveNumbers.set(size, an);
        }
      } else if (row.status === "Allocated") {
        allocatedBySize.set(size, (allocatedBySize.get(size) ?? 0) + 1);
        if (n !== null && Number.isFinite(n)) {
          const s = allocatedNumbers.get(size) ?? new Set<number>();
          s.add(n);
          allocatedNumbers.set(size, s);
          const an = allActiveNumbers.get(size) ?? new Set<number>();
          an.add(n);
          allActiveNumbers.set(size, an);
        }
      }
    }

    // ── 2. Written-off count by size ────────────────────────────────────
    const writtenOffBySize = new Map<string, number>();
    for (const row of writtenOffRows) {
      const size = (row.size ?? "").trim();
      if (!size) continue;
      writtenOffBySize.set(size, (writtenOffBySize.get(size) ?? 0) + 1);
    }

    // ── 3. Active reservations by size ──────────────────────────────────
    const reservedBySize = new Map<string, number>();
    const reservedDepth = new Map<string, Map<number, number>>();

    for (const r of pendingRows) {
      if (r.status !== "reserved") continue;
      const size = (r.size ?? "").trim();
      if (!size) continue;
      const expMs = r.expires_at ? Date.parse(r.expires_at) : NaN;
      if (!Number.isFinite(expMs) || expMs <= nowMs) continue;
      reservedBySize.set(size, (reservedBySize.get(size) ?? 0) + 1);
      const n = typeof r.jersey_number === "number" ? r.jersey_number : null;
      if (n !== null && Number.isFinite(n)) {
        const dm = reservedDepth.get(size) ?? new Map<number, number>();
        dm.set(n, (dm.get(n) ?? 0) + 1);
        reservedDepth.set(size, dm);
      }
    }

    // ── 4. Usage from allocations (12-week window) ──────────────────────
    const usageBySize = new Map<string, number>();
    for (const row of allocationRows) {
      const size = (row.size ?? "").trim();
      if (!size) continue;
      usageBySize.set(size, (usageBySize.get(size) ?? 0) + 1);
    }

    // ── 5. Orders: age group breakdown + demand trend ───────────────────
    const ageGroupBySize = new Map<string, Map<string, number>>();
    const recentOrdersBySize = new Map<string, number>();
    const prevOrdersBySize = new Map<string, number>();

    for (const row of orderRows) {
      const size = (row.size ?? "").trim();
      if (!size) continue;
      const tsMs = row.purchased_at ? Date.parse(row.purchased_at) : NaN;

      // Age group breakdown
      if (row.year_of_birth && Number.isFinite(row.year_of_birth)) {
        const ag = deriveAgeGroup(row.year_of_birth);
        const agMap = ageGroupBySize.get(size) ?? new Map<string, number>();
        agMap.set(ag, (agMap.get(ag) ?? 0) + 1);
        ageGroupBySize.set(size, agMap);
      }

      // Demand trend (last 4 weeks vs prior 4 weeks)
      if (Number.isFinite(tsMs)) {
        if (tsMs >= trendCutMs) {
          recentOrdersBySize.set(size, (recentOrdersBySize.get(size) ?? 0) + 1);
        } else if (tsMs >= prevTrendCutMs) {
          prevOrdersBySize.set(size, (prevOrdersBySize.get(size) ?? 0) + 1);
        }
      }
    }

    // ── 6. Player final_shirt by age group (for number exclusions) ──────
    const playerNumsByAgeGroup = new Map<string, Set<number>>();
    for (const p of playerRows) {
      if (p.final_shirt === null || p.final_shirt === undefined) continue;
      let ag = p.age_group ?? null;
      if (!ag && p.year_of_birth) ag = deriveAgeGroup(p.year_of_birth);
      if (!ag) continue;
      const s = playerNumsByAgeGroup.get(ag) ?? new Set<number>();
      s.add(p.final_shirt);
      playerNumsByAgeGroup.set(ag, s);
    }

    // ── 7. Build plan rows ───────────────────────────────────────────────
    const allSizes = new Set<string>([
      ...Array.from(availableBySize.keys()),
      ...Array.from(allocatedBySize.keys()),
      ...Array.from(usageBySize.keys()),
    ]);

    const rows: SizePlanRow[] = [];

    for (const size of allSizes) {
      const availableStock = availableBySize.get(size) ?? 0;
      const allocatedStock = allocatedBySize.get(size) ?? 0;
      const reservedStock = reservedBySize.get(size) ?? 0;
      const effectiveStock = Math.max(0, availableStock - reservedStock);
      const writtenOffCount = writtenOffBySize.get(size) ?? 0;

      // Usage
      const totalUsage = usageBySize.get(size) ?? 0;
      const weeklyUsage = totalUsage > 0 ? totalUsage / USAGE_WINDOW_WEEKS : 0;
      const weeksOfCover = weeklyUsage > 0 ? effectiveStock / weeklyUsage : null;
      const consumptionDuringLead = weeklyUsage * lead_time_weeks;
      const targetStock =
        weeklyUsage * (lead_time_weeks + target_weeks_cover) + min_buffer_units;
      const recommendedOrderRaw = targetStock - effectiveStock;
      const recommendedOrder =
        recommendedOrderRaw > 0 ? Math.ceil(recommendedOrderRaw) : 0;

      // Number flexibility
      const avDepth = availableDepth.get(size) ?? new Map<number, number>();
      const resDepth = reservedDepth.get(size) ?? new Map<number, number>();
      const effDepths: number[] = [];
      const constrained: { n: number; d: number }[] = [];

      for (const [n, dAvail] of avDepth.entries()) {
        const dRes = resDepth.get(n) ?? 0;
        const dEff = dAvail - dRes;
        if (dEff <= 0) continue;
        effDepths.push(dEff);
        constrained.push({ n, d: dEff });
      }
      constrained.sort((a, b) => a.d !== b.d ? a.d - b.d : a.n - b.n);
      const distinctNumbersAvailable = constrained.length;
      const constrainedNumbers = constrained
        .slice(0, 3)
        .map((x) => `${x.n}(×${x.d})`)
        .join(", ");
      const numberEntropy = computeNormalizedEntropy(effDepths);

      // Auto min_distinct: current allocated distinct numbers × 1.2 (min 5)
      const distinctNumbersAllocated = allocatedNumbers.get(size)?.size ?? 0;
      const autoMinDistinct = Math.max(5, Math.ceil(distinctNumbersAllocated * 1.2));
      const effectiveMinDistinct = settings.min_distinct_numbers ?? autoMinDistinct;

      // Age group breakdown
      const agMap = ageGroupBySize.get(size) ?? new Map<string, number>();
      const ageGroupBreakdown = Array.from(agMap.entries())
        .map(([ageGroup, count]) => ({ ageGroup, count }))
        .sort((a, b) => b.count - a.count);
      const primaryAgeGroups = ageGroupBreakdown.slice(0, 2).map((x) => x.ageGroup);

      // Demand trend
      const recent = recentOrdersBySize.get(size) ?? 0;
      const prev = prevOrdersBySize.get(size) ?? 0;
      let demandTrend: SizePlanRow["demandTrend"] = null;
      let trendPct: number | null = null;
      if (prev > 0) {
        trendPct = Math.round(((recent - prev) / prev) * 100);
        demandTrend = trendPct >= 20 ? "up" : trendPct <= -20 ? "down" : "flat";
      } else if (recent > 0) {
        demandTrend = "up";
        trendPct = null;
      }

      // Number suggestions
      // Taken = all numbers currently in inventory (available + allocated) for this size
      //       + final_shirt of players in primary age groups for this size
      const takenNumbers = new Set<number>(allActiveNumbers.get(size) ?? []);
      for (const ag of primaryAgeGroups) {
        for (const n of (playerNumsByAgeGroup.get(ag) ?? new Set())) {
          takenNumbers.add(n);
        }
      }
      const suggestedNumbers = ALL_NUMBERS
        .filter((n) => !takenNumbers.has(n))
        .slice(0, Math.max(recommendedOrder, 0));

      // Status determination
      let status: SizePlanRow["status"] = "OK";
      let notes = "";

      const isDead =
        weeklyUsage === 0 &&
        totalUsage === 0 &&
        effectiveStock > min_buffer_units;

      if (isDead) {
        status = "DEAD_STOCK";
        notes = `No sales in ${USAGE_WINDOW_WEEKS} weeks with ${effectiveStock} units on hand. Consider pausing reorders for this size.`;
      } else if (weeklyUsage === 0) {
        status = effectiveStock <= min_buffer_units ? "WATCH" : "OK";
        notes = "No recent sales detected.";
      } else if (effectiveStock <= consumptionDuringLead) {
        status = "ORDER_NOW";
        notes = `Only ${effectiveStock} effective units — will run out before replenishment (${lead_time_weeks}w lead time).`;
      } else if (effectiveStock <= consumptionDuringLead + min_buffer_units) {
        status = "WATCH";
        notes = "Stock within buffer. Order soon to stay ahead of lead time.";
      } else {
        status = "OK";
        notes = "";
      }

      // Escalate to WATCH if number pool is tight (but not if already ORDER_NOW or DEAD_STOCK)
      if (status === "OK") {
        const lowEntropy = typeof numberEntropy === "number" && numberEntropy < 0.35;
        const belowMinDistinct =
          distinctNumbersAvailable > 0 &&
          distinctNumbersAvailable < effectiveMinDistinct;
        if (lowEntropy || belowMinDistinct) {
          status = "WATCH";
          const tight = constrainedNumbers
            ? ` Tightest: ${constrainedNumbers}.`
            : "";
          notes = belowMinDistinct
            ? `Units OK, but only ${distinctNumbersAvailable} distinct numbers available (min: ${effectiveMinDistinct}).${tight}`
            : `Units OK, but number pool is unevenly distributed.${tight}`;
        }
      }

      rows.push({
        size,
        availableStock,
        allocatedStock,
        reservedStock,
        effectiveStock,
        writtenOffCount,
        distinctNumbersAvailable,
        distinctNumbersAllocated,
        autoMinDistinct,
        effectiveMinDistinct,
        constrainedNumbers,
        numberEntropy,
        weeklyUsage,
        weeksOfCover,
        demandTrend,
        trendPct,
        primaryAgeGroups,
        ageGroupBreakdown,
        recommendedOrder,
        suggestedNumbers,
        status,
        notes,
      });
    }

    // Sort: ORDER_NOW → WATCH → OK → DEAD_STOCK, then by SIZE_ORDER
    const statusRank: Record<string, number> = {
      ORDER_NOW: 0,
      WATCH: 1,
      OK: 2,
      DEAD_STOCK: 3,
    };
    rows.sort((a, b) => {
      const rd = (statusRank[a.status] ?? 9) - (statusRank[b.status] ?? 9);
      if (rd !== 0) return rd;
      const ai = SIZE_ORDER.indexOf(a.size);
      const bi = SIZE_ORDER.indexOf(b.size);
      if (ai !== -1 && bi !== -1) return ai - bi;
      if (ai !== -1) return -1;
      if (bi !== -1) return 1;
      return a.size.localeCompare(b.size);
    });

    return rows;
  }, [
    inventoryRows,
    writtenOffRows,
    allocationRows,
    orderRows,
    playerRows,
    pendingRows,
    settings,
  ]);

  // ─── Derived ─────────────────────────────────────────────────────────────
  const sizesNeedingOrder = useMemo(
    () => planRows.filter((r) => r.recommendedOrder > 0),
    [planRows]
  );
  const totalRecommendedUnits = useMemo(
    () => sizesNeedingOrder.reduce((s, r) => s + r.recommendedOrder, 0),
    [sizesNeedingOrder]
  );
  const minOrderQty = settings?.min_order_qty ?? 10;
  const nextBreak = nextPriceBreak(totalRecommendedUnits);
  const clubName = clubs.find((c) => c.id === selectedClubId)?.name ?? "";

  // ─── CSV export ───────────────────────────────────────────────────────────
  const handleExportCsv = () => {
    if (!planRows.length) return;
    const headers = [
      "Size", "Status",
      "Available", "Allocated", "Reserved", "Effective",
      "Written Off",
      "Distinct Avail", "Min Distinct", "Auto Min Distinct",
      "Weekly Usage", "Weeks Cover", "Trend",
      "Primary Age Groups", "Rec. Order", "Suggested Numbers",
    ];
    const csvRows = planRows.map((r) => [
      r.size, r.status,
      r.availableStock, r.allocatedStock, r.reservedStock, r.effectiveStock,
      r.writtenOffCount,
      r.distinctNumbersAvailable, r.effectiveMinDistinct, r.autoMinDistinct,
      r.weeklyUsage.toFixed(2),
      r.weeksOfCover !== null ? r.weeksOfCover.toFixed(1) : "",
      r.demandTrend ?? "",
      r.primaryAgeGroups.join(" / ") || "",
      r.recommendedOrder,
      r.suggestedNumbers.join(", "),
    ]);
    const csv = [headers, ...csvRows]
      .map((row) =>
        row.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(",")
      )
      .join("\n");
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `stock-plan-${clubName || "club"}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  // ─── Render ───────────────────────────────────────────────────────────────
  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">Stock Planner</h1>

      {/* Club + Product Type selectors */}
      <div className="flex items-center gap-3">
        <label className="text-sm font-semibold">Club</label>
        <select
          value={selectedClubId}
          onChange={(e) => setSelectedClubId(e.target.value)}
          className="border rounded px-3 py-1.5 text-sm"
        >
          {clubs.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>

        <label className="text-sm font-semibold">Product Type</label>
        <select
          value={selectedProductType}
          onChange={(e) => setSelectedProductType(e.target.value)}
          className="border rounded px-3 py-1.5 text-sm"
        >
          {productTypeOptions.map((pt) => (
            <option key={pt} value={pt}>
              {pt === "default" ? "Default / Unisex" : pt === "mens" ? "Mens" : pt === "womens" ? "Womens" : pt}
            </option>
          ))}
        </select>
      </div>

      {error && (
        <div className="text-sm text-red-600 bg-red-50 border border-red-200 rounded p-3">
          {error}
        </div>
      )}
      {infoMessage && (
        <div className="text-sm text-emerald-700 bg-emerald-50 border border-emerald-200 rounded p-3">
          {infoMessage}
        </div>
      )}

      {/* Settings panel */}
      <div className="border rounded bg-white">
        <button
          className="w-full flex justify-between items-center px-4 py-3 text-sm font-semibold text-left hover:bg-gray-50"
          onClick={() => setSettingsOpen((o) => !o)}
        >
          <span>Planning Settings — {clubName}</span>
          <span className="text-gray-400">{settingsOpen ? "▲" : "▼"}</span>
        </button>
        {settingsOpen && settings && !loadingSettings && (
          <div className="px-4 pb-4 border-t pt-4 grid grid-cols-2 md:grid-cols-3 gap-4">
            {(
              [
                {
                  label: "Lead time (weeks)",
                  key: "lead_time_weeks" as keyof ClubSettings,
                  help: "Production + delivery time for new stock.",
                },
                {
                  label: "Target cover (weeks)",
                  key: "target_weeks_cover" as keyof ClubSettings,
                  help: "How many weeks of stock to hold above the lead time buffer.",
                },
                {
                  label: "Min buffer units",
                  key: "min_buffer_units" as keyof ClubSettings,
                  help: "Absolute floor — fewer than this and status escalates to WATCH.",
                },
                {
                  label: "Min order qty (units)",
                  key: "min_order_qty" as keyof ClubSettings,
                  help: "Factory MOQ across all sizes combined. Default: 10.",
                },
              ] as const
            ).map(({ label, key, help }) => (
              <div key={key}>
                <label className="block text-xs font-semibold text-gray-700 mb-1">
                  {label}{" "}
                  <span className="text-gray-400 cursor-help" title={help}>
                    ⓘ
                  </span>
                </label>
                <input
                  type="number"
                  className="border rounded px-2 py-1 text-sm w-full"
                  value={(settings[key] as number) ?? ""}
                  onChange={(e) =>
                    setSettings({ ...settings, [key]: Number(e.target.value) })
                  }
                />
              </div>
            ))}
            <div>
              <label className="block text-xs font-semibold text-gray-700 mb-1">
                Min distinct numbers override{" "}
                <span
                  className="text-gray-400 cursor-help"
                  title="Leave blank to auto-calculate: peak concurrent distinct allocated numbers × 1.2, minimum 5. Override per-club if needed."
                >
                  ⓘ
                </span>
              </label>
              <input
                type="number"
                className="border rounded px-2 py-1 text-sm w-full"
                placeholder="Auto"
                value={settings.min_distinct_numbers ?? ""}
                onChange={(e) =>
                  setSettings({
                    ...settings,
                    min_distinct_numbers:
                      e.target.value === "" ? null : Number(e.target.value),
                  })
                }
              />
            </div>
            <div className="col-span-full">
              <button
                onClick={handleSaveSettings}
                disabled={settingsSaving}
                className="px-4 py-1.5 bg-brand-600 text-white text-sm rounded hover:bg-brand-700 disabled:opacity-50"
              >
                {settingsSaving ? "Saving…" : "Save Settings"}
              </button>
            </div>
          </div>
        )}
      </div>

      {loading && <p className="text-sm text-gray-500">Loading…</p>}

      {!loading && planRows.length > 0 && (
        <>
          {/* Summary cards */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <div
              className={`border rounded p-3 ${
                sizesNeedingOrder.length > 0
                  ? "border-red-300 bg-red-50"
                  : "border-gray-200 bg-white"
              }`}
            >
              <div className="text-xs text-gray-500 font-medium">
                Sizes needing order
              </div>
              <div className="text-2xl font-bold mt-1">
                {sizesNeedingOrder.length}
              </div>
              <div className="text-xs text-gray-500 mt-0.5">
                {sizesNeedingOrder.map((r) => r.size).join(", ") || "None"}
              </div>
            </div>
            <div
              className={`border rounded p-3 ${
                totalRecommendedUnits > 0
                  ? "border-amber-300 bg-amber-50"
                  : "border-gray-200 bg-white"
              }`}
            >
              <div className="text-xs text-gray-500 font-medium">
                Total units recommended
              </div>
              <div className="text-2xl font-bold mt-1">
                {totalRecommendedUnits}
              </div>
              <div className="text-xs text-gray-500 mt-0.5">
                {totalRecommendedUnits >= minOrderQty
                  ? `✓ Meets MOQ (${minOrderQty})`
                  : totalRecommendedUnits > 0
                  ? `⚠ Below MOQ — need ${minOrderQty - totalRecommendedUnits} more`
                  : "No order needed"}
              </div>
            </div>
            <div className="border rounded p-3 bg-white border-gray-200">
              <div className="text-xs text-gray-500 font-medium">
                Next price break
              </div>
              <div className="text-2xl font-bold mt-1">
                {nextBreak ? `${nextBreak}+` : "Max tier"}
              </div>
              <div className="text-xs text-gray-500 mt-0.5">
                {nextBreak
                  ? `Add ${nextBreak - totalRecommendedUnits} more units`
                  : "Already at best price tier"}
              </div>
            </div>
            <div className="border rounded p-3 bg-white border-gray-200">
              <div className="text-xs text-gray-500 font-medium">
                Dead stock sizes
              </div>
              <div className="text-2xl font-bold mt-1">
                {planRows.filter((r) => r.status === "DEAD_STOCK").length}
              </div>
              <div className="text-xs text-gray-500 mt-0.5">
                Zero sales in {USAGE_WINDOW_WEEKS} weeks
              </div>
            </div>
          </div>

          {/* Price break reference */}
          <div className="text-xs text-gray-500 bg-gray-50 border rounded px-3 py-2">
            <span className="font-semibold">Price break tiers (units):</span>{" "}
            {PRICE_BREAK_TIERS.map((t, i) => (
              <span key={t}>
                <span
                  className={
                    totalRecommendedUnits >= t &&
                    (i === PRICE_BREAK_TIERS.length - 1 ||
                      totalRecommendedUnits < PRICE_BREAK_TIERS[i + 1])
                      ? "font-bold text-brand-700 underline"
                      : ""
                  }
                >
                  {t}+
                </span>
                {i < PRICE_BREAK_TIERS.length - 1 && (
                  <span className="mx-1 text-gray-300">|</span>
                )}
              </span>
            ))}
            <span className="ml-2 text-gray-400">
              (current: {totalRecommendedUnits} units)
            </span>
          </div>

          {/* Main table */}
          <div className="border rounded bg-white overflow-x-auto">
            <table className="min-w-full text-xs">
              <thead className="bg-gray-100 border-b">
                <tr>
                  <th className="px-3 py-2 text-left font-semibold">Size</th>
                  <th className="px-3 py-2 text-left font-semibold">Status</th>
                  <th
                    className="px-3 py-2 text-right font-semibold"
                    title="Units in warehouse, not yet allocated"
                  >
                    Avail
                  </th>
                  <th
                    className="px-3 py-2 text-right font-semibold"
                    title="Units allocated to players (their jersey)"
                  >
                    Alloc
                  </th>
                  <th
                    className="px-3 py-2 text-right font-semibold"
                    title="Active pending reservations (checkout in progress)"
                  >
                    Res
                  </th>
                  <th
                    className="px-3 py-2 text-right font-semibold"
                    title="Available minus Reserved — what you can actually sell right now"
                  >
                    Effective
                  </th>
                  <th
                    className="px-3 py-2 text-right font-semibold"
                    title="Jerseys permanently written off (players who kept/sold their old jersey). These leave H2H's pool and are not returned to stock."
                  >
                    W/Off ⓘ
                  </th>
                  <th
                    className="px-3 py-2 text-right font-semibold"
                    title={`Average weekly sales over the last ${USAGE_WINDOW_WEEKS} weeks`}
                  >
                    Wk/Usage
                  </th>
                  <th
                    className="px-3 py-2 text-right font-semibold"
                    title="Weeks of effective stock remaining at current usage rate"
                  >
                    Wks Cover
                  </th>
                  <th
                    className="px-3 py-2 text-center font-semibold"
                    title="Demand trend: last 4 weeks vs prior 4 weeks. ↑ = 20%+ increase, ↓ = 20%+ decrease."
                  >
                    Trend ⓘ
                  </th>
                  <th
                    className="px-3 py-2 text-left font-semibold"
                    title="Age groups that most commonly order this size (from all-time order history)"
                  >
                    Age Groups
                  </th>
                  <th
                    className="px-3 py-2 text-right font-semibold"
                    title="Distinct jersey numbers available in stock (avail only) vs minimum threshold. Auto threshold = currently allocated distinct numbers × 1.2, min 5."
                  >
                    Distinct #s ⓘ
                  </th>
                  <th className="px-3 py-2 text-right font-semibold">
                    Rec. Order
                  </th>
                  <th className="px-3 py-2 text-left font-semibold">Notes</th>
                </tr>
              </thead>
              <tbody>
                {planRows.map((row) => {
                  const trendIcon =
                    row.demandTrend === "up"
                      ? "↑"
                      : row.demandTrend === "down"
                      ? "↓"
                      : "→";
                  const trendColor =
                    row.demandTrend === "up"
                      ? "text-emerald-600 font-bold"
                      : row.demandTrend === "down"
                      ? "text-red-500 font-bold"
                      : "text-gray-400";
                  const distinctWarn =
                    row.distinctNumbersAvailable > 0 &&
                    row.distinctNumbersAvailable < row.effectiveMinDistinct;
                  return (
                    <tr
                      key={row.size}
                      className="border-t odd:bg-white even:bg-gray-50 align-top"
                    >
                      <td className="px-3 py-2 font-semibold">{row.size}</td>
                      <td className="px-3 py-2">
                        <span
                          className={`inline-block px-2 py-0.5 rounded border text-[10px] font-semibold ${
                            STATUS_COLORS[row.status]
                          }`}
                        >
                          {row.status.replace("_", " ")}
                        </span>
                      </td>
                      <td className="px-3 py-2 text-right">{row.availableStock}</td>
                      <td className="px-3 py-2 text-right">{row.allocatedStock}</td>
                      <td className="px-3 py-2 text-right">{row.reservedStock}</td>
                      <td className="px-3 py-2 text-right font-semibold">
                        {row.effectiveStock}
                      </td>
                      <td className="px-3 py-2 text-right">
                        {row.writtenOffCount > 0 ? (
                          <span className="text-gray-500">{row.writtenOffCount}</span>
                        ) : (
                          <span className="text-gray-300">—</span>
                        )}
                      </td>
                      <td className="px-3 py-2 text-right">
                        {row.weeklyUsage.toFixed(1)}
                      </td>
                      <td className="px-3 py-2 text-right">
                        {row.weeksOfCover !== null
                          ? row.weeksOfCover.toFixed(1)
                          : "—"}
                      </td>
                      <td className={`px-3 py-2 text-center ${trendColor}`}>
                        {row.demandTrend ? (
                          <span
                            title={
                              row.trendPct !== null
                                ? `${row.trendPct > 0 ? "+" : ""}${row.trendPct}% vs prior 4 weeks`
                                : "New demand detected"
                            }
                          >
                            {trendIcon}
                          </span>
                        ) : (
                          <span className="text-gray-300">—</span>
                        )}
                      </td>
                      <td className="px-3 py-2">
                        {row.primaryAgeGroups.length > 0 ? (
                          <span>{row.primaryAgeGroups.join(", ")}</span>
                        ) : (
                          <span className="text-gray-300">—</span>
                        )}
                      </td>
                      <td
                        className={`px-3 py-2 text-right ${
                          distinctWarn ? "text-amber-700 font-semibold" : ""
                        }`}
                      >
                        {row.distinctNumbersAvailable}
                        <span className="text-gray-400 ml-0.5">
                          /{row.effectiveMinDistinct}
                        </span>
                        {settings?.min_distinct_numbers === null && (
                          <span className="ml-1 text-gray-400 text-[9px]">
                            auto
                          </span>
                        )}
                      </td>
                      <td className="px-3 py-2 text-right font-semibold">
                        {row.recommendedOrder > 0 ? (
                          <span
                            className={
                              row.status === "ORDER_NOW" ? "text-red-700" : ""
                            }
                          >
                            {row.recommendedOrder}
                          </span>
                        ) : (
                          <span className="text-gray-300">—</span>
                        )}
                      </td>
                      <td className="px-3 py-2 text-gray-600 max-w-xs text-[11px]">
                        {row.notes}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {/* Order Builder */}
          {sizesNeedingOrder.length > 0 && (
            <div className="border rounded bg-white">
              <div className="px-4 py-3 border-b bg-gray-50 flex flex-wrap justify-between items-start gap-2">
                <div>
                  <h2 className="text-sm font-bold">
                    Suggested Order — {clubName}
                  </h2>
                  <p className="text-xs text-gray-500 mt-0.5">
                    Numbers drawn from 0–99 (excl. 69), excluding numbers
                    already in stock or assigned to players in each size's
                    primary age groups.
                  </p>
                </div>
                <button
                  onClick={handleExportCsv}
                  className="px-3 py-1.5 bg-brand-600 text-white text-xs rounded hover:bg-brand-700 shrink-0"
                >
                  Export CSV
                </button>
              </div>
              <table className="min-w-full text-xs">
                <thead className="bg-gray-100 border-b">
                  <tr>
                    <th className="px-3 py-2 text-left font-semibold">Size</th>
                    <th className="px-3 py-2 text-left font-semibold">
                      Primary Age Groups
                    </th>
                    <th className="px-3 py-2 text-right font-semibold">
                      Units to Order
                    </th>
                    <th className="px-3 py-2 text-left font-semibold">
                      Suggested Print Numbers
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {sizesNeedingOrder.map((row) => (
                    <tr
                      key={row.size}
                      className="border-t odd:bg-white even:bg-gray-50 align-top"
                    >
                      <td className="px-3 py-2 font-semibold">{row.size}</td>
                      <td className="px-3 py-2">
                        {row.primaryAgeGroups.join(", ") || "—"}
                      </td>
                      <td className="px-3 py-2 text-right font-semibold">
                        {row.recommendedOrder}
                      </td>
                      <td className="px-3 py-2 font-mono">
                        {row.suggestedNumbers.length > 0 ? (
                          row.suggestedNumbers.join(", ")
                        ) : (
                          <span className="text-gray-400 font-sans">
                            All 0–99 numbers in use — review allocations
                          </span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
                <tfoot className="border-t bg-gray-50">
                  <tr>
                    <td
                      colSpan={2}
                      className="px-3 py-2 text-right font-semibold text-xs"
                    >
                      Total
                    </td>
                    <td className="px-3 py-2 text-right font-bold text-xs">
                      {totalRecommendedUnits}
                    </td>
                    <td className="px-3 py-2 text-xs">
                      <span
                        className={
                          totalRecommendedUnits >= minOrderQty
                            ? "text-emerald-700"
                            : "text-amber-700"
                        }
                      >
                        {totalRecommendedUnits >= minOrderQty
                          ? `✓ Meets MOQ (${minOrderQty} units)`
                          : `⚠ Below MOQ — need ${
                              minOrderQty - totalRecommendedUnits
                            } more units`}
                      </span>
                      {nextBreak !== null && (
                        <span className="ml-3 text-gray-500">
                          Next price break at {nextBreak}+ units (
                          {nextBreak - totalRecommendedUnits} more)
                        </span>
                      )}
                    </td>
                  </tr>
                </tfoot>
              </table>
            </div>
          )}

          {/* Age Group × Size breakdown (collapsible) */}
          <AgeGroupBreakdown planRows={planRows} />
        </>
      )}

      {!loading && planRows.length === 0 && selectedClubId && (
        <p className="text-sm text-gray-500">
          No inventory or sales data found for this club.
        </p>
      )}
    </div>
  );
};

// ─── Age Group × Size Breakdown ───────────────────────────────────────────────
interface AgeGroupBreakdownProps {
  planRows: SizePlanRow[];
}

const AgeGroupBreakdown: React.FC<AgeGroupBreakdownProps> = ({ planRows }) => {
  const [open, setOpen] = useState(false);

  const allAgeGroups = useMemo(() => {
    const set = new Set<string>();
    for (const row of planRows) {
      for (const { ageGroup } of row.ageGroupBreakdown) set.add(ageGroup);
    }
    return ["U10", "U12", "U14", "U16", "U18", "U20", "SLG"].filter((ag) =>
      set.has(ag)
    );
  }, [planRows]);

  const hasAgeData = planRows.some((r) => r.ageGroupBreakdown.length > 0);
  if (!hasAgeData) return null;

  return (
    <div className="border rounded bg-white">
      <button
        className="w-full flex justify-between items-center px-4 py-3 text-sm font-semibold text-left hover:bg-gray-50"
        onClick={() => setOpen((o) => !o)}
      >
        <span>Age Group × Size Sales Breakdown</span>
        <span className="text-gray-400">{open ? "▲" : "▼"}</span>
      </button>
      {open && (
        <div className="px-4 pb-4 border-t pt-3 overflow-x-auto">
          <p className="text-xs text-gray-500 mb-3">
            All-time order counts per size × age group (derived from year of
            birth on each order). Highlighted cells = primary age groups used
            for number suggestions.
          </p>
          <table className="min-w-full text-xs border border-gray-200">
            <thead className="bg-gray-100">
              <tr>
                <th className="px-3 py-1.5 text-left border-r border-gray-200">
                  Size
                </th>
                {allAgeGroups.map((ag) => (
                  <th key={ag} className="px-3 py-1.5 text-right">
                    {ag}
                  </th>
                ))}
                <th className="px-3 py-1.5 text-right font-bold">Total</th>
              </tr>
            </thead>
            <tbody>
              {planRows.map((row) => {
                const agLookup = new Map<string, number>(
                  row.ageGroupBreakdown.map((x) => [x.ageGroup, x.count] as [string, number])
                );
                const total = row.ageGroupBreakdown.reduce(
                  (s, x) => s + x.count,
                  0
                );
                return (
                  <tr
                    key={row.size}
                    className="border-t border-gray-200 odd:bg-white even:bg-gray-50"
                  >
                    <td className="px-3 py-1.5 font-semibold border-r border-gray-200">
                      {row.size}
                    </td>
                    {allAgeGroups.map((ag) => {
                      const count = agLookup.get(ag) ?? 0;
                      const isPrimary = row.primaryAgeGroups.includes(ag);
                      return (
                        <td
                          key={ag}
                          className={`px-3 py-1.5 text-right ${
                            isPrimary
                              ? "font-semibold bg-blue-50 text-blue-800"
                              : count === 0
                              ? "text-gray-300"
                              : ""
                          }`}
                        >
                          {count > 0 ? count : "—"}
                        </td>
                      );
                    })}
                    <td className="px-3 py-1.5 text-right font-bold">
                      {total > 0 ? total : "—"}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <p className="text-xs text-gray-400 mt-2">
            Blue = primary age group for that size (top 2 by order count).
          </p>
        </div>
      )}
    </div>
  
  );
};

export default StockPlanner;
