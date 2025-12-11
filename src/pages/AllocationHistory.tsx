// FILE: src/pages/AllocationHistory.tsx
import React, { useEffect, useState } from "react";
import { supabase } from "../services/supabase";

type AllocationType = "new" | "swap" | "end" | "return";

interface Club {
  id: string;
  name: string;
  is_client: boolean;
}

interface AllocationRow {
  id: string;
  allocation_type: AllocationType;
  jersey_number: number | null;
  size: string | null;
  previous_jersey_number: number | null;
  previous_size: string | null;
  note: string | null;
  created_at: string;
  club?: {
    name: string | null;
  } | null;
  player?: {
    first_name: string | null;
    last_name: string | null;
  } | null;
}

const typeLabels: Record<AllocationType, string> = {
  new: "New Allocation",
  swap: "Swap",
  end: "End Allocation",
  return: "Return to Stock",
};

const badgeColors: Record<AllocationType, string> = {
  new: "bg-green-100 text-green-800 border-green-200",
  swap: "bg-blue-100 text-blue-800 border-blue-200",
  end: "bg-yellow-100 text-yellow-800 border-yellow-200",
  return: "bg-purple-100 text-purple-800 border-purple-200",
};

const AllocationHistory: React.FC = () => {
  const [clubs, setClubs] = useState<Club[]>([]);
  const [selectedClubId, setSelectedClubId] = useState<string>("");
  const [selectedTypes, setSelectedTypes] = useState<AllocationType[]>([
    "new",
    "swap",
    "end",
    "return",
  ]);
  const [rows, setRows] = useState<AllocationRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Load client clubs for filter
  useEffect(() => {
    const loadClubs = async () => {
      setError(null);
      const { data, error } = await supabase
        .from("clubs")
        .select("id, name, is_client")
        .eq("is_client", true)
        .order("name", { ascending: true });

      if (error) {
        console.error("AllocationHistory loadClubs error", error);
        setError("Failed to load clubs.");
        return;
      }

      const list = (data ?? []) as Club[];
      setClubs(list);

      if (list.length > 0) {
        setSelectedClubId(list[0].id);
      }
    };

    loadClubs();
  }, []);

  // Load allocation rows when club / filters change
  useEffect(() => {
    const loadHistory = async () => {
      if (!selectedClubId) return;

      setLoading(true);
      setError(null);
      setRows([]);

      try {
        let query = supabase
          .from("allocations")
          .select(
            `
            id,
            allocation_type,
            jersey_number,
            size,
            previous_jersey_number,
            previous_size,
            note,
            created_at,
            club:clubs(name),
            player:players(first_name,last_name)
          `
          )
          .eq("club_id", selectedClubId)
          .order("created_at", { ascending: false })
          .limit(300); // keep it light for UI

        if (selectedTypes.length > 0 && selectedTypes.length < 4) {
          query = query.in("allocation_type", selectedTypes);
        }

        const { data, error } = await query;

        if (error) {
          console.error("AllocationHistory loadHistory error", error);
          setError("Failed to load allocation history.");
          return;
        }

        setRows((data ?? []) as AllocationRow[]);
      } finally {
        setLoading(false);
      }
    };

    void loadHistory();
  }, [selectedClubId, selectedTypes]);

  const toggleType = (type: AllocationType) => {
    setSelectedTypes((prev) =>
      prev.includes(type) ? prev.filter((t) => t !== type) : [...prev, type]
    );
  };

  return (
    <div>
      <h1 className="text-2xl font-bold mb-4">Allocation History</h1>
      <p className="text-sm text-gray-600 mb-6">
        Audit trail of jersey allocations, swaps, ends, and warehouse returns.
        Use this to answer &quot;who had which number when&quot; for each club.
      </p>

      {/* Filters */}
      <div className="flex flex-col md:flex-row md:items-end md:space-x-6 space-y-4 md:space-y-0 mb-6">
        <div>
          <label className="block text-xs font-semibold text-gray-700 mb-1 uppercase tracking-wide">
            Club
          </label>
          <select
            value={selectedClubId}
            onChange={(e) => setSelectedClubId(e.target.value)}
            className="border rounded px-3 py-2 min-w-[220px]"
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

        <div>
          <div className="block text-xs font-semibold text-gray-700 mb-1 uppercase tracking-wide">
            Event Types
          </div>
          <div className="flex flex-wrap gap-2">
            {(Object.keys(typeLabels) as AllocationType[]).map((type) => {
              const active = selectedTypes.includes(type);
              return (
                <button
                  key={type}
                  type="button"
                  onClick={() => toggleType(type)}
                  className={`text-xs px-3 py-1 rounded-full border transition ${
                    active
                      ? "bg-indigo-600 text-white border-indigo-600"
                      : "bg-white text-gray-700 border-gray-300 hover:bg-gray-50"
                  }`}
                >
                  {typeLabels[type]}
                </button>
              );
            })}
          </div>
        </div>
      </div>

      {/* Error */}
      {error && (
        <div className="mb-4 text-sm text-red-700 bg-red-50 border border-red-200 rounded p-3">
          {error}
        </div>
      )}

      {/* Loading */}
      {loading && (
        <div className="mb-4 text-sm text-gray-600">Loading events…</div>
      )}

      {/* Table */}
      {!loading && rows.length === 0 && (
        <div className="text-sm text-gray-500">
          No allocation events found for this club with the current filters.
        </div>
      )}

      {!loading && rows.length > 0 && (
        <div className="overflow-x-auto bg-white rounded-lg shadow">
          <table className="min-w-full text-xs">
            <thead className="bg-gray-100">
              <tr>
                <th className="px-3 py-2 text-left">Time</th>
                <th className="px-3 py-2 text-left">Type</th>
                <th className="px-3 py-2 text-left">Player</th>
                <th className="px-3 py-2 text-left">Club</th>
                <th className="px-3 py-2 text-left">New # / Size</th>
                <th className="px-3 py-2 text-left">Prev # / Size</th>
                <th className="px-3 py-2 text-left">Note</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const playerName = row.player
                  ? `${row.player.first_name ?? ""} ${
                      row.player.last_name ?? ""
                    }`.trim()
                  : "";
                const clubName = row.club?.name ?? "";
                const created = new Date(row.created_at);
                const timeString = created.toLocaleString();

                return (
                  <tr
                    key={row.id}
                    className="border-t border-gray-100 odd:bg-white even:bg-gray-50"
                  >
                    <td className="px-3 py-2 align-top whitespace-nowrap">
                      {timeString}
                    </td>
                    <td className="px-3 py-2 align-top">
                      <span
                        className={`inline-flex items-center px-2 py-0.5 rounded-full text-[11px] border ${badgeColors[row.allocation_type]}`}
                      >
                        {typeLabels[row.allocation_type]}
                      </span>
                    </td>
                    <td className="px-3 py-2 align-top">
                      {playerName || <span className="text-gray-400">—</span>}
                    </td>
                    <td className="px-3 py-2 align-top">
                      {clubName || <span className="text-gray-400">—</span>}
                    </td>
                    <td className="px-3 py-2 align-top">
                      {row.jersey_number != null ? (
                        <>
                          #{row.jersey_number}
                          {row.size && (
                            <span className="text-gray-500 ml-1">
                              ({row.size})
                            </span>
                          )}
                        </>
                      ) : (
                        <span className="text-gray-400">—</span>
                      )}
                    </td>
                    <td className="px-3 py-2 align-top">
                      {row.previous_jersey_number != null ? (
                        <>
                          #{row.previous_jersey_number}
                          {row.previous_size && (
                            <span className="text-gray-500 ml-1">
                              ({row.previous_size})
                            </span>
                          )}
                        </>
                      ) : (
                        <span className="text-gray-400">—</span>
                      )}
                    </td>
                    <td className="px-3 py-2 align-top max-w-xs">
                      {row.note ? (
                        <span className="text-gray-700">{row.note}</span>
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

export default AllocationHistory;
