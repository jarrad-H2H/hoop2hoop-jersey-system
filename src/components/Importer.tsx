// FILE: src/components/Importer.tsx
import React, { useState, ChangeEvent } from "react";
import { supabase } from "../services/supabase";

type ParsingStrategy = "north_gc" | "gold_coast";

interface RawRow {
  [key: string]: string;
}

interface PreviewRow {
  clubName: string;
  clubId: string; // uuid
  firstName: string;
  lastName: string;
  teamRaw: string;
  teamCode: string | null;
  teamLabel: string | null;
  ageGroup: string;
  divisionGrade: string;
  finalShirt: number;
  competitionSource: string;
}

const Importer: React.FC = () => {
  const [file, setFile] = useState<File | null>(null);
  const [parsingStrategy, setParsingStrategy] =
    useState<ParsingStrategy>("north_gc");
  const [competitionSource, setCompetitionSource] = useState("");
  const [previewRows, setPreviewRows] = useState<PreviewRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const handleFileChange = (e: ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0] ?? null;
    setFile(f);
    setPreviewRows([]);
    setStatusMessage(null);
    setErrorMessage(null);
  };

  const parseCsv = (text: string): RawRow[] => {
    const lines = text
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l.length > 0);

    if (lines.length < 2) return [];

    const header = lines[0].split(",").map((h) => h.trim());
    const rows: RawRow[] = [];

    for (let i = 1; i < lines.length; i++) {
      const cols = lines[i].split(",").map((c) => c.trim());
      if (cols.length === 1 && cols[0] === "") continue;

      const row: RawRow = {};
      header.forEach((key, idx) => {
        row[key] = cols[idx] ?? "";
      });
      rows.push(row);
    }

    return rows;
  };

  const deriveTeamFields = (
    teamRaw: string,
    strategy: ParsingStrategy
  ): { clubName: string; teamCode: string | null; teamLabel: string | null } => {
    const parts = teamRaw.split(" ").filter(Boolean);

    if (strategy === "north_gc") {
      // Example: "Warriors 16B.2"
      // clubName = "Warriors"
      // teamCode = "16B.2"
      const clubName = parts[0] ?? "";
      const teamCode = parts.slice(1).join(" ") || null;
      return { clubName, teamCode, teamLabel: null };
    }

    // strategy === "gold_coast"
    // Example: "12BC3 Amigos White"
    // teamCode = "12BC3"
    // clubName = "Amigos"
    // teamLabel = "White"
    const teamCode = parts[0] ?? "";
    const clubName = parts[1] ?? "";
    const teamLabel = parts.slice(2).join(" ") || null;

    return { clubName, teamCode: teamCode || null, teamLabel };
  };

  const handlePreview = async () => {
    setStatusMessage(null);
    setErrorMessage(null);

    if (!file) {
      setErrorMessage("Please select a CSV file first.");
      return;
    }
    if (!competitionSource.trim()) {
      setErrorMessage("Please enter a competition source label.");
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

      // Map raw rows to provisional preview rows (without clubId yet)
      const provisional: Omit<PreviewRow, "clubId">[] = rawRows.map((row) => {
        const teamRaw = row["Played For (Team)"] || row["playedForTeam"] || row["played for team"] || "";
        const { clubName, teamCode, teamLabel } = deriveTeamFields(
          teamRaw,
          parsingStrategy
        );

        const finalShirt = Number(row["finalShirt"] ?? row["FinalShirt"] ?? 0);

        return {
          clubName,
          firstName: row["First Name"] ?? row["FirstName"] ?? "",
          lastName: row["Last Name"] ?? row["LastName"] ?? "",
          teamRaw,
          teamCode,
          teamLabel,
          ageGroup: row["playerDivisionName"] ?? "",
          divisionGrade: row["playerDivisionGrade"] ?? "",
          finalShirt: Number.isFinite(finalShirt) ? finalShirt : 0,
          competitionSource: competitionSource.trim(),
        };
      });

      // Collect unique club names
      const uniqueClubNames = Array.from(
        new Set(
          provisional
            .map((r) => r.clubName.trim())
            .filter((name) => name.length > 0)
        )
      );

      if (uniqueClubNames.length === 0) {
        setErrorMessage("No club names could be derived from the Team field.");
        setLoading(false);
        return;
      }

      // Fetch matching clubs in one query
      const { data: clubsData, error: clubsError } = await supabase
        .from("clubs")
        .select("id, name")
        .in("name", uniqueClubNames);

      if (clubsError) {
        console.error("Error loading clubs:", clubsError);
        setErrorMessage("Failed to load clubs from database.");
        setLoading(false);
        return;
      }

      const clubMap = new Map<string, string>(); // clubName -> clubId
      (clubsData ?? []).forEach((c) => {
        clubMap.set(c.name, c.id);
      });

      // Deduplicate rows per: clubId + firstName + lastName + teamCode
      const dedupMap = new Map<string, PreviewRow>();

      for (const row of provisional) {
        const clubId = clubMap.get(row.clubName);
        if (!clubId) {
          // Skip rows where the club isn't configured yet
          continue;
        }

        // Use teamCode if available, otherwise fall back to full teamRaw,
// so players can appear once per distinct team.
const teamKey = (row.teamCode ?? row.teamRaw).toLowerCase();

const key = [
  clubId,
  row.firstName.toLowerCase(),
  row.lastName.toLowerCase(),
  teamKey,
].join("|");

        const existing = dedupMap.get(key);

        if (!existing) {
          dedupMap.set(key, { ...row, clubId });
        } else {
          // Dedup rule: prefer non-zero finalShirt
          if (existing.finalShirt === 0 && row.finalShirt !== 0) {
            dedupMap.set(key, { ...row, clubId });
          } else {
            // If both non-zero, keep the latest row (current one)
            if (row.finalShirt !== 0) {
              dedupMap.set(key, { ...row, clubId });
            }
          }
        }
      }

      const dedupedArray = Array.from(dedupMap.values());

      if (dedupedArray.length === 0) {
        setErrorMessage(
          "After matching clubs and deduplicating, no rows remain. Check that club names in CSV match the 'name' field in your clubs table."
        );
        setLoading(false);
        return;
      }

      setPreviewRows(dedupedArray);
      setStatusMessage(
        `Preview ready: ${dedupedArray.length} unique player rows.`
      );
    } catch (err: any) {
      console.error("Error during preview:", err);
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
      // Build payload for players table
      const payload = previewRows.map((r) => ({
        club_id: r.clubId,
        first_name: r.firstName,
        last_name: r.lastName,
        team_id: r.teamCode ?? r.teamRaw, // using teamCode as team_id
        final_shirt: r.finalShirt || null,
      }));

      const { error: insertError } = await supabase
        .from("players")
        .insert(payload);

      if (insertError) {
        console.error("Error inserting players:", insertError);
        setErrorMessage("Failed to insert players into database.");
        setLoading(false);
        return;
      }

      setStatusMessage(
        `Successfully inserted ${payload.length} players into the database.`
      );
      setPreviewRows([]);
    } catch (err: any) {
      console.error("Error during commit:", err);
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
          Import Basketball Connect exports and map them into the{" "}
          <code>players</code> table.
        </p>
      </div>

      <div className="bg-white rounded-xl shadow p-6 max-w-2xl space-y-4">
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">
            CSV File (Basketball Connect export)
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
            Competition Source (e.g. "NGC Seahawks", "Gold Coast")
          </label>
          <input
            type="text"
            value={competitionSource}
            onChange={(e) => setCompetitionSource(e.target.value)}
            className="w-full px-3 py-2 border rounded-md text-sm border-gray-300 
                       focus:outline-none focus:ring-2 focus:ring-indigo-500"
          />
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
              North Gold Coast Seahawks (e.g. "Warriors 16B.2")
            </option>
            <option value="gold_coast">
              Gold Coast (e.g. "12BC3 Amigos White")
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
                <th className="text-left px-2 py-1 border-b">Club</th>
                <th className="text-left px-2 py-1 border-b">First</th>
                <th className="text-left px-2 py-1 border-b">Last</th>
                <th className="text-left px-2 py-1 border-b">Team Code</th>
                <th className="text-left px-2 py-1 border-b">Team Label</th>
                <th className="text-left px-2 py-1 border-b">Age Group</th>
                <th className="text-left px-2 py-1 border-b">Grade</th>
                <th className="text-left px-2 py-1 border-b">Final Shirt</th>
              </tr>
            </thead>
            <tbody>
              {previewRows.map((row, idx) => (
                <tr key={idx} className="odd:bg-white even:bg-gray-50">
                  <td className="px-2 py-1 border-b">{row.clubName}</td>
                  <td className="px-2 py-1 border-b">{row.firstName}</td>
                  <td className="px-2 py-1 border-b">{row.lastName}</td>
                  <td className="px-2 py-1 border-b">{row.teamCode}</td>
                  <td className="px-2 py-1 border-b">{row.teamLabel}</td>
                  <td className="px-2 py-1 border-b">{row.ageGroup}</td>
                  <td className="px-2 py-1 border-b">{row.divisionGrade}</td>
                  <td className="px-2 py-1 border-b">{row.finalShirt}</td>
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
