// FILE: src/components/Importer.tsx
import React, { useState, ChangeEvent } from "react";
import { supabase } from "../services/supabase";

type ParsingStrategy = "north_gc" | "gold_coast";
type ImportMode = "upsert" | "replace";

interface RawRow {
  [key: string]: string;
}

interface ParsedPlayer {
  bcPlayerId: string;
  firstName: string;
  lastName: string;
  clubName: string;
  teamRaw: string;
  teamCode: string | null;
  teamLabel: string | null;
  ageGroup: string;       // normalised to U10/U12/.../SLG
  ageGroupRaw: string;    // raw value from BC for display
  divisionGrade: string;
  finalShirt: number | null;
}

interface PreviewRow extends ParsedPlayer {
  clubId: string | null;
  isNewClub: boolean;
}

// ─── Age group normalisation ──────────────────────────────────────────────────
// BC exports use inconsistent formats:
//   GC:       "UNDER 14 BOYS", "JUNIOR GIRLS", "OPEN GIRLS", "UNDER 10 MIXED"
//   Seahawks: "U16 BOYS", "U12 GIRLS", "SUPERLEAUGE GIRLS", "U20 BOYS"
// Widget uses: U10, U12, U14, U16, U18, U20, SLG
function normalizeAgeGroup(raw: string): string {
  const s = (raw ?? "").trim().toUpperCase();

  // "UNDER 14 BOYS" / "UNDER 10 MIXED" → "U14", "U10"
  const underMatch = s.match(/^UNDER\s+(\d+)/);
  if (underMatch) return `U${underMatch[1]}`;

  // "U14 BOYS" / "U16 GIRLS" → "U14", "U16"
  const uMatch = s.match(/^U(\d+)/);
  if (uMatch) return `U${uMatch[1]}`;

  // "JUNIOR GIRLS/BOYS" → "U14" (Qld standard)
  if (s.startsWith("JUNIOR")) return "U14";

  // "OPEN ...", "SUPERLEAGUE/SUPERLEAUGE ...", "SENIOR ..." → "SLG"
  if (/^OPEN|SUPERLEA[GU]|^SENIOR/.test(s)) return "SLG";

  return raw.trim(); // fallback: store as-is (will still display in admin)
}

// ─── Team field parsing ───────────────────────────────────────────────────────
function looksLikeTeamCode(token: string): boolean {
  return /^(\d{1,2}|[JOS])[A-Z]{1,2}\d/i.test(token);
}

function deriveTeamFields(
  teamRaw: string,
  strategy: ParsingStrategy
): { clubName: string; teamCode: string | null; teamLabel: string | null } {
  const trimmed = teamRaw.trim();
  const parts = trimmed.split(/\s+/).filter(Boolean);

  if (parts.length === 0) {
    return { clubName: "", teamCode: null, teamLabel: null };
  }

  if (strategy === "north_gc") {
    // "Warriors 16B.2" → clubName=Warriors, teamCode=16B.2
    const clubName = parts[0] ?? "";
    const teamCode = parts.slice(1).join(" ") || null;
    return { clubName, teamCode, teamLabel: null };
  }

  // gold_coast: "12BC3 Amigos White" → teamCode=12BC3, club=Amigos, team=White
  //             "BLADES CRUSADERS"   → club=BLADES, team=CRUSADERS
  if (looksLikeTeamCode(parts[0])) {
    const teamCode = parts[0];
    const clubName = parts[1] ?? "";
    const teamLabel = parts.slice(2).join(" ") || null;
    return { clubName, teamCode, teamLabel };
  } else {
    const clubName = parts[0] ?? "";
    const teamLabel = parts.slice(1).join(" ") || null;
    return { clubName, teamCode: null, teamLabel };
  }
}

// ─── CSV parser ───────────────────────────────────────────────────────────────
function parseCsv(text: string): RawRow[] {
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length < 2) return [];
  const header = lines[0].split(",").map((h) => h.trim());
  const rows: RawRow[] = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(",");
    if (cols.length === 1 && cols[0].trim() === "") continue;
    const row: RawRow = {};
    header.forEach((key, idx) => {
      row[key] = (cols[idx] ?? "").trim();
    });
    rows.push(row);
  }
  return rows;
}

