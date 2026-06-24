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
  bc_last_seen_season: number | null;
}

interface Competition {
  id: string;
  name: string;
}

interface Club {
  id: string;
  name: string;
}

const PAGE_SIZE = 1000;

/** Pages through a query in batches of 1000 -- Supabase/PostgREST caps a single
 * request at 1000 rows by default, which silently truncates anything larger
 * (confirmed in production: 4000+ active players across two competitions). Every
 * fetch in this page is also scoped (by club, or by one competition) rather than
 * pulling the whole table, so this loop only ever runs over a bounded slice. */
async function fetchAllPages<T>(
  buildQuery: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: any }>
): Promise<T[]> {
  const rows: T[] = [];
  let from = 0;
  while (true) {
    const { data, error } = await buildQuery(from, from + PAGE_SIZE - 1);
    if (error) throw error;
    const batch = data ?? [];
    rows.push(...batch);
    if (batch.length < PAGE_SIZE) break;
    from += PAGE_SIZE;
  }
  return rows;
}

const PLAYER_COLUMNS =
  "id, first_name, last_name, club_id, division_code, team_name, age_group, final_shirt, year_of_birth, bc_last_seen_season";

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

  const [competitions, setCompetitions] = useState<Competition[]>([]);
  const [loadingCompetitions, setLoadingCompetitions] = useState(false);

  const [competitionId, setCompetitionId] = useState<string>("");
  const [clubsInCompetition, setClubsInCompetition] = useState<Club[]>([]);
  const [loadingClubs, setLoadingClubs] = useState(false);

  const [clubId, setClubId] = useState<string>("");

  // Scoped player sets -- never the whole table. Exactly one of these is populated
  // at a time, depending on how far the customer has drilled in:
  //   - no club chosen  -> wholeCompetitionPlayers (scoped to ONE competition)
  //   - club chosen     -> clubPlayers (scoped to ONE club -- always small)
  const [wholeCompetitionPlayers, setWholeCompetitionPlayers] = useState<PlayerRow[]>([]);
  const [clubPlayers, setClubPlayers] = useState<PlayerRow[]>([]);
  const [loadingPlayers, setLoadingPlayers] = useState(false);

  const [selectedTeamKeys, setSelectedTeamKeys] = useState<Set<string>>(new Set());
  const [activeOnly, setActiveOnly] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const allClubs = useMemo(() => clubsInCompetition, [clubsInCompetition]);
  const clubNameById = useMemo(() => {
    const map: Record<string, string> = {};
    allClubs.forEach((c) => (map[c.id] = c.name));
    return map;
  }, [allClubs]);

  // Step 1: competitions table is tiny (a handful of rows, ever) -- safe to load in full.
  useEffect(() => {
    const load = async () => {
      setLoadingCompetitions(true);
      setError(null);
      try {
        const { data, error } = await supabase.from("competitions").select("id, name").order("name");
        if (error) throw error;
        setCompetitions((data ?? []) as Competition[]);
      } catch (err: any) {
        console.error("NumberReport load competitions error", err);
        setError(err.message ?? "Failed to load competitions.");
      } finally {
        setLoadingCompetitions(false);
      }
    };
    void load();
  }, []);

  // Step 2: clubs within the chosen competition, discovered via the TEAMS table (a
  // few hundred rows total, growing with team count not player count) rather than
  // scanning players -- this is what keeps the dropdown fast no matter how large
  // the players table gets.
  useEffect(() => {
    setClubId("");
    setSelectedTeamKeys(new Set());
    setClubsInCompetition([]);
    setWholeCompetitionPlayers([]);
    setClubPlayers([]);

    if (!competitionId) return;

    const load = async () => {
      setLoadingClubs(true);
      setError(null);
      try {
        const { data: teamRows, error: teamErr } = await supabase
          .from("teams")
          .select("club_id_uuid")
          .eq("competition_id", competitionId);
        if (teamErr) throw teamErr;

        const clubIds = Array.from(
          new Set((teamRows ?? []).map((r: any) => r.club_id_uuid).filter(Boolean))
        );
        if (clubIds.length === 0) {
          setClubsInCompetition([]);
          return;
        }

        const { data: clubRows, error: clubErr } = await supabase
          .from("clubs")
          .select("id, name")
          .in("id", clubIds)
          .order("name");
        if (clubErr) throw clubErr;

        setClubsInCompetition((clubRows ?? []) as Club[]);
      } catch (err: any) {
        console.error("NumberReport load clubs error", err);
        setError(err.message ?? "Failed to load clubs for this competition.");
      } finally {
        setLoadingClubs(false);
      }
    };
    void load();
  }, [competitionId]);

  // Step 3a: no club chosen -> load every player in this ONE competition (paginated,
  // but scoped -- bounded by one competition's size, not the whole players table).
  useEffect(() => {
    setSelectedTeamKeys(new Set());
    if (!competitionId || clubId) {
      setWholeCompetitionPlayers([]);
      return;
    }

    const competitionName = competitions.find((c) => c.id === competitionId)?.name;
    if (!competitionName) return;

    const load = async () => {
      setLoadingPlayers(true);
      setError(null);
      try {
        const rows = await fetchAllPages<PlayerRow>((from, to) =>
          supabase
            .from("players")
            .select(PLAYER_COLUMNS)
            .eq("competition_source", competitionName)
            .is("deleted_at", null)
            .range(from, to) as any
        );
        setWholeCompetitionPlayers(rows);
      } catch (err: any) {
        console.error("NumberReport load competition players error", err);
        setError(err.message ?? "Failed to load players for this competition.");
      } finally {
        setLoadingPlayers(false);
      }
    };
    void load();
  }, [competitionId, clubId, competitions]);

  // Step 3b: a club IS chosen -> load just that club's roster. Always small (one
  // club's players), regardless of how large the overall players table grows.
  useEffect(() => {
    setSelectedTeamKeys(new Set());
    if (!clubId) {
      setClubPlayers([]);
      return;
    }

    const load = async () => {
      setLoadingPlayers(true);
      setError(null);
      try {
        const { data, error } = await supabase
          .from("players")
          .select(PLAYER_COLUMNS)
          .eq("club_id", clubId)
          .is("deleted_at", null);
        if (error) throw error;
        setClubPlayers((data ?? []) as PlayerRow[]);
      } catch (err: any) {
        console.error("NumberReport load club players error", err);
        setError(err.message ?? "Failed to load players for this club.");
      } finally {
        setLoadingPlayers(false);
      }
    };
    void load();
  }, [clubId]);

  const isActive = (p: PlayerRow) =>
    p.bc_last_seen_season == null || p.bc_last_seen_season >= currentYear - 2;

  const basePlayers = clubId ? clubPlayers : wholeCompetitionPlayers;

  const filteredPlayers = useMemo(
    () => (activeOnly ? basePlayers.filter(isActive) : basePlayers),
    [basePlayers, activeOnly, currentYear]
  );

  const teamOptions = useMemo(() => {
    if (!clubId) return [];
    const map = new Map<string, { key: string; label: string; count: number }>();
    for (const p of filteredPlayers) {
      const key = teamKey(p);
      if (!map.has(key)) map.set(key, { key, label: teamLabel(p), count: 0 });
      map.get(key)!.count += 1;
    }
    return Array.from(map.values()).sort((a, b) => a.label.localeCompare(b.label));
  }, [filteredPlayers, clubId]);

  const toggleTeam = (key: string) => {
    setSelectedTeamKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  // Final report rows: sorted by club, then team, then jersey number (nulls last).
  const reportRows = useMemo(() => {
    let rows = filteredPlayers;
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
  }, [filteredPlayers, clubId, selectedTeamKeys, clubNameById]);

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

  const competitionName = competitions.find((c) => c.id === competitionId)?.name ?? "";

  const fileBaseName = useMemo(() => {
    const parts = ["number-report"];
    if (competitionName) parts.push(competitionName.replace(/[^\w]+/g, "-"));
    if (clubId) parts.push((clubNameById[clubId] ?? "club").replace(/[^\w]+/g, "-"));
    return parts.join("_").slice(0, 100);
  }, [competitionName, clubId, clubNameById]);

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
  const loading = loadingCompetitions || loadingClubs || loadingPlayers;

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

      {/* Filters */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-4">
        <div>
          <label className="block text-xs font-semibold text-gray-700 mb-1 uppercase tracking-wide">
            Competition
          </label>
          <select
            value={competitionId}
            onChange={(e) => setCompetitionId(e.target.value)}
            className="border rounded px-3 py-2 w-full"
            disabled={loadingCompetitions}
          >
            <option value="">Select a competition…</option>
            {competitions.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
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
            disabled={!competitionId || loadingClubs}
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
      {competitionId && !loading && (
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
      {loading ? (
        <SkeletonTable rows={6} cols={6} />
      ) : !competitionId ? (
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
    </div>
  );
};

export default NumberReport;
