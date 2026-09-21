// FILE: src/components/PreorderNumberPlan.tsx
// Stock Planner section: reads a club's pre-orders (and past orders) to show demand by
// size × birth year, then suggests clash-free print numbers for warehouse stock.
import React, { useEffect, useMemo, useState } from "react";
import { supabase } from "../services/supabase";
import {
  buildCohorts,
  suggestStockNumbers,
  type DemandRow,
  type NumberHolder,
} from "../services/stockNumberPlan";

const SEASON_YEAR = new Date().getFullYear();
const SIZE_ORDER = ["YXS", "YS", "YM", "YL", "XS", "S", "M", "L", "XL", "2XL", "3XL"];
// Girls-only merged divisions -- their numbers don't clash with a boys-only jersey.
const GIRLS_ONLY_AGE_GROUPS = new Set(["JUNIOR", "OPEN GIRLS"]);

interface Props {
  clubId: string;
  clubName: string;
  productType: string;
}

async function fetchAll<T>(build: (from: number, to: number) => PromiseLike<{ data: any; error: any }>): Promise<T[]> {
  const rows: T[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await build(from, from + 999);
    if (error) throw error;
    const page = (data ?? []) as T[];
    rows.push(...page);
    if (page.length < 1000) break;
  }
  return rows;
}

