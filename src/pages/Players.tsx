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
  club_id: string | null;
  final_shirt: number | null;
  year_of_birth: number | null;
}

const Players: React.FC = () => {
  const [clubs, setClubs] = useState<Club[]>([]);
  const [players, setPlayers] = useState<PlayerRow[]>([]);

  const [loadingClubs, setLoadingClubs] = useState(false);
  const [loadingPlayers, setLoadingPlayers] = useState(false);

  const [clubFilter, setClubFilter] = useState<string>("");
  const [teamFilter, setTeamFilter] = useState<string>("");
  const [searchTerm, setSearchTerm] = useState<string>("");

  const [savingYobId, setSavingYobId] = useState<string | null>(null);

  const [error, setError] = useState<string | null>(null);
  const [statusMessage, setStatusMessage] = useState<string>("");

  // Load clubs
  useEffect(() => {
    const loadClubs = async () => {
      setLoadingClubs(true);
      setError(null);
      try {
        const { data, error } = await supabase
          .from("clubs")
          .select("id, name, is_client")
          .order("name", { ascending: true });

        if (error) {
          console.error("Players loadClubs error", error);
          setError("Failed to load clubs.");
          return;
        }

        setClubs((data ?? []) as Club[]);
      } finally {
        setLoadingClubs(false);
      }
    };

    loadClubs();
  }, []);

  // Load players
  useEffect(() => {
    const loadPlayers = async () => {
      setLoadingPlayers(true);
      setError(null);
      try {
        const { data, error } = await supabase
          .from("players")
          .select(
            "id, first_name, last_name, team_id, club_id, final_shirt, year_of_birth"
          )
          .order("last_name", { ascending: true })
          .order("first_name", { ascending: true });

        if (error) {
          console.error("Players loadPlayers error", error);
          setError("Failed to load players.");
          return;
        }

        setPlayers((data ?? []) as PlayerRow[]);
      } finally {
        setLoadingPlayers(false);
      }
    };

    loadPlayers();
  }, []);

  const clearFilters = () => {
    setClubFilter("");
    setTeamFilter("");
    setSearchTerm("");
  };

  const clubNameFor = (clubId: string | null): string => {
    if (!clubId) return "—";
    const club = clubs.find((c) => c.id === clubId);
    return club?.name ?? "Unknown";
  };

  // Build team options (simple list from all players)
  const teamOptions = useMemo(() => {
    const set = new Set<string>();
    players.forEach((p) => {
      if (p.team_id) set.add(p.team_id);
    });
    return Array.from(set).sort();
  }, [players]);

  // Filter + search players
  const filteredPlayers = useMemo(() => {
    const term = searchTerm.trim().toLowerCase();
    const numericSearch = Number(term);
    const hasNumericSearch = !Number.isNaN(numericSearch) && term !== "";

    return players.filter((p) => {
      if (clubFilter && p.club_id !== clubFilter) return false;
      if (teamFilter && p.team_id !== teamFilter) return false;

      if (!term) return true;

      const fullName = `${p.first_name} ${p.last_name}`.toLowerCase();
      const matchesName = fullName.includes(term);
      const matchesNumber =
        hasNumericSearch && p.final_shirt === numericSearch;

      // IMPORTANT: we do NOT search team name here (only name + number)
      return matchesName || matchesNumber;
    });
  }, [players, clubFilter, teamFilter, searchTerm]);

  const handleSaveYearOfBirth = async (player: PlayerRow, rawValue: string) => {
    const trimmed = rawValue.trim();

    // If unchanged, do nothing
    const current = player.year_of_birth;
    if (!trimmed && current == null) return;

    // Empty input → clear the year_of_birth
    if (!trimmed) {
      try {
        setSavingYobId(player.id);
        const { error } = await supabase
          .from("players")
          .update({ year_of_birth: null })
          .eq("id", player.id);

        if (error) {
          console.error("Failed to clear year_of_birth", error);
          setError("Failed to clear Year of Birth.");
          return;
        }

        setPlayers((prev) =>
          prev.map((p) =>
            p.id === player.id ? { ...p, year_of_birth: null } : p
          )
        );
        setStatusMessage("Year of Birth cleared.");
      } finally {
        setSavingYobId(null);
      }
      return;
    }

    // Parse numeric
    const parsed = Number(trimmed);
    if (!Number.isFinite(parsed) || parsed < 1900 || parsed > 2100) {
      setError("Please enter a valid Year of Birth (e.g. 2012).");
      return;
    }

    if (current === parsed) {
      // No change
      return;
    }

    try {
      setSavingYobId(player.id);
      setError(null);
      const { error } = await supabase
        .from("players")
        .update({ year_of_birth: parsed })
        .eq("id", player.id);

      if (error) {
        console.error("Failed to update year_of_birth", error);
        setError("Failed to update Year of Birth.");
        return;
      }

      setPlayers((prev) =>
        prev.map((p) =>
          p.id === player.id ? { ...p, year_of_birth: parsed } : p
        )
      );
      setStatusMessage("Year of Birth updated.");
    } finally {
      setSavingYobId(null);
    }
  };

  return (
    <div>
      <h1 className="text-2xl font-bold mb-4">Players</h1>
      <p className="text-sm text-gray-600 mb-4">
        View and filter players across all clubs. Use the Year of Birth column
        to gradually enrich data for cohort-aware clash checks.
      </p>

      {/* Filters */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4 mb-4">
        <div>
          <label className="block text-sm font-semibold mb-1">Club</label>
          <select
            value={clubFilter}
            onChange={(e) => setClubFilter(e.target.value)}
            className="w-full border p-2 rounded"
          >
            <option value="">All clubs</option>
            {clubs.map((club) => (
              <option key={club.id} value={club.id}>
                {club.name}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label className="block text-sm font-semibold mb-1">Team</label>
          <select
            value={teamFilter}
            onChange={(e) => setTeamFilter(e.target.value)}
            className="w-full border p-2 rounded"
          >
            <option value="">All teams</option>
            {teamOptions.map((team) => (
              <option key={team} value={team}>
                {team}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label className="block text-sm font-semibold mb-1">
            Search (Name or Number)
          </label>
          <input
            type="text"
            value={searchTerm}
            placeholder="e.g. Xavier or 12"
            onChange={(e) => setSearchTerm(e.target.value)}
            className="w-full border p-2 rounded"
          />
        </div>

        <div className="flex items-end">
          <button
            type="button"
            onClick={clearFilters}
            className="w-full px-3 py-2 border border-gray-300 rounded text-sm bg-white hover:bg-gray-50"
          >
            Clear Filters
          </button>
        </div>
      </div>

      {/* Status + errors */}
      {error && (
        <div className="mb-3 text-sm text-red-700 bg-red-50 border border-red-200 rounded p-3">
          {error}
        </div>
      )}
      {statusMessage && (
        <div className="mb-3 text-sm text-emerald-800 bg-emerald-50 border border-emerald-200 rounded p-3">
          {statusMessage}
        </div>
      )}

      {/* Loading states */}
      {(loadingClubs || loadingPlayers) && (
        <p className="text-sm text-gray-500 mb-3">Loading data…</p>
      )}

      {/* Table */}
      <div className="overflow-x-auto border rounded">
        <table className="min-w-full text-xs">
          <thead className="bg-gray-100">
            <tr>
              <th className="px-2 py-1 text-left">First Name</th>
              <th className="px-2 py-1 text-left">Last Name</th>
              <th className="px-2 py-1 text-left">Club</th>
              <th className="px-2 py-1 text-left">Team</th>
              <th className="px-2 py-1 text-left">Number</th>
              <th className="px-2 py-1 text-left">Year of Birth</th>
            </tr>
          </thead>
          <tbody>
            {filteredPlayers.map((p, idx) => (
              <tr
                key={p.id}
                className={idx % 2 === 0 ? "bg-white" : "bg-gray-50"}
              >
                <td className="px-2 py-1">{p.first_name}</td>
                <td className="px-2 py-1">{p.last_name}</td>
                <td className="px-2 py-1">{clubNameFor(p.club_id)}</td>
                <td className="px-2 py-1">{p.team_id ?? "—"}</td>
                <td className="px-2 py-1">
                  {p.final_shirt != null ? p.final_shirt : "—"}
                </td>
                <td className="px-2 py-1">
                  <input
                    type="number"
                    defaultValue={p.year_of_birth ?? ""}
                    onBlur={(e) =>
                      handleSaveYearOfBirth(p, e.target.value)
                    }
                    className="w-24 border rounded px-1 py-0.5 text-xs"
                    placeholder="e.g. 2012"
                    disabled={savingYobId === p.id}
                  />
                  {savingYobId === p.id && (
                    <span className="ml-1 text-[10px] text-gray-500">
                      saving…
                    </span>
                  )}
                </td>
              </tr>
            ))}
            {filteredPlayers.length === 0 && !loadingPlayers && (
              <tr>
                <td
                  colSpan={6}
                  className="px-2 py-3 text-center text-gray-500"
                >
                  No players found with current filters.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
};

export default Players;
