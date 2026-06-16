// FILE: src/components/Importer.tsx
import React, { useState, ChangeEvent } from "react";
import { supabase } from "../services/supabase";

type ParsingStrategy = "north_gc" | "gold_coast";

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
  ageGroup: string;
  divisionGrade: string;
  finalShirt: number | null;
}

interface PreviewRow extends ParsedPlayer {
  clubId: string | null; // null = new club (will be auto-created on commit)
  isNewClub: boolean;
}

// Does this token look like a BC team code?
// Matches patterns like: 10BC3, 12GC1/2, JGC1, OGC2, 18BC1A, 14BC5/6
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

  // gold_coast strategy:
  // With team code:    "12BC3 Amigos White"    → teamCode=12BC3, club=Amigos, team=White
  //                    " 14BC1 BLADES LIGHTNING" → teamCode=14BC1, club=BLADES, team=LIGHTNING
  //                    "JGC1 HEAT BLAZES"        → teamCode=JGC1,  club=HEAT,  team=BLAZES
  // Without team code: "BLADES CRUSADERS"        → club=BLADES, team=CRUSADERS
  if (looksLikeTeamCode(parts[0])) {
    const teamCode = parts[0];
    const clubName = parts[1] ?? "";
    const teamLabel = parts.slice(2).join(" ") || null;
    return { clubName, teamCode, teamLabel };
  } else {
    // No team code prefix (e.g. " BLADES CRUSADERS" after trim)
    const clubName = parts[0] ?? "";
    const teamLabel = parts.slice(1).join(" ") || null;
    return { clubName, teamCode: null, teamLabel };
  }
}

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