const PreorderNumberPlan: React.FC<Props> = ({ clubId, clubName, productType }) => {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [demand, setDemand] = useState<DemandRow[]>([]);
  const [preorderCount, setPreorderCount] = useState(0);
  const [holders, setHolders] = useState<NumberHolder[]>([]);
  const [stockNumbers, setStockNumbers] = useState<Record<string, Set<number>>>({});
  const [units, setUnits] = useState<Record<string, string>>({});
  const [scaleTotal, setScaleTotal] = useState("");
  const [spareSummary, setSpareSummary] = useState<string[]>([]);

  useEffect(() => {
    if (!clubId) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    (async () => {
      try {
        const [pre, orders, players, inv] = await Promise.all([
          fetchAll<any>((f, t) =>
            supabase
              .from("preorder_requests")
              .select("first_name, last_name, year_of_birth, size, assigned_number, product_type, status")
              .eq("club_id", clubId)
              .in("status", ["allocated", "locked"])
              .range(f, t)
          ),
          fetchAll<any>((f, t) =>
            supabase
              .from("orders")
              .select("year_of_birth, size")
              .eq("club_id", clubId)
              .eq("product_type", productType)
              .range(f, t)
          ),
          fetchAll<any>((f, t) =>
            supabase
              .from("players")
              .select("final_shirt, year_of_birth, estimated_yob_min, estimated_yob_max, age_group, bc_last_seen_season")
              .eq("club_id", clubId)
              .is("deleted_at", null)
              .not("final_shirt", "is", null)
              .range(f, t)
          ),
          fetchAll<any>((f, t) =>
            supabase
              .from("inventory")
              .select("size, jersey_number")
              .eq("club_id", clubId)
              .eq("product_type", productType)
              .eq("status", "Available")
              .range(f, t)
          ),
        ]);
        if (cancelled) return;

        const preForProduct = pre.filter((r) => (r.product_type ?? "default") === productType);
        // "Spare Jersey order" rows are club spares, not player demand -- they count as stock already on order.
        const isSpare = (r: any) =>
          /^spare$/i.test((r.first_name ?? "").trim()) && /jersey order/i.test(r.last_name ?? "");
        const spares = preForProduct.filter(isSpare);
        const d: DemandRow[] = [];
        for (const r of [...preForProduct.filter((r) => !isSpare(r)), ...orders]) {
          if (r.year_of_birth && r.size) d.push({ yob: r.year_of_birth, size: String(r.size).trim() });
        }

        const h: NumberHolder[] = [];
        for (const p of players) {
          const ag = (p.age_group ?? "").trim().toUpperCase();
          if (GIRLS_ONLY_AGE_GROUPS.has(ag)) continue;
          const seen = p.bc_last_seen_season;
          if (seen != null && seen < SEASON_YEAR - 2) continue; // released
          h.push({
            number: p.final_shirt,
            exactYob: p.year_of_birth ?? null,
            estMin: p.estimated_yob_min ?? null,
            estMax: p.estimated_yob_max ?? null,
            ageGroup: p.age_group ?? null,
          });
        }
        // Pre-order assigned numbers with an exact YOB (covers requests not linked to a player row).
        for (const r of pre) {
          if (r.assigned_number != null && r.year_of_birth) {
            h.push({ number: r.assigned_number, exactYob: r.year_of_birth, estMin: null, estMax: null, ageGroup: null });
          }
        }

        const sn: Record<string, Set<number>> = {};
        for (const r of inv) {
          const size = (r.size ?? "").trim();
          if (!size || r.jersey_number == null) continue;
          (sn[size] ??= new Set()).add(r.jersey_number);
        }
        for (const r of spares) {
          const size = (r.size ?? "").trim();
          if (!size || r.assigned_number == null) continue;
          (sn[size] ??= new Set()).add(r.assigned_number);
        }
        setSpareSummary(
          spares
            .filter((r) => r.size && r.assigned_number != null)
            .map((r) => `${r.size} #${r.assigned_number}`)
            .sort()
        );

        setDemand(d);
        setPreorderCount(preForProduct.length);
        setHolders(h);
        setStockNumbers(sn);
        setUnits({});
      } catch (e: any) {
        if (!cancelled) setError(e?.message ?? "Failed to load pre-order data.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [clubId, productType]);

  const sizes = useMemo(() => {
    const set = new Set<string>(demand.map((d) => d.size));
    return Array.from(set).sort((a, b) => {
      const ai = SIZE_ORDER.indexOf(a), bi = SIZE_ORDER.indexOf(b);
      if (ai !== -1 && bi !== -1) return ai - bi;
      if (ai !== -1) return -1;
      if (bi !== -1) return 1;
      return a.localeCompare(b);
    });
  }, [demand]);

  const cohorts = useMemo(() => buildCohorts(holders, demand, SEASON_YEAR, false), [holders, demand]);

  const countBySizeYob = useMemo(() => {
    const m = new Map<string, number>();
    for (const d of demand) m.set(`${d.size}|${d.yob}`, (m.get(`${d.size}|${d.yob}`) ?? 0) + 1);
    return m;
  }, [demand]);

  const sizeTotals = useMemo(() => {
    const m = new Map<string, number>();
    for (const d of demand) m.set(d.size, (m.get(d.size) ?? 0) + 1);
    return m;
  }, [demand]);

  const unitsNum = useMemo(() => {
    const out: Record<string, number> = {};
    for (const s of sizes) out[s] = Math.max(0, Math.floor(Number(units[s]) || 0));
    return out;
  }, [units, sizes]);

  const suggestions = useMemo(
    () => suggestStockNumbers({ cohorts, demand, unitsBySize: unitsNum, stockNumbersBySize: stockNumbers }),
    [cohorts, demand, unitsNum, stockNumbers]
  );
  const totalUnits = sizes.reduce((sum, s) => sum + unitsNum[s], 0);

  const applyScale = () => {
    const total = Math.max(0, Math.floor(Number(scaleTotal) || 0));
    const all = demand.length;
    if (!total || !all) return;
    const next: Record<string, string> = {};
    for (const s of sizes) next[s] = String(Math.round(((sizeTotals.get(s) ?? 0) / all) * total));
    setUnits(next);
  };

  const exportCsv = () => {
    const rows = [["Size", "Units", "Numbers (* = not clash-free for every buyer year)"]];
    for (const s of suggestions) {
      rows.push([s.size, String(s.units), s.numbers.map((n) => (n.coverage < 1 ? `${n.number}*` : String(n.number))).join(" ")]);
    }
    const csv = rows.map((r) => r.map((v) => `"${v.replace(/"/g, '""')}"`).join(",")).join("\n");
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
    a.download = `stock-numbers-${clubName || "club"}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  if (loading) return <div className="text-sm text-gray-500">Loading pre-order data…</div>;
  if (error) return <div className="text-sm text-red-600 bg-red-50 border border-red-200 rounded p-3">{error}</div>;
  if (demand.length === 0) return null;

  return (
    <div className="border rounded bg-white">
      <div className="px-4 py-3 border-b bg-gray-50">
        <h2 className="text-sm font-bold">Pre-order Demand &amp; Stock Numbers — {clubName}</h2>
        <p className="text-xs text-gray-500 mt-0.5">
          Based on {preorderCount} pre-orders plus past orders with a birth year. Suggested numbers are free
          in the ±1 year clash window of the birth years that usually order each size. Girls-only
          (Junior / Open Girls) numbers and released players are ignored.
        </p>
      </div>

      <div className="p-4 space-y-6">
        {spareSummary.length > 0 && (
          <p className="text-xs text-gray-600 bg-gray-50 border rounded px-3 py-2">
            <span className="font-semibold">Club spares already on order</span> (not counted as demand, and
            not re-suggested for the same size): {spareSummary.join(", ")}
          </p>
        )}
        {/* Demand matrix */}
        <div className="overflow-x-auto">
          <h3 className="text-xs font-semibold mb-2">Demand by size × birth year</h3>
          <table className="min-w-full text-xs border border-gray-200">
            <thead className="bg-gray-100">
              <tr>
                <th className="px-3 py-1.5 text-left border-r">Size</th>
                {cohorts.map((c) => (
                  <th key={c.yob} className="px-3 py-1.5 text-right">{c.yob}</th>
                ))}
                <th className="px-3 py-1.5 text-right font-bold">Total</th>
              </tr>
            </thead>
            <tbody>
              {sizes.map((s) => (
                <tr key={s} className="border-t odd:bg-white even:bg-gray-50">
                  <td className="px-3 py-1.5 font-semibold border-r">{s}</td>
                  {cohorts.map((c) => {
                    const n = countBySizeYob.get(`${s}|${c.yob}`) ?? 0;
                    return <td key={c.yob} className={`px-3 py-1.5 text-right ${n ? "" : "text-gray-300"}`}>{n || "—"}</td>;
                  })}
                  <td className="px-3 py-1.5 text-right font-bold">{sizeTotals.get(s)}</td>
                </tr>
              ))}
              <tr className="border-t bg-gray-100 font-semibold">
                <td className="px-3 py-1.5 border-r">Free numbers</td>
                {cohorts.map((c) => (
                  <td key={c.yob} className="px-3 py-1.5 text-right" title={`${c.blocked.size} numbers already worn in this cohort's clash window`}>
                    {c.free.length}
                  </td>
                ))}
                <td />
              </tr>
            </tbody>
          </table>
        </div>

        {/* Stock quantities */}
        <div>
          <h3 className="text-xs font-semibold mb-2">Stock to order (units per size)</h3>
          <div className="flex flex-wrap items-end gap-3 mb-3">
            {sizes.map((s) => (
              <label key={s} className="text-xs">
                <span className="block font-semibold mb-0.5">{s}</span>
                <input
                  type="number"
                  min={0}
                  className="border rounded px-2 py-1 w-16"
                  value={units[s] ?? ""}
                  onChange={(e) => setUnits({ ...units, [s]: e.target.value })}
                />
              </label>
            ))}
            <div className="flex items-end gap-2 ml-4 text-xs">
              <label>
                <span className="block font-semibold mb-0.5">Or scale pre-order mix to total</span>
                <input
                  type="number"
                  min={0}
                  className="border rounded px-2 py-1 w-24"
                  value={scaleTotal}
                  onChange={(e) => setScaleTotal(e.target.value)}
                />
              </label>
              <button onClick={applyScale} className="px-3 py-1.5 border rounded hover:bg-gray-50">Apply</button>
            </div>
          </div>
        </div>

        {/* Suggested numbers */}
        {suggestions.length > 0 && (
          <div>
            <div className="flex justify-between items-center mb-2">
              <h3 className="text-xs font-semibold">Suggested print numbers — {totalUnits} units</h3>
              <button onClick={exportCsv} className="px-3 py-1.5 bg-brand-600 text-white text-xs rounded hover:bg-brand-700">
                Export CSV
              </button>
            </div>
            <table className="min-w-full text-xs">
              <thead className="bg-gray-100 border-b">
                <tr>
                  <th className="px-3 py-2 text-left font-semibold">Size</th>
                  <th className="px-3 py-2 text-right font-semibold">Units</th>
                  <th className="px-3 py-2 text-left font-semibold">Based on birth years</th>
                  <th className="px-3 py-2 text-left font-semibold">Numbers</th>
                </tr>
              </thead>
              <tbody>
                {suggestions.map((s) => (
                  <tr key={s.size} className="border-t align-top odd:bg-white even:bg-gray-50">
                    <td className="px-3 py-2 font-semibold">{s.size}</td>
                    <td className="px-3 py-2 text-right font-semibold">{s.units}</td>
                    <td className="px-3 py-2">{s.cohortYobs.join(", ")}</td>
                    <td className="px-3 py-2 font-mono">
                      {s.numbers.map((n, i) => (
                        <span
                          key={n.number}
                          className={n.coverage < 1 ? "text-amber-700" : ""}
                          title={n.coverage < 1 ? `Clashes for ${Math.round((1 - n.coverage) * 100)}% of this size's buyers` : undefined}
                        >
                          {n.number}{n.coverage < 1 ? "*" : ""}{i < s.numbers.length - 1 ? ", " : ""}
                        </span>
                      ))}
                      {s.shortfall > 0 && (
                        <span className="ml-2 font-sans text-red-600">Only {s.numbers.length} numbers available — short by {s.shortfall}</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="text-[11px] text-gray-500 mt-2">
              * = free for most but not every birth year that orders this size (the widget still blocks the
              clash at purchase time).
            </p>
          </div>
        )}
      </div>
    </div>
  );
};

export default PreorderNumberPlan;
