// FILE: src/pages/Players.tsx
import React, { useEffect, useMemo, useState } from "react";
import { supabase } from "../services/supabase";

interface Club {
  id: string;
  name: string;
  is_client: boolean;
}

interface PlayerRow {
  id: string;
  first_name: string;
  last_name: string;
  team_id: string | null;
  club_id: string;
  final_shirt: number | null;
  year_of_birth: number | null;
}

type StatusFilter = "all" | "with-number" | "missing-number" | "missing-yob";

const Players: React.FC = () => {
  const [clubs, setClubs] = useState<Club[]>([]);
  const [selectedClubId, setSelectedClubId] = useState<string>("");

  const [players, setPlayers] = useState<PlayerRow[]>([]);
  const [loadingClubs, setLoadingClubs] = useState(false);
  const [loadingPlayers, setLoadingPlayers] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [search, setSearch] = useState<string>("");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [teamFilter, setTeamFilter] = useState<string>("all");

  // Inline YOB edit state
  const [editingYobId, setEditingYobId] = useState<string | null>(null);
  const [editingYobValue, setEditingYobValue] = useState<string>("");
  const [savingYobId, setSavingYobId] = useState<string | null>(null);

  // Load clubs
  useEffect(() => {
    const loadClubs = async () => {
      setLoadingClubs(true);
      setError(null);
      try {
        const { data, error } = await supabase
          .from("clubs")
          .select("id, name, is_client")
          .eq("is_client", true)
          .order("name", { ascending: true });

        if (error) {
          console.error("Players loadClubs error", error);
          setError("Failed to load clubs.");
          return;
        }

        const list = (data ?? []) as Club[];
        setClubs(list);
        if (list.length > 0) {
          setSelectedClubId(list[0].id);
        }
      } finally {
        setLoadingClubs(false);
      }
    };

    loadClubs();
  }, []);

  // Load players for the selected club
  useEffect(() => {
    const loadPlayers = async () => {
      if (!selectedClubId) {
        setPlayers([]);
        return;
      }

      setLoadingPlayers(true);
      setError(null);

      try {
        const { data, error } = await supabase
          .from("players")
          .select(
            "id, first_name, last_name, team_id, club_id, final_shirt, year_of_birth"
          )
          .eq("club_id", selectedClubId)
          .order("last_name", { ascending: true })
          .order("first_name", { ascending: true });

        if (error) {
          console.error("Players loadPlayers error", error);
          setError("Failed to load players for this club.");
          return;
        }

        setPlayers((data ?? []) as PlayerRow[]);
      } finally {
        setLoadingPlayers(false);
      }
    };

    loadPlayers();
  }, [selectedClubId]);

  // Distinct teams for dropdown
  const teamsForClub = useMemo(() => {
    const set = new Set<string>();
    players.forEach((p) => {
      if (p.team_id) set.add(p.team_id);
    });
    return Array.from(set).sort();
  }, [players]);

  const handleResetFilters = () => {
    setSearch("");
    setStatusFilter("all");
    setTeamFilter("all");
  };

  // Filtered players
  const filteredPlayers = useMemo(() => {
    let list = [...players];

    // Team filter
    if (teamFilter !== "all") {
      list = list.filter((p) => p.team_id === teamFilter);
    }

    // Status filter
    if (statusFilter === "with-number") {
      list = list.filter((p) => p.final_shirt != null);
    } else if (statusFilter === "missing-number") {
      list = list.filter((p) => p.final_shirt == null);
    } else if (statusFilter === "missing-yob") {
      list = list.filter((p) => p.year_of_birth == null);
    }

    // Search by name or number ONLY (no team search)
    if (search.trim().length > 0) {
      const q = search.trim().toLowerCase();
      list = list.filter((p) => {
        const fullName = `${p.first_name ?? ""} ${p.last_name ?? ""}`
          .toLowerCase()
          .trim();

        const nameMatch = fullName.includes(q);
        let numberMatch = false;
        if (p.final_shirt != null) {
          numberMatch = String(p.final_shirt).includes(q);
        }

        return nameMatch || numberMatch;
      });
    }

    return list;
  }, [players, search, statusFilter, teamFilter]);

  const selectedClubName =
    clubs.find((c) => c.id === selectedClubId)?.name ?? "";

  const startEditYob = (p: PlayerRow) => {
    setEditingYobId(p.id);
    setEditingYobValue(p.year_of_birth != null ? String(p.year_of_birth) : "");
  };

  const cancelEditYob = () => {
    setEditingYobId(null);
    setEditingYobValue("");
  };

  const saveYob = async (playerId: string) => {
    const parsed = Number(editingYobValue.trim());
    if (!editingYobValue.trim() || !Number.isFinite(parsed) || parsed < 1990 || parsed > 2025) {
      alert("Please enter a valid year between 1990 and 2025.");
      return;
    }

    setSavingYobId(playerId);
    const { error } = await supabase
      .from("players")
      .update({ year_of_birth: parsed })
      .eq("id", playerId);

    if (error) {
      console.error("saveYob error", error);
      alert("Failed to save year of birth: " + error.message);
      setSavingYobId(null);
      return;
    }

    setPlayers((prev) =>
      prev.map((p) => (p.id === playerId ? { ...p, year_of_birth: parsed } : p))
    );
    setEditingYobId(null);
    setEditingYobValue("");
    setSavingYobId(null);
  };

  return (
    <div>
      <h1 className="text-2xl font-bold mb-4">Players</h1>
      <p className="text-sm text-gray-600 mb-6">
        Browse and filter players by club, team, number status and year of
        birth. Use this for quick data sanity checks before running allocations.
      </p>

      {/* Filters */}
      <div className="space-y-4 mb-6">
        {/* Top row: club + team */}
        <div className="flex flex-col md:flex-row md:items-end md:space-x-4 space-y-3 md:space-y-0">
          <div>
            <label className="block text-xs font-semibold text-gray-700 mb-1 uppercase tracking-wide">
              Club
            </label>
            <select
              value={selectedClubId}
              onChange={(e) => {
                setSelectedClubId(e.target.value);
                handleResetFilters();
              }}
              className="border rounded px-3 py-2 min-w-[220px]"
              disabled={loadingClubs}
            >
              {loadingClubs && <option>Loading clubs…</option>}
              {!loadingClubs && clubs.length === 0 && (
                <option value="">No client clubs found</option>
              )}
              {!loadingClubs &&
                clubs.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
            </select>
          </div>

          <div>
            <label className="block text-xs font-semibold text-gray-700 mb-1 uppercase tracking-wide">
              Team
            </label>
            <select
              value={teamFilter}
              onChange={(e) => setTeamFilter(e.target.value)}
              className="border rounded px-3 py-2 min-w-[160px]"
            >
              <option value="all">All teams</option>
              {teamsForClub.map((teamId) => (
                <option key={teamId} value={teamId}>
                  {teamId}
                </option>
              ))}
            </select>
          </div>

          <div className="flex-1">
            <label className="block text-xs font-semibold text-gray-700 mb-1 uppercase tracking-wide">
              Search (name or number)
            </label>
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="e.g. Bella or 12"
              className="border rounded px-3 py-2 w-full"
            />
          </div>

          <div className="flex items-center">
            <button
              type="button"
              onClick={handleResetFilters}
              className="px-3 py-2 text-xs border rounded bg-gray-50 hover:bg-gray-100"
            >
              Clear Filters
            </button>
          </div>
        </div>

        {/* Status filter row */}
        <div>
          <div className="block text-xs font-semibold text-gray-700 mb-1 uppercase tracking-wide">
            Status
          </div>
          <div className="flex flex-wrap gap-2">
            {(
              [
                ["all", "All players"],
                ["with-number", "Has number"],
                ["missing-number", "Missing number"],
                ["missing-yob", "Missing YOB"],
              ] as [StatusFilter, string][]
            ).map(([value, label]) => {
              const active = statusFilter === value;
              return (
                <button
                  key={value}
                  type="button"
                  onClick={() => setStatusFilter(value)}
                  className={`text-xs px-3 py-1 rounded-full border transition ${
                    active
                      ? "bg-indigo-600 text-white border-indigo-600"
                      : "bg-white text-gray-700 border-gray-300 hover:bg-gray-50"
                  }`}
                >
                  {label}
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

      {/* Table */}
      <div className="mb-2 text-xs text-gray-600">
        Showing{" "}
        <span className="font-semibold">{filteredPlayers.length}</span> of{" "}
        <span className="font-semibold">{players.length}</span> players for{" "}
        <span className="font-semibold">
          {selectedClubName || "selected club"}
        </span>
        .
      </div>

      {loadingPlayers && (
        <div className="text-sm text-gray-500 mb-4">Loading players…</div>
      )}

      {!loadingPlayers && filteredPlayers.length === 0 && (
        <div className="text-sm text-gray-500">
          No players match the current filters.
        </div>
      )}

      {!loadingPlayers && filteredPlayers.length > 0 && (
        <div className="overflow-x-auto bg-white rounded-lg shadow">
          <table className="min-w-full text-xs">
            <thead className="bg-gray-100">
              <tr>
                <th className="px-3 py-2 text-left">Last Name</th>
                <th className="px-3 py-2 text-left">First Name</th>
                <th className="px-3 py-2 text-left">Team</th>
                <th className="px-3 py-2 text-left">Number</th>
                <th className="px-3 py-2 text-left">Year of Birth</th>
                <th className="px-3 py-2 text-left">Edit YOB</th>
              </tr>
            </thead>
            <tbody>
              {filteredPlayers.map((p) => {
                const isEditingYob = editingYobId === p.id;
                const isSavingYob = savingYobId === p.id;

                return (
                  <tr
                    key={p.id}
                    className="border-t border-gray-100 odd:bg-white even:bg-gray-50"
                  >
                    <td className="px-3 py-2 align-middle">
                      {p.last_name || <span className="text-gray-400">—</span>}
                    </td>
                    <td className="px-3 py-2 align-middle">
                      {p.first_name || <span className="text-gray-400">—</span>}
                    </td>
                    <td className="px-3 py-2 align-middle">
                      {p.team_id || <span className="text-gray-400">—</span>}
                    </td>
                    <td className="px-3 py-2 align-middle">
                      {p.final_shirt != null ? (
                        <span className="font-semibold">#{p.final_shirt}</span>
                      ) : (
                        <span className="text-red-500 font-medium">Missing</span>
                      )}
                    </td>
                    <td className="px-3 py-2 align-middle">
                      {p.year_of_birth != null ? (
                        <span>{p.year_of_birth}</span>
                      ) : (
                        <span className="text-orange-600 font-medium">Missing</span>
                      )}
                    </td>
                    <td className="px-3 py-2 align-middle">
                      {isEditingYob ? (
                        <div className="flex items-center gap-1">
                          <input
                            type="number"
                            value={editingYobValue}
                            onChange={(e) => setEditingYobValue(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === "Enter") void saveYob(p.id);
                              if (e.key === "Escape") cancelEditYob();
                            }}
                            className="w-20 border rounded px-1 py-0.5 text-xs"
                            placeholder="e.g. 2012"
                            autoFocus
                          />
                          <button
                            type="button"
                            onClick={() => void saveYob(p.id)}
                            disabled={isSavingYob}
                            className="px-2 py-0.5 rounded bg-emerald-600 text-white text-xs disabled:bg-gray-400"
                          >
                            {isSavingYob ? "…" : "Save"}
                          </button>
                          <button
                            type="button"
                            onClick={cancelEditYob}
                            disabled={isSavingYob}
                            className="px-2 py-0.5 rounded bg-gray-200 text-gray-700 text-xs"
                          >
                            ✕
                          </button>
                        </div>
                      ) : (
                        <button
                          type="button"
                          onClick={() => startEditYob(p)}
                          className="text-indigo-600 hover:text-indigo-800 text-xs"
                        >
                          {p.year_of_birth != null ? "Edit" : "Add YOB"}
                        </button>
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

export default Players;
