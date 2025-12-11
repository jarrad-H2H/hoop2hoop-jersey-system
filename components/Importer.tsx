// FILE: src/components/Importer.tsx
import React, { useEffect, useState } from "react";
import { supabase } from "../services/supabase";
import * as XLSX from "xlsx";

type ParsingStrategy = "north_gc" | "gold_coast";

interface Club {
  id: string;
  name: string;
  is_client: boolean;
  aliases: string[] | null;
}

interface ParsedRow {
  external_id: string;        // from "Player Id" or "User ID"
  first_name: string;
  last_name: string;
  team_raw: string;           // raw team string from file
  club_name_raw: string;      // parsed club name token
  club_id: string | null;     // matched club_id (clients only)
  team_id: string;            // team identifier we store on players.team_id
  final_shirt: number | null; // jersey number (0 / null = unknown)
}

interface PreviewPlayer {
  first_name: string;
  last_name: string;
  team_id: string;
  club_id: string;
  final_shirt: number | null;
}

const Importer: React.FC = () => {
  const [clubs, setClubs] = useState<Club[]>([]);
  const [parsingStrategy, setParsingStrategy] =
    useState<ParsingStrategy>("north_gc"); // default: Warriors 16B.2

  const [rawRowCount, setRawRowCount] = useState<number>(0);
  const [parsedRows, setParsedRows] = useState<ParsedRow[]>([]);
  const [previewPlayers, setPreviewPlayers] = useState<PreviewPlayer[]>([]);
  const [skippedRows, setSkippedRows] = useState<ParsedRow[]>([]);

  const [loading, setLoading] = useState(false);
  const [committing, setCommitting] = useState(false);
  const [statusMessage, setStatusMessage] = useState<string>("");
  const [error, setError] = useState<string | null>(null);

  // Load clubs so we can map club names/aliases
  useEffect(() => {
    const loadClubs = async () => {
      const { data, error } = await supabase
        .from("clubs")
        .select("id, name, is_client, aliases")
        .order("name", { ascending: true });

      if (error) {
        console.error("Failed to load clubs", error);
        setError("Failed to load clubs from database.");
        return;
      }

      setClubs(
        (data ?? []).map((c: any) => ({
          id: c.id,
          name: c.name,
          is_client: c.is_client ?? false,
          aliases: c.aliases ?? null,
        }))
      );
    };

    loadClubs();
  }, []);

  // Utility: normalise strings for matching
  const normalise = (value: string | null | undefined): string =>
    (value ?? "").trim().toLowerCase();

  // Try to match a parsed club name to a client club (by name or alias)
  const resolveClubId = (nameRaw: string): string | null => {
    const needle = normalise(nameRaw);
    if (!needle) return null;

    for (const club of clubs) {
      if (!club.is_client) continue;

      const main = normalise(club.name);
      if (needle === main) return club.id;

      if (club.aliases) {
        for (const alias of club.aliases) {
          if (normalise(alias) === needle) {
            return club.id;
          }
        }
      }
    }

    return null;
  };

  // Helper to find header index for any of a list of possible names
  const findAnyIndex = (headerRow: string[], names: string[]) => {
    const lowered = headerRow.map((h) => h.toLowerCase());
    for (const candidate of names) {
      const idx = lowered.indexOf(candidate.toLowerCase());
      if (idx !== -1) return idx;
    }
    return -1;
  };

  // Parsing strategy: how to split the team name string into club + team_id
  const parseTeamString = (
    rawTeam: string,
    strategy: ParsingStrategy
  ): { clubName: string; teamId: string } => {
    const trimmed = rawTeam.trim();
    if (!trimmed) {
      return { clubName: "", teamId: "" };
    }

    const parts = trimmed.split(/\s+/);

    // North Gold Coast competition (e.g. "Warriors 16B.2"):
    // - Club name = FIRST word
    // - Team ID = full string
    if (strategy === "north_gc") {
      const clubName = parts[0] || "";
      return {
        clubName,
        teamId: trimmed,
      };
    }

    // Gold Coast competition (e.g. "12BC3 Amigos White"):
    // - Age/div = first token
    // - Club = second token ("Amigos")
    // - TeamId = full string
    if (strategy === "gold_coast") {
      const clubName = parts[1] || "";
      return {
        clubName,
        teamId: trimmed,
      };
    }

    // Fallback: treat full string as teamId, unknown club
    return {
      clubName: "",
      teamId: trimmed,
    };
  };

  // Handle file upload (CSV or XLS/XLSX)
  const handleFileUpload = async (
    e: React.ChangeEvent<HTMLInputElement>
  ) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setError(null);
    setStatusMessage("");
    setParsedRows([]);
    setPreviewPlayers([]);
    setSkippedRows([]);
    setRawRowCount(0);

    setLoading(true);

    try {
      const ext = file.name.split(".").pop()?.toLowerCase();

      if (ext === "csv") {
        const text = await file.text();
        parseCSV(text);
      } else if (ext === "xls" || ext === "xlsx") {
        const buffer = await file.arrayBuffer();
        const workbook = XLSX.read(buffer, { type: "array" });
        const sheetName = workbook.SheetNames[0];
        const worksheet = workbook.Sheets[sheetName];
        const rows = XLSX.utils.sheet_to_json<any[]>(worksheet, {
          header: 1,
          blankrows: false,
        }) as any[][];

        parseRows(rows);
      } else {
        setError("Unsupported file type. Please upload CSV, XLS, or XLSX.");
      }
    } catch (err: any) {
      console.error(err);
      setError(err.message ?? "Failed to read file.");
    } finally {
      setLoading(false);
    }
  };

  // Parse CSV text into row arrays
  const parseCSV = (text: string) => {
    // Basic CSV splitter (assumes no commas inside fields)
    const lines = text
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l.length > 0);

    const rows: string[][] = lines.map((line) =>
      line.split(",").map((cell) => cell.trim())
    );

    parseRows(rows);
  };

  // Core row parsing (both CSV + XLS go through here)
  const parseRows = (rows: any[][]) => {
    if (!rows.length) {
      setError("No data rows found in file.");
      return;
    }

    const headerRow = rows[0].map((h) => String(h ?? "").trim());
    const dataRows = rows.slice(1);

    // Base columns
    const idxFinalShirt = findAnyIndex(headerRow, ["finalShirt"]);
    const idxFirstName = findAnyIndex(headerRow, ["First Name", "FirstName"]);
    const idxLastName = findAnyIndex(headerRow, ["Last Name", "LastName"]);

    // Team-related columns (try multiple Basketball Connect variants)
    const idxTeamGeneric = findAnyIndex(headerRow, [
      "playedForTeam",
      "Played For (Team)",
      "Team",
    ]);

    // External ID columns
    const idxPlayerId = findAnyIndex(headerRow, ["Player Id", "PlayerID"]);
    const idxUserId = findAnyIndex(headerRow, ["User ID", "UserID"]);

    if (
      idxFinalShirt === -1 ||
      idxTeamGeneric === -1 ||
      idxFirstName === -1 ||
      idxLastName === -1
    ) {
      setError(
        "File headers not recognised. Make sure this is a Basketball Connect export with 'finalShirt', 'Team' (or 'Played For (Team)' / 'playedForTeam'), and 'First Name' / 'Last Name' columns."
      );
      return;
    }

    const parsed: ParsedRow[] = [];
    const skipped: ParsedRow[] = [];

    dataRows.forEach((rowRaw) => {
      const row = (rowRaw ?? []) as any[];

      const finalShirtRaw = row[idxFinalShirt];
      const finalShirtNum = parseInt(finalShirtRaw, 10);
      const final_shirt =
        Number.isNaN(finalShirtNum) || finalShirtNum === 0
          ? null
          : finalShirtNum;

      const teamRaw = String(row[idxTeamGeneric] ?? "").trim();
      const first_name = String(row[idxFirstName] ?? "").trim();
      const last_name = String(row[idxLastName] ?? "").trim();

      if (!teamRaw || !first_name || !last_name) {
        return; // skip incomplete row
      }

      // external id: prefer Player Id, fallback to User ID, then name combo
      let external_id = "";
      if (idxPlayerId !== -1 && row[idxPlayerId]) {
        external_id = String(row[idxPlayerId]).trim();
      } else if (idxUserId !== -1 && row[idxUserId]) {
        external_id = String(row[idxUserId]).trim();
      } else {
        external_id = `${first_name}_${last_name}`;
      }

      const { clubName, teamId } = parseTeamString(
        teamRaw,
        parsingStrategy
      );

      const club_id = clubName ? resolveClubId(clubName) : null;

      const parsedRow: ParsedRow = {
        external_id,
        first_name,
        last_name,
        team_raw: teamRaw,
        club_name_raw: clubName,
        club_id,
        team_id: teamId,
        final_shirt,
      };

      if (!club_id) {
        skipped.push(parsedRow);
      } else {
        parsed.push(parsedRow);
      }
    });

    setRawRowCount(dataRows.length);
    setParsedRows(parsed);
    setSkippedRows(skipped);

    if (!parsed.length) {
      setStatusMessage(
        "No client clubs could be matched from the team names. Check the parsing strategy (North GC vs Gold Coast) and club aliases."
      );
    } else {
      buildPreview(parsed);
    }
  };

  // Deduplicate per (external_id + team_id), prioritising non-zero finalShirt
  const buildPreview = (rows: ParsedRow[]) => {
    const map = new Map<string, ParsedRow>();

    rows.forEach((row) => {
      if (!row.club_id) return; // safety

      const key = `${row.external_id}::${row.team_id}`;
      const existing = map.get(key);

      if (!existing) {
        map.set(key, row);
      } else {
        const existingNum = existing.final_shirt ?? 0;
        const newNum = row.final_shirt ?? 0;

        if (existingNum === 0 && newNum > 0) {
          map.set(key, row);
        }
        // otherwise keep existing
      }
    });

    const players: PreviewPlayer[] = Array.from(map.values())
      .filter((r) => r.club_id !== null)
      .map((r) => ({
        first_name: r.first_name,
        last_name: r.last_name,
        team_id: r.team_id,
        club_id: r.club_id as string,
        final_shirt: r.final_shirt,
      }));

    setPreviewPlayers(players);
    setStatusMessage(
      `Parsed ${rows.length} rows → ${players.length} unique player-team allocations (client clubs only).`
    );
  };

  const handleCommit = async () => {
    if (!previewPlayers.length) {
      setError("No parsed rows to import.");
      return;
    }

    setError(null);
    setStatusMessage("");
    setCommitting(true);

    try {
      const { error } = await supabase.from("players").insert(
        previewPlayers.map((p) => ({
          first_name: p.first_name,
          last_name: p.last_name,
          team_id: p.team_id,
          club_id: p.club_id,
          final_shirt: p.final_shirt,
        }))
      );

      if (error) {
        console.error("Insert error", error);
        setError("Failed to commit player data to database.");
        return;
      }

      setStatusMessage(
        `Successfully imported ${previewPlayers.length} player records.`
      );
    } catch (err: any) {
      console.error(err);
      setError(err.message ?? "Commit failed.");
    } finally {
      setCommitting(false);
    }
  };

  return (
    <div>
      <h1 className="text-2xl font-bold mb-4">CSV / XLS Importer</h1>
      <p className="text-sm text-gray-600 mb-4">
        Upload a Basketball Connect export, parse it into player allocations,
        and import into the multi-tenant players table. Only clubs marked as
        clients (is_client = true) will be imported.
      </p>

      {/* Parsing strategy */}
      <div className="mb-4 space-y-2 max-w-md">
        <label className="block text-sm font-semibold mb-1">
          Parsing Strategy
        </label>
        <select
          value={parsingStrategy}
          onChange={(e) =>
            setParsingStrategy(e.target.value as ParsingStrategy)
          }
          className="w-full border p-2 rounded"
        >
          <option value="north_gc">
            North Gold Coast – e.g. "Warriors 16B.2" (club = first word)
          </option>
          <option value="gold_coast">
            Gold Coast – e.g. "12BC3 Amigos White" (club = second word)
          </option>
        </select>
      </div>

      {/* File upload */}
      <div className="mb-6 max-w-md">
        <label className="block text-sm font-semibold mb-1">
          Upload file (.csv, .xls, .xlsx)
        </label>
        <input
          type="file"
          accept=".csv, .xls, .xlsx"
          onChange={handleFileUpload}
          className="block w-full text-sm text-gray-900 border border-gray-300 rounded-lg cursor-pointer bg-gray-50 p-2"
        />
        {loading && (
          <p className="text-sm text-gray-500 mt-2">
            Parsing file, please wait...
          </p>
        )}
      </div>

      {/* Status + errors */}
      {error && (
        <div className="mb-4 text-sm text-red-700 bg-red-50 border border-red-200 rounded p-3">
          {error}
        </div>
      )}
      {statusMessage && (
        <div className="mb-4 text-sm text-indigo-700 bg-indigo-50 border border-indigo-200 rounded p-3">
          {statusMessage}
        </div>
      )}

      {/* Summary */}
      {rawRowCount > 0 && (
        <div className="mb-4 text-sm text-gray-700">
          <p>Total data rows in file: {rawRowCount}</p>
          <p>Matched to client clubs: {parsedRows.length}</p>
          <p>Skipped (non-client / no match): {skippedRows.length}</p>
        </div>
      )}

      {/* Commit button */}
      {previewPlayers.length > 0 && (
        <div className="mb-4">
          <button
            onClick={handleCommit}
            disabled={committing}
            className="px-4 py-2 bg-emerald-600 text-white rounded disabled:bg-gray-400"
          >
            {committing ? "Committing..." : "Commit Import to Players Table"}
          </button>
        </div>
      )}

      {/* Simple preview table */}
      {previewPlayers.length > 0 && (
        <div className="mt-4">
          <h2 className="font-semibold mb-2 text-sm">
            Preview (first 50 rows)
          </h2>
          <div className="overflow-x-auto border rounded">
            <table className="min-w-full text-xs">
              <thead className="bg-gray-100">
                <tr>
                  <th className="px-2 py-1 text-left">First Name</th>
                  <th className="px-2 py-1 text-left">Last Name</th>
                  <th className="px-2 py-1 text-left">Team</th>
                  <th className="px-2 py-1 text-left">Club</th>
                  <th className="px-2 py-1 text-left">Number</th>
                </tr>
              </thead>
              <tbody>
                {previewPlayers.slice(0, 50).map((p, idx) => {
                  const club = clubs.find((c) => c.id === p.club_id);
                  return (
                    <tr
                      key={`${p.first_name}-${p.last_name}-${p.team_id}-${idx}`}
                      className={idx % 2 === 0 ? "bg-white" : "bg-gray-50"}
                    >
                      <td className="px-2 py-1">{p.first_name}</td>
                      <td className="px-2 py-1">{p.last_name}</td>
                      <td className="px-2 py-1">{p.team_id}</td>
                      <td className="px-2 py-1">{club?.name ?? "Unknown"}</td>
                      <td className="px-2 py-1">
                        {p.final_shirt ?? "—"}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Skipped summary */}
      {skippedRows.length > 0 && (
        <div className="mt-6">
          <h2 className="font-semibold mb-2 text-sm">
            Skipped rows (no client-club match)
          </h2>
          <p className="text-xs text-gray-500 mb-2">
            Example: first 10 skipped rows (for debugging aliases / naming).
          </p>
          <div className="overflow-x-auto border rounded">
            <table className="min-w-full text-xs">
              <thead className="bg-gray-100">
                <tr>
                  <th className="px-2 py-1 text-left">First Name</th>
                  <th className="px-2 py-1 text-left">Last Name</th>
                  <th className="px-2 py-1 text-left">Team Raw</th>
                  <th className="px-2 py-1 text-left">Club Parsed</th>
                </tr>
              </thead>
              <tbody>
                {skippedRows.slice(0, 10).map((r, idx) => (
                  <tr
                    key={`${r.external_id}-${idx}`}
                    className={idx % 2 === 0 ? "bg-white" : "bg-gray-50"}
                  >
                    <td className="px-2 py-1">{r.first_name}</td>
                    <td className="px-2 py-1">{r.last_name}</td>
                    <td className="px-2 py-1">{r.team_raw}</td>
                    <td className="px-2 py-1">{r.club_name_raw}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
};

export default Importer;
