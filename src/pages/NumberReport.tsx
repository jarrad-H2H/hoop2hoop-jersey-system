// FILE: src/pages/NumberReport.tsx
import React, { useEffect, useMemo, useState } from "react";
import * as XLSX from "xlsx";
import { supabase } from "../services/supabase";
import { FileSpreadsheet, FileDown } from "lucide-react";
import { SkeletonTable } from "../components/ui/Skeleton";
import EmptyState from "../components/ui/EmptyState";

interface PlayerRow {
  id: string;
  first_name: string;
  last_name: string;
  club_id: string;
  division_code: string | null;
  team_name: string | null;
  age_group: string | null;
  final_shirt: number | null;
  year_of_birth: number | null;
  competition_source: string | null;
  bc_last_seen_season: number | null;
}

interface Club {
  id: string;
  name: string;
}

/** A team's identity is (division_code, team_name) -- the same convention used
 * everywhere else in this app (allocation.ts, Allocation.tsx) for clash-checking. */
function teamKey(p: { division_code: string | null; team_name: string | null }): string {
  return `${p.division_code ?? ""}::${p.team_name ?? ""}`;
}

function teamLabel(p: { division_code: string | null; team_name: string | null; age_group: string | null }): string {
  const parts = [p.division_code, p.team_name].filter(Boolean);
  if (parts.length > 0) return parts.join(" · ");
  return p.age_group ? `${p.age_group} (no team assigned)` : "No team assigned";
}

