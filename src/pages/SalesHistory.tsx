// FILE: src/pages/SalesHistory.tsx
// Sales History admin page — shows all completed jersey sales logged by the webhook.
import React, { useEffect, useState, useCallback } from "react";
import { supabase } from "../services/supabase";
import { ShoppingBag, RefreshCw, Filter, Download } from "lucide-react";

type SaleRow = {
  id: string;
  order_number: string | null;
  order_date: string | null;
  purchased_at: string | null;
  player_name: string | null;
  player_first_name: string | null;
  player_last_name: string | null;
  shopify_buyer_name: string | null;
  club_id: string | null;
  product_name: string | null; // used to store club name
  team_name: string | null;
  number: string | null;
  jersey_number: number | null;
  size: string | null;
  season_year: number | null;
  shopify_order_id: string | null;
  product_type: string | null;
};

type Club = { id: string; name: string };

function formatDate(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  // Display in AEST (Brisbane, UTC+10)
  return d.toLocaleString("en-AU", {
    timeZone: "Australia/Brisbane",
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

const SalesHistory: React.FC = () => {
  const [sales, setSales] = useState<SaleRow[]>([]);
  const [clubs, setClubs] = useState<Club[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Filters
  const [filterClub, setFilterClub] = useState<string>("");
  const [filterSeason, setFilterSeason] = useState<string>("");
  const [filterSearch, setFilterSearch] = useState<string>("");
  const [filterProductType, setFilterProductType] = useState<string>("");

  const loadData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [{ data: salesData, error: sErr }, { data: clubData }] = await Promise.all([
        supabase
          .from("orders")
          .select("*")
          .not("purchased_at", "is", null)
          .order("purchased_at", { ascending: false }),
        supabase.from("clubs").select("id, name").order("name"),
      ]);

      if (sErr) throw sErr;
      setSales((salesData ?? []) as SaleRow[]);
      setClubs((clubData ?? []) as Club[]);
    } catch (e: any) {
      setError(e?.message ?? "Failed to load sales history.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadData(); }, [loadData]);

  // Derive available seasons from data
  const seasonYears: number[] = sales
    .map((s) => s.season_year)
    .filter((y): y is number => y != null);
  const seasons = Array.from(new Set(seasonYears)).sort((a, b) => b - a);

  // Derive available product types from data
  const productTypes = Array.from(
    new Set(sales.map((s) => s.product_type || "default"))
  ).sort();

  // Apply filters
  const filtered = sales.filter((s) => {
    if (filterClub && s.club_id !== filterClub) return false;
    if (filterSeason && String(s.season_year) !== filterSeason) return false;
    if (filterProductType && (s.product_type || "default") !== filterProductType) return false;
    if (filterSearch) {
      const q = filterSearch.toLowerCase();
      const haystack = [
        s.player_name, s.player_first_name, s.player_last_name,
        s.order_number, s.number, s.size, s.shopify_buyer_name,
      ]
        .join(" ")
        .toLowerCase();
      if (!haystack.includes(q)) return false;
    }
    return true;
  });

  // Club name lookup
  const clubMap = Object.fromEntries(clubs.map((c) => [c.id, c.name]));

  // CSV export
  const handleExport = () => {
    const headers = ["Order #", "Date (AEST)", "Club", "Player First", "Player Last", "Jersey #", "Size", "Product Type", "Season", "Shopify Buyer", "Shopify Order ID"];
    const rows = filtered.map((s) => [
      s.order_number ?? "",
      formatDate(s.purchased_at ?? s.order_date),
      clubMap[s.club_id ?? ""] ?? s.product_name ?? s.club_id ?? "",
      s.player_first_name ?? s.player_name ?? "",
      s.player_last_name ?? "",
      s.jersey_number ?? s.number ?? "",
      s.size ?? "",
      s.product_type ?? "default",
      s.season_year ?? "",
      s.shopify_buyer_name ?? "",
      s.shopify_order_id ?? "",
    ]);
    const csv = [headers, ...rows]
      .map((r) => r.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(","))
      .join("\n");
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `sales-history-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div>
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <ShoppingBag size={28} className="text-brand-600" />
          <div>
            <h1 className="text-2xl font-bold text-gray-900">Sales History</h1>
            <p className="text-sm text-gray-500 mt-0.5">
              All completed jersey purchases recorded from Shopify orders.
            </p>
          </div>
        </div>
        <div className="flex gap-2">
          <button
            onClick={loadData}
            className="flex items-center gap-2 px-3 py-2 text-sm border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors"
          >
            <RefreshCw size={15} />
            Refresh
          </button>
          <button
            onClick={handleExport}
            disabled={filtered.length === 0}
            className="flex items-center gap-2 px-3 py-2 text-sm bg-brand-600 text-white rounded-lg hover:bg-brand-700 disabled:opacity-40 transition-colors"
          >
            <Download size={15} />
            Export CSV
          </button>
        </div>
      </div>

      {/* Filters */}
      <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-4 mb-6">
        <div className="flex items-center gap-2 mb-3 text-sm font-medium text-gray-600">
          <Filter size={15} />
          Filter
        </div>
        <div className="flex flex-wrap gap-3">
          <input
            type="text"
            placeholder="Search player, order #, jersey…"
            value={filterSearch}
            onChange={(e) => setFilterSearch(e.target.value)}
            className="border border-gray-300 rounded-lg px-3 py-2 text-sm flex-1 min-w-48 focus:outline-none focus:ring-2 focus:ring-brand-400"
          />
          <select
            value={filterClub}
            onChange={(e) => setFilterClub(e.target.value)}
            className="border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-400"
          >
            <option value="">All Clubs</option>
            {clubs.map((c) => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
          </select>
          <select
            value={filterSeason}
            onChange={(e) => setFilterSeason(e.target.value)}
            className="border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-400"
          >
            <option value="">All Seasons</option>
            {seasons.map((y) => (
              <option key={y} value={String(y)}>{y}</option>
            ))}
          </select>
          <select
            value={filterProductType}
            onChange={(e) => setFilterProductType(e.target.value)}
            className="border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-400"
          >
            <option value="">All Product Types</option>
            {productTypes.map((pt) => (
              <option key={pt} value={pt}>{pt}</option>
            ))}
          </select>
          {(filterClub || filterSeason || filterSearch || filterProductType) && (
            <button
              onClick={() => { setFilterClub(""); setFilterSeason(""); setFilterSearch(""); setFilterProductType(""); }}
              className="text-sm text-gray-500 hover:text-gray-700 px-2"
            >
              Clear filters
            </button>
          )}
        </div>
      </div>

      {/* Summary bar */}
      <div className="flex gap-4 mb-4">
        <div className="bg-white rounded-lg border border-gray-200 px-4 py-3 text-center min-w-24">
          <div className="text-2xl font-bold text-brand-600">{filtered.length}</div>
          <div className="text-xs text-gray-500 mt-0.5">
            {filtered.length === sales.length ? "Total sales" : "Matching sales"}
          </div>
        </div>
      </div>

      {/* Table */}
      <div className="bg-white rounded-xl shadow-sm border border-gray-200 overflow-hidden">
        {loading ? (
          <div className="p-12 text-center text-gray-400">Loading sales…</div>
        ) : error ? (
          <div className="p-12 text-center text-red-500">{error}</div>
        ) : filtered.length === 0 ? (
          <div className="p-12 text-center text-gray-400">
            {sales.length === 0
              ? "No sales recorded yet. Sales will appear here after the first Shopify order comes through."
              : "No sales match the current filters."}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-200 bg-gray-50 text-left">
                  <th className="px-4 py-3 font-medium text-gray-600">Order #</th>
                  <th className="px-4 py-3 font-medium text-gray-600">Date (AEST)</th>
                  <th className="px-4 py-3 font-medium text-gray-600">Club</th>
                  <th className="px-4 py-3 font-medium text-gray-600">Player</th>
                  <th className="px-4 py-3 font-medium text-gray-600 text-center">Jersey #</th>
                  <th className="px-4 py-3 font-medium text-gray-600">Size</th>
                  <th className="px-4 py-3 font-medium text-gray-600">Product Type</th>
                  <th className="px-4 py-3 font-medium text-gray-600 text-center">Season</th>
                  <th className="px-4 py-3 font-medium text-gray-600">Shopify Buyer</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {filtered.map((s) => {
                  const clubName =
                    clubMap[s.club_id ?? ""] ?? s.product_name ?? s.club_id ?? "—";
                  const jerseyNum = s.jersey_number ?? (s.number ? Number(s.number) : null);
                  return (
                    <tr key={s.id} className="hover:bg-gray-50 transition-colors">
                      <td className="px-4 py-3 font-mono text-brand-700 font-medium">
                        {s.order_number ?? s.shopify_order_id ?? "—"}
                      </td>
                      <td className="px-4 py-3 text-gray-600 whitespace-nowrap">
                        {formatDate(s.purchased_at ?? s.order_date)}
                      </td>
                      <td className="px-4 py-3 text-gray-800">{clubName}</td>
                      <td className="px-4 py-3 text-gray-800">
                        {s.player_first_name || s.player_last_name
                          ? `${s.player_first_name ?? ""} ${s.player_last_name ?? ""}`.trim()
                          : s.player_name || <span className="text-gray-400">—</span>}
                      </td>
                      <td className="px-4 py-3 text-center">
                        {jerseyNum != null ? (
                          <span className="inline-block bg-brand-100 text-brand-700 font-bold rounded-full px-3 py-1 text-sm">
                            #{jerseyNum}
                          </span>
                        ) : (
                          <span className="text-gray-400">—</span>
                        )}
                      </td>
                      <td className="px-4 py-3 text-gray-600">{s.size ?? "—"}</td>
                      <td className="px-4 py-3 text-gray-600">{s.product_type ?? "default"}</td>
                      <td className="px-4 py-3 text-center text-gray-600">
                        {s.season_year ?? "—"}
                      </td>
                      <td className="px-4 py-3 text-gray-500 text-xs">
                        {s.shopify_buyer_name || <span className="text-gray-300">—</span>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
};

export default SalesHistory;