// ─── Component ────────────────────────────────────────────────────────────────
const Importer: React.FC = () => {
  const [file, setFile] = useState<File | null>(null);
  const [parsingStrategy, setParsingStrategy] = useState<ParsingStrategy>("north_gc");
  const [importMode, setImportMode] = useState<ImportMode>("upsert");
  const [competitionSource, setCompetitionSource] = useState("");
  const [previewRows, setPreviewRows] = useState<PreviewRow[]>([]);
  const [newClubNames, setNewClubNames] = useState<string[]>([]);
  const [skippedCount, setSkippedCount] = useState(0);
  const [loading, setLoading] = useState(false);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // Reset state
  const [resetConfirm, setResetConfirm] = useState("");
  const [resetLoading, setResetLoading] = useState(false);
  const [resetStatus, setResetStatus] = useState<string | null>(null);
  const [resetError, setResetError] = useState<string | null>(null);

  const handleFileChange = (e: ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0] ?? null;
    setFile(f);
    setPreviewRows([]);
    setNewClubNames([]);
    setSkippedCount(0);
    setStatusMessage(null);
    setErrorMessage(null);
  };

  const handlePreview = async () => {
    setStatusMessage(null);
    setErrorMessage(null);
    setPreviewRows([]);
    setNewClubNames([]);
    setSkippedCount(0);

    if (!file) { setErrorMessage("Please select a CSV file first."); return; }
    if (!competitionSource.trim()) { setErrorMessage("Please enter a competition / season label."); return; }

    setLoading(true);

    try {
      const text = await file.text();
      const rawRows = parseCsv(text);

      if (rawRows.length === 0) {
        setErrorMessage("No data rows found in CSV.");
        setLoading(false);
        return;
      }

      // Filter: only rows where playing == "1"
      const playingRows = rawRows.filter((r) => {
        const v = r["playing"] ?? r["Playing"] ?? "";
        return v === "1";
      });
      setSkippedCount(rawRows.length - playingRows.length);

      // Parse and deduplicate by bc_player_id
      // Prefer rows with a non-zero, non-null final shirt number
      const seenBcIds = new Map<string, ParsedPlayer>();
      const noBcIdRows: ParsedPlayer[] = [];

      for (const row of playingRows) {
        const teamRaw = (
          row["Played For (Team)"] ??
          row["playedForTeam"] ??
          row["played for team"] ??
          ""
        );
        const { clubName, teamCode, teamLabel } = deriveTeamFields(teamRaw, parsingStrategy);

        const bcPlayerId = (row["Player Id"] ?? row["Player ID"] ?? "").trim();
        const firstName = (row["First Name"] ?? row["FirstName"] ?? "").trim();
        const lastName = (row["Last Name"] ?? row["LastName"] ?? "").trim();

        // finalShirt: empty string → null (unassigned). Any numeric value, including 0,
        // is stored as-is — #0 is a valid jersey number. BC also uses 0 as a sentinel for
        // "no jersey assigned" but we can't distinguish that from a real #0 in the export.
        // The dedup logic below prefers non-zero rows when a player has mixed entries.
        const shirtStr = (row["finalShirt"] ?? row["FinalShirt"] ?? "").trim();
        const shirtNum = shirtStr !== "" ? Number(shirtStr) : NaN;
        const finalShirt = Number.isFinite(shirtNum) ? shirtNum : null;

        const ageGroupRaw = (row["playerDivisionName"] ?? "").trim();
        const ageGroup = normalizeAgeGroup(ageGroupRaw);
        const divisionGrade = (row["playerDivisionGrade"] ?? "").trim();

        const player: ParsedPlayer = {
          bcPlayerId,
          firstName,
          lastName,
          clubName: clubName.trim(),
          teamRaw: teamRaw.trim(),
          teamCode,
          teamLabel,
          ageGroup,
          ageGroupRaw,
          divisionGrade,
          finalShirt,
        };

        if (bcPlayerId) {
          const existing = seenBcIds.get(bcPlayerId);
          if (!existing) {
            seenBcIds.set(bcPlayerId, player);
          } else {
            // Prefer row with a non-null shirt over null (null = no data in CSV).
            // If both have a value, keep the first (earlier game rows tend to be more accurate).
            if (existing.finalShirt === null && finalShirt !== null) {
              seenBcIds.set(bcPlayerId, player);
            }
          }
        } else {
          noBcIdRows.push(player);
        }
      }

      const parsed: ParsedPlayer[] = [
        ...Array.from(seenBcIds.values()),
        ...noBcIdRows,
      ];

      if (parsed.length === 0) {
        setErrorMessage(
          "No active players found after filtering (playing=1). " +
            "Check that the 'playing' column exists and contains '1' for active rows."
        );
        setLoading(false);
        return;
      }

      // Look up existing clubs
      const uniqueClubNames = Array.from(
        new Set(parsed.map((r) => r.clubName).filter(Boolean))
      );

      const { data: existingClubs, error: clubsError } = await supabase
        .from("clubs")
        .select("id, name")
        .in("name", uniqueClubNames);

      if (clubsError) {
        setErrorMessage("Failed to load clubs from database.");
        setLoading(false);
        return;
      }

      const clubMap = new Map<string, string>();
      for (const c of existingClubs ?? []) clubMap.set(c.name, c.id);

      const newClubs = uniqueClubNames.filter((n) => !clubMap.has(n) && n.length > 0);
      setNewClubNames(newClubs);

      const preview: PreviewRow[] = parsed.map((p) => ({
        ...p,
        clubId: clubMap.get(p.clubName) ?? null,
        isNewClub: newClubs.includes(p.clubName),
      }));

      setPreviewRows(preview);

      const skipped = rawRows.length - playingRows.length;
      const noShirtCount = preview.filter((r) => r.finalShirt === null).length;
      setStatusMessage(
        `Preview ready: ${preview.length} player rows` +
          (skipped > 0 ? `, ${skipped} skipped (not playing)` : "") +
          (noShirtCount > 0 ? `, ${noShirtCount} with no shirt number in CSV (stored as blank)` : "") +
          "." +
          (newClubs.length > 0
            ? ` ${newClubs.length} new club(s) will be auto-created on commit.`
            : " All clubs already in database.") +
          (importMode === "replace"
            ? " ⚠ Replace mode: existing players for these clubs will be deleted first."
            : "")
      );
    } catch (err: any) {
      setErrorMessage(err.message ?? "Unexpected error during preview.");
    } finally {
      setLoading(false);
    }
  };

  const handleCommit = async () => {
    setStatusMessage(null);
    setErrorMessage(null);

    if (previewRows.length === 0) {
      setErrorMessage("No preview rows to commit. Run Preview first.");
      return;
    }

    setLoading(true);

    try {
      // Step 1: Create any new clubs
      const clubMap = new Map<string, string>();
      for (const row of previewRows) {
        if (row.clubId) clubMap.set(row.clubName, row.clubId);
      }

      if (newClubNames.length > 0) {
        const { data: created, error: createErr } = await supabase
          .from("clubs")
          .insert(newClubNames.map((name) => ({ name, is_client: false })))
          .select("id, name");

        if (createErr) {
          setErrorMessage(`Failed to create new clubs: ${createErr.message}`);
          setLoading(false);
          return;
        }
        for (const c of created ?? []) clubMap.set(c.name, c.id);
      }

      // Step 2: Replace mode — delete existing players for all clubs in this import
      if (importMode === "replace") {
        const allClubIds = Array.from(
          new Set(
            previewRows
              .map((r) => clubMap.get(r.clubName) ?? r.clubId)
              .filter(Boolean) as string[]
          )
        );

        if (allClubIds.length > 0) {
          const { error: delErr } = await supabase
            .from("players")
            .delete()
            .in("club_id", allClubIds);

          if (delErr) {
            setErrorMessage(`Failed to clear existing players: ${delErr.message}`);
            setLoading(false);
            return;
          }
        }
      }

      const season = competitionSource.trim();

      // Step 3a: Upsert rows with a bc_player_id
      const withBcId = previewRows.filter((r) => r.bcPlayerId);
      if (withBcId.length > 0) {
        const upsertPayload = withBcId.map((r) => ({
          bc_player_id: r.bcPlayerId,
          first_name: r.firstName,
          last_name: r.lastName,
          club_id: clubMap.get(r.clubName) ?? r.clubId ?? null,
          team_id: (r.teamCode ?? r.teamRaw) || null,
          team_name_raw: r.teamRaw || null,
          team_code: r.teamCode ?? null,
          team_label: r.teamLabel ?? null,
          age_group: r.ageGroup || null,
          division_grade: r.divisionGrade || null,
          final_shirt: r.finalShirt ?? null,
          competition_source: season,
          bc_last_seen_season: season,
        }));

        const { error: upsertErr } = await supabase
          .from("players")
          .upsert(upsertPayload, { onConflict: "bc_player_id", ignoreDuplicates: false });

        if (upsertErr) {
          setErrorMessage(`Upsert failed: ${upsertErr.message}`);
          setLoading(false);
          return;
        }
      }

      // Step 3b: Insert rows without bc_player_id
      const withoutBcId = previewRows.filter((r) => !r.bcPlayerId);
      if (withoutBcId.length > 0) {
        const insertPayload = withoutBcId.map((r) => ({
          first_name: r.firstName,
          last_name: r.lastName,
          club_id: clubMap.get(r.clubName) ?? r.clubId ?? null,
          team_id: (r.teamCode ?? r.teamRaw) || null,
          team_name_raw: r.teamRaw || null,
          team_code: r.teamCode ?? null,
          team_label: r.teamLabel ?? null,
          age_group: r.ageGroup || null,
          division_grade: r.divisionGrade || null,
          final_shirt: r.finalShirt ?? null,
          competition_source: season,
        }));

        const { error: insertErr } = await supabase.from("players").insert(insertPayload);
        if (insertErr) {
          setErrorMessage(`Insert failed (rows without BC Player ID): ${insertErr.message}`);
          setLoading(false);
          return;
        }
      }

      const parts: string[] = [];
      if (importMode === "replace") parts.push("existing players cleared");
      if (withBcId.length > 0) parts.push(`${withBcId.length} players upserted (by BC Player ID)`);
      if (withoutBcId.length > 0) parts.push(`${withoutBcId.length} inserted (no BC Player ID)`);
      if (newClubNames.length > 0) parts.push(`${newClubNames.length} new club(s) created — enable any client clubs in the Clubs page`);

      setStatusMessage("Import complete: " + parts.join(", ") + ".");
      setPreviewRows([]);
      setNewClubNames([]);
    } catch (err: any) {
      setErrorMessage(err.message ?? "Unexpected error during commit.");
    } finally {
      setLoading(false);
    }
  };

  // ── Full data reset ──────────────────────────────────────────────────────
  const handleFullReset = async () => {
    if (resetConfirm !== "RESET") {
      setResetError("Type RESET to confirm.");
      return;
    }
    setResetLoading(true);
    setResetStatus(null);
    setResetError(null);

    try {
      // Order matters — FK constraints
      const tables = ["orders", "pending_allocations", "allocations", "inventory", "players"];
      for (const table of tables) {
        const { error } = await supabase.from(table).delete().neq("id", "00000000-0000-0000-0000-000000000000");
        if (error) {
          setResetError(`Failed to clear ${table}: ${error.message}`);
          setResetLoading(false);
          return;
        }
      }
      setResetStatus("All player, inventory, allocation, and order data cleared. Clubs and settings retained.");
      setResetConfirm("");
    } catch (err: any) {
      setResetError(err.message ?? "Unexpected error during reset.");
    } finally {
      setResetLoading(false);
    }
  };

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div className="space-y-8">
      <div>
        <h2 className="text-2xl font-bold mb-2">Game Log Importer</h2>
        <p className="text-gray-600 text-sm">
          Import Basketball Connect game log exports. Only rows where{" "}
          <code>playing=1</code> are imported. Age group codes are normalised
          (e.g. "UNDER 14 BOYS" → "U14"). Jersey number 0 is treated as
          unassigned. Players with a BC Player ID are safely upserted — re-importing
          the same report won't create duplicates.
        </p>
      </div>

      <div className="bg-white rounded-xl shadow p-6 max-w-2xl space-y-4">
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">
            CSV File (Basketball Connect game log export)
          </label>
          <input
            type="file"
            accept=".csv"
            onChange={handleFileChange}
            className="block w-full text-sm text-gray-700 file:mr-4 file:py-2 file:px-4
                       file:rounded-md file:border-0 file:text-sm file:font-semibold
                       file:bg-indigo-50 file:text-indigo-700 hover:file:bg-indigo-100"
          />
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">
            Competition / Season Label
          </label>
          <input
            type="text"
            value={competitionSource}
            onChange={(e) => setCompetitionSource(e.target.value)}
            placeholder="e.g. Gold Coast 2026 Winter Rd1"
            className="w-full px-3 py-2 border rounded-md text-sm border-gray-300
                       focus:outline-none focus:ring-2 focus:ring-indigo-500"
          />
          <p className="text-xs text-gray-500 mt-1">
            Stored as <code>bc_last_seen_season</code> — helps identify stale player records.
          </p>
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">
            Parsing Strategy
          </label>
          <select
            value={parsingStrategy}
            onChange={(e) => setParsingStrategy(e.target.value as ParsingStrategy)}
            className="w-full px-3 py-2 border rounded-md text-sm border-gray-300
                       focus:outline-none focus:ring-2 focus:ring-indigo-500"
          >
            <option value="north_gc">North Gold Coast Seahawks — "Warriors 16B.2"</option>
            <option value="gold_coast">Gold Coast Association — "12BC3 Amigos White"</option>
          </select>
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">
            Import Mode
          </label>
          <div className="space-y-2">
            <label className="flex items-start gap-2 cursor-pointer">
              <input
                type="radio"
                name="importMode"
                value="upsert"
                checked={importMode === "upsert"}
                onChange={() => setImportMode("upsert")}
                className="mt-0.5"
              />
              <div>
                <span className="text-sm font-medium">Upsert (merge)</span>
                <p className="text-xs text-gray-500">
                  Update existing players by BC Player ID. Safe to re-run. Won't remove players not in this file.
                </p>
              </div>
            </label>
            <label className="flex items-start gap-2 cursor-pointer">
              <input
                type="radio"
                name="importMode"
                value="replace"
                checked={importMode === "replace"}
                onChange={() => setImportMode("replace")}
                className="mt-0.5"
              />
              <div>
                <span className="text-sm font-medium text-amber-700">Replace (clear first)</span>
                <p className="text-xs text-gray-500">
                  Deletes all players for every club found in this file, then inserts fresh. Use when replacing a season's data. Club records are kept.
                </p>
              </div>
            </label>
          </div>
        </div>

        {importMode === "replace" && (
          <div className="text-sm text-amber-700 bg-amber-50 border border-amber-300 rounded-md px-3 py-2">
            ⚠ Replace mode will permanently delete all player records for clubs in this import file before inserting new ones. This cannot be undone.
          </div>
        )}

        <div className="flex gap-3">
          <button
            onClick={handlePreview}
            disabled={loading || !file}
            className={`px-4 py-2 rounded-md text-sm font-semibold text-white
                        ${loading || !file ? "bg-indigo-300 cursor-not-allowed" : "bg-indigo-600 hover:bg-indigo-700"}`}
          >
            {loading ? "Working…" : "Preview Import"}
          </button>
          <button
            onClick={handleCommit}
            disabled={loading || previewRows.length === 0}
            className={`px-4 py-2 rounded-md text-sm font-semibold text-white
                        ${loading || previewRows.length === 0
                          ? "bg-gray-300 cursor-not-allowed"
                          : importMode === "replace"
                          ? "bg-amber-600 hover:bg-amber-700"
                          : "bg-emerald-600 hover:bg-emerald-700"}`}
          >
            {importMode === "replace" ? "Replace & Import" : "Commit Import"}
          </button>
        </div>

        {skippedCount > 0 && (
          <div className="text-xs text-gray-500 bg-gray-50 border border-gray-200 rounded-md px-3 py-2">
            {skippedCount} row{skippedCount !== 1 ? "s" : ""} skipped — playing ≠ 1.
          </div>
        )}

        {newClubNames.length > 0 && (
          <div className="text-sm text-amber-700 bg-amber-50 border border-amber-200 rounded-md px-3 py-2">
            <strong>{newClubNames.length} new club(s)</strong> not yet in database — will be auto-created as non-client:{" "}
            <span className="font-mono">{newClubNames.join(", ")}</span>
          </div>
        )}

        {statusMessage && (
          <div className="text-sm text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-md px-3 py-2">
            {statusMessage}
          </div>
        )}
        {errorMessage && (
          <div className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-md px-3 py-2">
            {errorMessage}
          </div>
        )}
      </div>

      {/* Preview table */}
      {previewRows.length > 0 && (
        <div className="bg-white rounded-xl shadow p-4 max-h-96 overflow-auto">
          <table className="min-w-full text-xs">
            <thead className="bg-gray-50 sticky top-0">
              <tr>
                <th className="text-left px-2 py-1 border-b">BC Player ID</th>
                <th className="text-left px-2 py-1 border-b">Club</th>
                <th className="text-left px-2 py-1 border-b">First</th>
                <th className="text-left px-2 py-1 border-b">Last</th>
                <th className="text-left px-2 py-1 border-b">Team Code</th>
                <th className="text-left px-2 py-1 border-b">Age Group</th>
                <th className="text-left px-2 py-1 border-b">Raw Division</th>
                <th className="text-left px-2 py-1 border-b">Shirt #</th>
              </tr>
            </thead>
            <tbody>
              {previewRows.map((row, idx) => (
                <tr
                  key={idx}
                  className={`odd:bg-white even:bg-gray-50 ${row.isNewClub ? "text-amber-700" : ""}`}
                >
                  <td className="px-2 py-1 border-b font-mono text-gray-500">
                    {row.bcPlayerId || "—"}
                  </td>
                  <td className="px-2 py-1 border-b">
                    {row.clubName}
                    {row.isNewClub && (
                      <span className="ml-1 text-xs bg-amber-100 text-amber-700 px-1 rounded">new</span>
                    )}
                  </td>
                  <td className="px-2 py-1 border-b">{row.firstName}</td>
                  <td className="px-2 py-1 border-b">{row.lastName}</td>
                  <td className="px-2 py-1 border-b font-mono">{row.teamCode ?? "—"}</td>
                  <td className="px-2 py-1 border-b font-semibold">{row.ageGroup}</td>
                  <td className="px-2 py-1 border-b text-gray-400">{row.ageGroupRaw}</td>
                  <td className="px-2 py-1 border-b">
                    {row.finalShirt !== null ? row.finalShirt : <span className="text-gray-300">—</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Full Data Reset panel */}
      <div className="bg-white rounded-xl shadow p-6 max-w-2xl border border-red-200">
        <h3 className="text-base font-bold text-red-700 mb-1">Full Data Reset</h3>
        <p className="text-sm text-gray-600 mb-4">
          Permanently deletes all <strong>players, inventory, allocations, pending allocations,
          and orders</strong>. Clubs and club settings are retained. Use this before a fresh
          season import to start from a clean slate.
        </p>
        <div className="space-y-3">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Type <code className="bg-gray-100 px-1 rounded">RESET</code> to confirm
            </label>
            <input
              type="text"
              value={resetConfirm}
              onChange={(e) => setResetConfirm(e.target.value)}
              placeholder="RESET"
              className="w-full px-3 py-2 border border-red-300 rounded-md text-sm
                         focus:outline-none focus:ring-2 focus:ring-red-500"
            />
          </div>
          <button
            onClick={handleFullReset}
            disabled={resetLoading || resetConfirm !== "RESET"}
            className={`px-4 py-2 rounded-md text-sm font-semibold text-white
                        ${resetLoading || resetConfirm !== "RESET"
                          ? "bg-red-200 cursor-not-allowed"
                          : "bg-red-600 hover:bg-red-700"}`}
          >
            {resetLoading ? "Resetting…" : "Reset All Data"}
          </button>
          {resetStatus && (
            <div className="text-sm text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-md px-3 py-2">
              {resetStatus}
            </div>
          )}
          {resetError && (
            <div className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-md px-3 py-2">
              {resetError}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default Importer;