const NumberReport: React.FC = () => {
  const currentYear = new Date().getFullYear();

  const [allPlayers, setAllPlayers] = useState<PlayerRow[]>([]);
  const [clubs, setClubs] = useState<Club[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [competition, setCompetition] = useState<string>("");
  const [clubId, setClubId] = useState<string>("");
  const [selectedTeamKeys, setSelectedTeamKeys] = useState<Set<string>>(new Set());
  const [activeOnly, setActiveOnly] = useState(true);

  // Load everything once -- the dataset (players + clubs) is small enough per club/
  // competition that filtering client-side keeps this simple and snappy, consistent
  // with how Players.tsx and Cross-Club Search already work.
  //
  // Supabase/PostgREST caps a single query at 1000 rows by default -- with 4000+
  // active players across competitions, that silently truncated results (an entire
  // competition could go missing from the dropdown depending on row order). Page
  // through in batches of 1000 until everything's fetched.
  useEffect(() => {
    const PAGE_SIZE = 1000;

    const fetchAllPlayers = async (): Promise<PlayerRow[]> => {
      const rows: PlayerRow[] = [];
      let from = 0;
      while (true) {
        const { data, error } = await supabase
          .from("players")
          .select(
            "id, first_name, last_name, club_id, division_code, team_name, age_group, final_shirt, year_of_birth, competition_source, bc_last_seen_season"
          )
          .is("deleted_at", null)
          .range(from, from + PAGE_SIZE - 1);

        if (error) throw error;
        const batch = (data ?? []) as PlayerRow[];
        rows.push(...batch);
        if (batch.length < PAGE_SIZE) break;
        from += PAGE_SIZE;
      }
      return rows;
    };

    const load = async () => {
      setLoading(true);
      setError(null);
      try {
        const [players, clubsRes] = await Promise.all([
          fetchAllPlayers(),
          supabase.from("clubs").select("id, name").order("name"),
        ]);

        if (clubsRes.error) throw clubsRes.error;

        setAllPlayers(players);
        setClubs((clubsRes.data ?? []) as Club[]);
      } catch (err: any) {
        console.error("NumberReport load error", err);
        setError(err.message ?? "Failed to load report data.");
      } finally {
        setLoading(false);
      }
    };
    void load();
  }, []);

  const clubNameById = useMemo(() => {
    const map: Record<string, string> = {};
    clubs.forEach((c) => (map[c.id] = c.name));
    return map;
  }, [clubs]);

  const competitions = useMemo(() => {
    const set = new Set<string>();
    allPlayers.forEach((p) => {
      if (p.competition_source) set.add(p.competition_source);
    });
    return Array.from(set).sort();
  }, [allPlayers]);

  // Reset downstream selections whenever a higher-level filter changes
  useEffect(() => {
    setClubId("");
    setSelectedTeamKeys(new Set());
  }, [competition]);

  useEffect(() => {
    setSelectedTeamKeys(new Set());
  }, [clubId]);

  const isActive = (p: PlayerRow) =>
    p.bc_last_seen_season == null || p.bc_last_seen_season >= currentYear - 2;

  // Players matching Competition (+ optional Club) -- used to populate the club
  // dropdown's available options and the team checkbox list.
  const playersInCompetition = useMemo(() => {
    if (!competition) return [];
    return allPlayers.filter(
      (p) => p.competition_source === competition && (!activeOnly || isActive(p))
    );
  }, [allPlayers, competition, activeOnly, currentYear]);

  const clubsInCompetition = useMemo(() => {
    const ids = new Set(playersInCompetition.map((p) => p.club_id));
    return clubs.filter((c) => ids.has(c.id)).sort((a, b) => a.name.localeCompare(b.name));
  }, [playersInCompetition, clubs]);

  const playersInClub = useMemo(() => {
    if (!clubId) return playersInCompetition;
    return playersInCompetition.filter((p) => p.club_id === clubId);
  }, [playersInCompetition, clubId]);

  const teamOptions = useMemo(() => {
    if (!clubId) return [];
    const map = new Map<string, { key: string; label: string; count: number }>();
    for (const p of playersInClub) {
      const key = teamKey(p);
      if (!map.has(key)) map.set(key, { key, label: teamLabel(p), count: 0 });
      map.get(key)!.count += 1;
    }
    return Array.from(map.values()).sort((a, b) => a.label.localeCompare(b.label));
  }, [playersInClub]);

  const toggleTeam = (key: string) => {
    setSelectedTeamKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  // Final report rows: Competition -> (Club) -> (Team selection) -> sorted by
  // club, then team, then jersey number (nulls last), then last name.
  const reportRows = useMemo(() => {
    let rows = clubId ? playersInClub : playersInCompetition;
    if (clubId && selectedTeamKeys.size > 0) {
      rows = rows.filter((p) => selectedTeamKeys.has(teamKey(p)));
    }

    return [...rows].sort((a, b) => {
      const clubCmp = (clubNameById[a.club_id] ?? "").localeCompare(clubNameById[b.club_id] ?? "");
      if (clubCmp !== 0) return clubCmp;
      const teamCmp = teamLabel(a).localeCompare(teamLabel(b));
      if (teamCmp !== 0) return teamCmp;
      const an = a.final_shirt;
      const bn = b.final_shirt;
      if (an == null && bn == null) return a.last_name.localeCompare(b.last_name);
      if (an == null) return 1;
      if (bn == null) return -1;
      if (an !== bn) return an - bn;
      return a.last_name.localeCompare(b.last_name);
    });
  }, [playersInCompetition, playersInClub, clubId, selectedTeamKeys, clubNameById]);

  const exportRows = useMemo(
    () =>
      reportRows.map((p) => ({
        Club: clubNameById[p.club_id] ?? "Unknown club",
        Team: teamLabel(p),
        "Jersey Number": p.final_shirt ?? "",
        "Last Name": p.last_name,
        "First Name": p.first_name,
        "Year of Birth": p.year_of_birth ?? "",
        "Age Group": p.age_group ?? "",
      })),
    [reportRows, clubNameById]
  );

  const fileBaseName = useMemo(() => {
    const parts = ["number-report"];
    if (competition) parts.push(competition.replace(/[^\w]+/g, "-"));
    if (clubId) parts.push((clubNameById[clubId] ?? "club").replace(/[^\w]+/g, "-"));
    return parts.join("_").slice(0, 100);
  }, [competition, clubId, clubNameById]);

  const handleExportCsv = () => {
    if (exportRows.length === 0) return;
    const headers = Object.keys(exportRows[0]);
    const csv = [
      headers,
      ...exportRows.map((row) => headers.map((h) => (row as any)[h])),
    ]
      .map((row) => row.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(","))
      .join("\n");
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${fileBaseName}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleExportExcel = () => {
    if (exportRows.length === 0) return;
    const worksheet = XLSX.utils.json_to_sheet(exportRows);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, "Number Report");
    XLSX.writeFile(workbook, `${fileBaseName}.xlsx`);
  };

  const selectedClubName = clubId ? clubNameById[clubId] ?? "" : "";

  return (
    <div>
      <h1 className="text-2xl font-bold mb-4">Number Report</h1>
      <p className="text-sm text-gray-600 mb-6">
        Produce a roster of who's assigned what jersey number — for a whole competition,
        a single club, or specific team(s) within that club. Export to CSV or Excel.
      </p>

      {error && (
        <div className="mb-4 text-sm text-red-700 bg-red-50 border border-red-200 rounded p-3">
          {error}
        </div>
      )}

      {loading ? (
        <SkeletonTable rows={6} cols={5} />
      ) : (
        <>
          {/* Filters */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-4">
            <div>
              <label className="block text-xs font-semibold text-gray-700 mb-1 uppercase tracking-wide">
                Competition
              </label>
              <select
                value={competition}
                onChange={(e) => setCompetition(e.target.value)}
                className="border rounded px-3 py-2 w-full"
              >
                <option value="">Select a competition…</option>
                {competitions.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className="block text-xs font-semibold text-gray-700 mb-1 uppercase tracking-wide">
                Club <span className="font-normal text-gray-400">(optional)</span>
              </label>
              <select
                value={clubId}
                onChange={(e) => setClubId(e.target.value)}
                className="border rounded px-3 py-2 w-full"
                disabled={!competition}
              >
                <option value="">All clubs in this competition</option>
                {clubsInCompetition.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className="block text-xs font-semibold text-gray-700 mb-1 uppercase tracking-wide">
                Active players only
              </label>
              <label className="flex items-center gap-2 border rounded px-3 py-2 text-sm cursor-pointer">
                <input
                  type="checkbox"
                  checked={activeOnly}
                  onChange={(e) => setActiveOnly(e.target.checked)}
                />
                Exclude players inactive 2+ seasons
              </label>
            </div>
          </div>

          {/* Team checkboxes — only once a club is chosen */}
          {clubId && teamOptions.length > 0 && (
            <div className="mb-6">
              <label className="block text-xs font-semibold text-gray-700 mb-2 uppercase tracking-wide">
                Team(s) <span className="font-normal text-gray-400">(optional — leave all unchecked for every team in {selectedClubName})</span>
              </label>
              <div className="flex flex-wrap gap-2">
                {teamOptions.map((t) => {
                  const active = selectedTeamKeys.has(t.key);
                  return (
                    <button
                      key={t.key}
                      type="button"
                      onClick={() => toggleTeam(t.key)}
                      className={`text-xs px-3 py-1.5 rounded-full border transition ${
                        active
                          ? "bg-brand-600 text-white border-brand-600"
                          : "bg-white text-gray-700 border-gray-300 hover:bg-gray-50"
                      }`}
                    >
                      {t.label} <span className="opacity-70">({t.count})</span>
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          {/* Export buttons */}
          {competition && (
            <div className="flex flex-wrap gap-2 mb-6">
              <button
                type="button"
                onClick={handleExportCsv}
                disabled={reportRows.length === 0}
                className="flex items-center gap-2 px-4 py-2 bg-slate-700 text-white rounded text-sm disabled:bg-gray-400"
              >
                <FileDown size={16} />
                Export CSV
              </button>
              <button
                type="button"
                onClick={handleExportExcel}
                disabled={reportRows.length === 0}
                className="flex items-center gap-2 px-4 py-2 bg-emerald-600 text-white rounded text-sm disabled:bg-gray-400"
              >
                <FileSpreadsheet size={16} />
                Export Excel
              </button>
              <span className="text-xs text-gray-500 self-center">
                {reportRows.length} player{reportRows.length === 1 ? "" : "s"} in this report
              </span>
            </div>
          )}

          {/* Preview table */}
          {!competition ? (
            <EmptyState
              icon={FileSpreadsheet}
              title="Select a competition to get started"
              description="Then optionally narrow to a club, and specific team(s) within it."
            />
          ) : reportRows.length === 0 ? (
            <EmptyState
              icon={FileSpreadsheet}
              title="No players match these filters"
              description="Try a different competition/club, or untick 'Active players only'."
            />
          ) : (
            <div className="overflow-x-auto border rounded bg-white">
              <table className="min-w-full text-xs">
                <thead className="bg-gray-100">
                  <tr>
                    <th className="px-3 py-2 text-left">Club</th>
                    <th className="px-3 py-2 text-left">Team</th>
                    <th className="px-3 py-2 text-left">#</th>
                    <th className="px-3 py-2 text-left">Last Name</th>
                    <th className="px-3 py-2 text-left">First Name</th>
                    <th className="px-3 py-2 text-left">YOB</th>
                  </tr>
                </thead>
                <tbody>
                  {reportRows.map((p) => (
                    <tr key={p.id} className="border-t odd:bg-white even:bg-gray-50">
                      <td className="px-3 py-2">{clubNameById[p.club_id] ?? "—"}</td>
                      <td className="px-3 py-2 text-gray-600">{teamLabel(p)}</td>
                      <td className="px-3 py-2 font-semibold">
                        {p.final_shirt ?? <span className="text-gray-400">—</span>}
                      </td>
                      <td className="px-3 py-2">{p.last_name}</td>
                      <td className="px-3 py-2">{p.first_name}</td>
                      <td className="px-3 py-2 text-gray-500">{p.year_of_birth ?? "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </div>
  );
};

export default NumberReport;