const Importer: React.FC = () => {
  const [file, setFile] = useState<File | null>(null);
  const [parsingStrategy, setParsingStrategy] =
    useState<ParsingStrategy>("north_gc");
  const [competitionSource, setCompetitionSource] = useState("");
  const [previewRows, setPreviewRows] = useState<PreviewRow[]>([]);
  const [newClubNames, setNewClubNames] = useState<string[]>([]);
  const [skippedCount, setSkippedCount] = useState(0);
  const [loading, setLoading] = useState(false);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

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

    if (!file) {
      setErrorMessage("Please select a CSV file first.");
      return;
    }
    if (!competitionSource.trim()) {
      setErrorMessage("Please enter a competition / season label.");
      return;
    }

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
      const skipped = rawRows.length - playingRows.length;
      setSkippedCount(skipped);

      // Parse and deduplicate by bc_player_id (prefer non-zero shirt number)
      const seenBcIds = new Map<string, ParsedPlayer>();
      const noBcIdRows: ParsedPlayer[] = [];

      for (const row of playingRows) {
        const teamRaw =
          row["Played For (Team)"] ??
          row["playedForTeam"] ??
          row["played for team"] ??
          "";
        const { clubName, teamCode, teamLabel } = deriveTeamFields(
          teamRaw,
          parsingStrategy
        );

        const bcPlayerId = (
          row["Player Id"] ??
          row["Player ID"] ??
          ""
        ).trim();
        const firstName = (
          row["First Name"] ??
          row["FirstName"] ??
          ""
        ).trim();
        const lastName = (
          row["Last Name"] ??
          row["LastName"] ??
          ""
        ).trim();
        const shirtRaw = Number(row["finalShirt"] ?? row["FinalShirt"] ?? "");
        const finalShirt = Number.isFinite(shirtRaw) ? shirtRaw : null;
        const ageGroup = (row["playerDivisionName"] ?? "").trim();
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
          divisionGrade,
          finalShirt,
        };

        if (bcPlayerId) {
          const existing = seenBcIds.get(bcPlayerId);
          if (!existing) {
            seenBcIds.set(bcPlayerId, player);
          } else {
            // Prefer a row that has a non-null, non-zero shirt number
            const existingShirt = existing.finalShirt;
            if (
              (existingShirt === null || existingShirt === 0) &&
              finalShirt !== null &&
              finalShirt !== 0
            ) {
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

      // Collect unique club names and look up existing ones
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

      const clubMap = new Map<string, string>(); // name → id
      for (const c of existingClubs ?? []) {
        clubMap.set(c.name, c.id);
      }

      const newClubs = uniqueClubNames.filter(
        (n) => !clubMap.has(n) && n.length > 0
      );
      setNewClubNames(newClubs);

      const preview: PreviewRow[] = parsed.map((p) => ({
        ...p,
        clubId: clubMap.get(p.clubName) ?? null,
        isNewClub: newClubs.includes(p.clubName),
      }));

      setPreviewRows(preview);
      setStatusMessage(
        `Preview ready: ${preview.length} player rows` +
          (skipped > 0 ? `, ${skipped} skipped (not playing)` : "") +
          "." +
          (newClubs.length > 0
            ? ` ${newClubs.length} new club(s) will be auto-created as non-client on commit.`
            : " All clubs already in database.")
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
      // Step 1: Auto-create unknown clubs as is_client = false
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
        for (const c of created ?? []) {
          clubMap.set(c.name, c.id);
        }
      }

      const season = competitionSource.trim();

      // Step 2a: Upsert rows that have a bc_player_id
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
          .upsert(upsertPayload, {
            onConflict: "bc_player_id",
            ignoreDuplicates: false,
          });

        if (upsertErr) {
          setErrorMessage(`Upsert failed: ${upsertErr.message}`);
          setLoading(false);
          return;
        }
      }

      // Step 2b: Insert rows without bc_player_id (no safe upsert key)
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

        const { error: insertErr } = await supabase
          .from("players")
          .insert(insertPayload);

        if (insertErr) {
          setErrorMessage(
            `Insert failed (rows without BC Player ID): ${insertErr.message}`
          );
          setLoading(false);
          return;
        }
      }

      const parts: string[] = [];
      if (withBcId.length > 0)
        parts.push(`${withBcId.length} players upserted (by BC Player ID)`);
      if (withoutBcId.length > 0)
        parts.push(`${withoutBcId.length} inserted (no BC Player ID)`);
      if (newClubNames.length > 0)
        parts.push(
          `${newClubNames.length} new club(s) created — enable any that are your clients in the Clubs admin page`
        );

      setStatusMessage("Import complete: " + parts.join(", ") + ".");
      setPreviewRows([]);
      setNewClubNames([]);
    } catch (err: any) {
      setErrorMessage(err.message ?? "Unexpected error during commit.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-bold mb-2">Game Log Importer</h2>
        <p className="text-gray-600 text-sm">
          Import Basketball Connect game log exports into the players database.
          Only rows where <code>playing=1</code> are imported. Players with a
          BC Player ID are safely upserted — re-importing the same report won't
          create duplicates. Unknown clubs are auto-created as non-client (you
          can enable them later in the Clubs admin page).
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
            Stored on each player record as <code>bc_last_seen_season</code> —
            helps identify players absent from recent reports.
          </p>
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">
            Parsing Strategy
          </label>
          <select
            value={parsingStrategy}
            onChange={(e) =>
              setParsingStrategy(e.target.value as ParsingStrategy)
            }
            className="w-full px-3 py-2 border rounded-md text-sm border-gray-300
                       focus:outline-none focus:ring-2 focus:ring-indigo-500"
          >
            <option value="north_gc">
              North Gold Coast Seahawks — "Warriors 16B.2"
            </option>
            <option value="gold_coast">
              Gold Coast Association — "12BC3 Amigos White"
            </option>
          </select>
        </div>

        <div className="flex gap-3">
          <button
            onClick={handlePreview}
            disabled={loading || !file}
            className={`px-4 py-2 rounded-md text-sm font-semibold text-white
                        ${
                          loading || !file
                            ? "bg-indigo-300 cursor-not-allowed"
                            : "bg-indigo-600 hover:bg-indigo-700"
                        }`}
          >
            {loading ? "Working..." : "Preview Import"}
          </button>
          <button
            onClick={handleCommit}
            disabled={loading || previewRows.length === 0}
            className={`px-4 py-2 rounded-md text-sm font-semibold text-white
                        ${
                          loading || previewRows.length === 0
                            ? "bg-gray-300 cursor-not-allowed"
                            : "bg-emerald-600 hover:bg-emerald-700"
                        }`}
          >
            Commit Import
          </button>
        </div>

        {skippedCount > 0 && (
          <div className="text-xs text-gray-500 bg-gray-50 border border-gray-200 rounded-md px-3 py-2">
            {skippedCount} row{skippedCount !== 1 ? "s" : ""} skipped — playing
            ≠ 1 (did not participate this round).
          </div>
        )}

        {newClubNames.length > 0 && (
          <div className="text-sm text-amber-700 bg-amber-50 border border-amber-200 rounded-md px-3 py-2">
            <strong>{newClubNames.length} new club(s)</strong> not yet in
            database — will be auto-created as non-client on commit:{" "}
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
                <th className="text-left px-2 py-1 border-b">Team Label</th>
                <th className="text-left px-2 py-1 border-b">Age Group</th>
                <th className="text-left px-2 py-1 border-b">Shirt #</th>
              </tr>
            </thead>
            <tbody>
              {previewRows.map((row, idx) => (
                <tr
                  key={idx}
                  className={`odd:bg-white even:bg-gray-50 ${
                    row.isNewClub ? "text-amber-700" : ""
                  }`}
                >
                  <td className="px-2 py-1 border-b font-mono text-gray-500">
                    {row.bcPlayerId || "—"}
                  </td>
                  <td className="px-2 py-1 border-b">
                    {row.clubName}
                    {row.isNewClub && (
                      <span className="ml-1 text-xs bg-amber-100 text-amber-700 px-1 rounded">
                        new
                      </span>
                    )}
                  </td>
                  <td className="px-2 py-1 border-b">{row.firstName}</td>
                  <td className="px-2 py-1 border-b">{row.lastName}</td>
                  <td className="px-2 py-1 border-b font-mono">
                    {row.teamCode ?? "—"}
                  </td>
                  <td className="px-2 py-1 border-b">{row.teamLabel ?? "—"}</td>
                  <td className="px-2 py-1 border-b">{row.ageGroup}</td>
                  <td className="px-2 py-1 border-b">
                    {row.finalShirt !== null ? row.finalShirt : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
};

export default Importer;
