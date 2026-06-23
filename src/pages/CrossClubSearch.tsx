// FILE: src/pages/CrossClubSearch.tsx
import React, { useEffect, useMemo, useState } from "react";
import { supabase } from "../services/supabase";
import { Search, Users, ShoppingBag } from "lucide-react";
import { SkeletonTable } from "../components/ui/Skeleton";
import EmptyState from "../components/ui/EmptyState";

interface Club {
  id: string;
  name: string;
}

interface PlayerResult {
  id: string;
  first_name: string;
  last_name: string;
  club_id: string;
  team_name: string | null;
  division_code: string | null;
  final_shirt: number | null;
  year_of_birth: number | null;
  deleted_at: string | null;
}

interface OrderResult {
  id: string;
  player_name: string | null;
  club_id: string | null;
  order_number: string | null;
  jersey_number: number | null;
  size: string | null;
  product_name: string | null;
  purchased_at: string | null;
  shopify_order_id: string | null;
}

const CrossClubSearch: React.FC = () => {
  const [clubs, setClubs] = useState<Club[]>([]);
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [players, setPlayers] = useState<PlayerResult[]>([]);
  const [orders, setOrders] = useState<OrderResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [searched, setSearched] = useState(false);

  // Load all clubs once, for name lookups
  useEffect(() => {
    const loadClubs = async () => {
      const { data } = await supabase.from("clubs").select("id, name").order("name");
      setClubs((data ?? []) as Club[]);
    };
    void loadClubs();
  }, []);

  const clubMap = useMemo(() => {
    const map: Record<string, string> = {};
    clubs.forEach((c) => (map[c.id] = c.name));
    return map;
  }, [clubs]);

  // Debounce typing
  useEffect(() => {
    const t = setTimeout(() => setDebouncedQuery(query.trim()), 350);
    return () => clearTimeout(t);
  }, [query]);

  useEffect(() => {
    const run = async () => {
      if (debouncedQuery.length < 2) {
        setPlayers([]);
        setOrders([]);
        setSearched(false);
        return;
      }

      setLoading(true);
      setError(null);
      setSearched(true);

      const q = debouncedQuery;
      const asNumber = Number(q);
      const isNumeric = q !== "" && Number.isFinite(asNumber);

      try {
        let playerQuery = supabase
          .from("players")
          .select(
            "id, first_name, last_name, club_id, team_name, division_code, final_shirt, year_of_birth, deleted_at"
          )
          .limit(50);

        if (isNumeric) {
          playerQuery = playerQuery.or(
            `final_shirt.eq.${asNumber},first_name.ilike.%${q}%,last_name.ilike.%${q}%`
          );
        } else {
          playerQuery = playerQuery.or(
            `first_name.ilike.%${q}%,last_name.ilike.%${q}%`
          );
        }

        let orderQuery = supabase
          .from("orders")
          .select(
            "id, player_name, club_id, order_number, jersey_number, size, product_name, purchased_at, shopify_order_id"
          )
          .order("purchased_at", { ascending: false })
          .limit(50);

        if (isNumeric) {
          orderQuery = orderQuery.or(
            `jersey_number.eq.${asNumber},player_name.ilike.%${q}%,order_number.ilike.%${q}%,shopify_order_id.ilike.%${q}%`
          );
        } else {
          orderQuery = orderQuery.or(
            `player_name.ilike.%${q}%,order_number.ilike.%${q}%,shopify_order_id.ilike.%${q}%`
          );
        }

        const [playersRes, ordersRes] = await Promise.all([playerQuery, orderQuery]);

        if (playersRes.error) {
          console.error("CrossClubSearch players error", playersRes.error);
          setError("Failed to search players.");
        } else {
          setPlayers((playersRes.data ?? []) as PlayerResult[]);
        }

        if (ordersRes.error) {
          console.error("CrossClubSearch orders error", ordersRes.error);
          setError((prev) => prev ?? "Failed to search orders.");
        } else {
          setOrders((ordersRes.data ?? []) as OrderResult[]);
        }
      } finally {
        setLoading(false);
      }
    };

    void run();
  }, [debouncedQuery]);

  return (
    <div>
      <h1 className="text-2xl font-bold mb-4">Cross-Club Search</h1>
      <p className="text-sm text-gray-600 mb-6">
        Search players and orders across every client club at once — by name, jersey
        number, or Shopify order number. Useful when you don't know (or aren't sure)
        which club a player or order belongs to.
      </p>

      <div className="relative mb-6 max-w-xl">
        <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search by name, jersey number, or order number…"
          className="w-full border rounded pl-9 pr-3 py-2"
          autoFocus
        />
      </div>

      {error && (
        <div className="mb-4 text-sm text-red-700 bg-red-50 border border-red-200 rounded p-3">
          {error}
        </div>
      )}

      {!searched && !loading && (
        <p className="text-sm text-gray-400">Type at least 2 characters to search.</p>
      )}

      {loading && <SkeletonTable rows={5} cols={5} />}

      {!loading && searched && (
        <div className="space-y-8">
          {/* Players */}
          <div>
            <h2 className="text-sm font-semibold text-gray-800 mb-2 flex items-center gap-2">
              <Users size={16} className="text-brand-600" />
              Players ({players.length})
            </h2>
            {players.length === 0 ? (
              <EmptyState icon={Users} title="No matching players" description="Try a different name or jersey number." />
            ) : (
              <div className="overflow-x-auto border rounded bg-white">
                <table className="min-w-full text-xs">
                  <thead className="bg-gray-100">
                    <tr>
                      <th className="px-3 py-2 text-left">Name</th>
                      <th className="px-3 py-2 text-left">Club</th>
                      <th className="px-3 py-2 text-left">Team</th>
                      <th className="px-3 py-2 text-left">Number</th>
                      <th className="px-3 py-2 text-left">YOB</th>
                      <th className="px-3 py-2 text-left">Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {players.map((p) => (
                      <tr key={p.id} className="border-t odd:bg-white even:bg-gray-50">
                        <td className="px-3 py-2 font-medium">
                          {p.last_name}, {p.first_name}
                        </td>
                        <td className="px-3 py-2">{clubMap[p.club_id] ?? "—"}</td>
                        <td className="px-3 py-2 text-gray-600">
                          {p.team_name ?? p.division_code ?? "—"}
                        </td>
                        <td className="px-3 py-2">
                          {p.final_shirt != null ? (
                            <span className="font-semibold text-brand-700">#{p.final_shirt}</span>
                          ) : (
                            <span className="text-gray-400">—</span>
                          )}
                        </td>
                        <td className="px-3 py-2">{p.year_of_birth ?? "—"}</td>
                        <td className="px-3 py-2">
                          {p.deleted_at ? (
                            <span className="text-red-500">Deleted</span>
                          ) : (
                            <span className="text-emerald-600">Active</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {/* Orders */}
          <div>
            <h2 className="text-sm font-semibold text-gray-800 mb-2 flex items-center gap-2">
              <ShoppingBag size={16} className="text-brand-600" />
              Orders ({orders.length})
            </h2>
            {orders.length === 0 ? (
              <EmptyState icon={ShoppingBag} title="No matching orders" description="Try a different name or order number." />
            ) : (
              <div className="overflow-x-auto border rounded bg-white">
                <table className="min-w-full text-xs">
                  <thead className="bg-gray-100">
                    <tr>
                      <th className="px-3 py-2 text-left">Order #</th>
                      <th className="px-3 py-2 text-left">Player</th>
                      <th className="px-3 py-2 text-left">Club</th>
                      <th className="px-3 py-2 text-left">Number</th>
                      <th className="px-3 py-2 text-left">Size</th>
                      <th className="px-3 py-2 text-left">Purchased</th>
                    </tr>
                  </thead>
                  <tbody>
                    {orders.map((o) => (
                      <tr key={o.id} className="border-t odd:bg-white even:bg-gray-50">
                        <td className="px-3 py-2 font-medium">{o.order_number ?? "—"}</td>
                        <td className="px-3 py-2">{o.player_name ?? "—"}</td>
                        <td className="px-3 py-2">
                          {(o.club_id && clubMap[o.club_id]) ?? o.product_name ?? "—"}
                        </td>
                        <td className="px-3 py-2">
                          {o.jersey_number != null ? `#${o.jersey_number}` : "—"}
                        </td>
                        <td className="px-3 py-2">{o.size ?? "—"}</td>
                        <td className="px-3 py-2 text-gray-500">
                          {o.purchased_at ? new Date(o.purchased_at).toLocaleDateString() : "—"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
};

export default CrossClubSearch;
