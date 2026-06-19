// FILE: src/components/Importer.tsx
import React, { useState, useEffect, ChangeEvent } from "react";
import { supabase } from "../services/supabase";

type ParsingStrategy = "north_gc" | "gold_coast";
type ImportMode = "upsert" | "replace";

interface Competition {
  id: string;
  name: string;
}

interface RawRow {
  [key: string]: string;
}

interface ParsedPlayer {
  bcPlayerId: string;
  firstName: string;
  lastName: string;
  clubName: string;
  teamRaw: string;
  divisionCode: string | null;   // e.g. "JGC1", "16BC2"
  teamName: string | null;       // e.g. "BLAZES", "FLAMES"
  ageGroup: string;              // normalised: U10/U12/U14/U16/U18/U20/SLG
  ageGroupRaw: string;           // raw BC value
  divisionGrade: string;
  finalShirt: number | null;
  borrowingDivision: string | null;
  isBorrowed: boolean;
  playing: string;
}

interface PreviewRow extends ParsedPlayer {
  clubId: string | null;
  isNewClub: boolean;
}

// ─── Age group normalisation ──────────────────────────────────────────────────
function normalizeAgeGroup(raw: string): string {
  const s = (raw ?? "").trim().toUpperCase();
  const underMatch = s.match(/^UNDER\s+(\d+)/);
  if (underMatch) return `U${underMatch[1]}`;
  const uMatch = s.match(/^U(\d+)/);
  if (uMatch) return `U${uMatch[1]}`;
  if (s.startsWith("JUNIOR")) return "Junior";          // "Junior" age group (not U14)
  if (/SUPERLEA[GU]/i.test(s)) return "SLG";           // Super League Girls only
  if (/^OPEN\s+GIRLS?/i.test(s)) return "Open Girls";  // Open Girls competition
  if (/^OPEN/i.test(s)) return "Open";                 // Other Open divisions
  if (/^SENIOR/i.test(s)) return "Seniors";            // Senior / adult
  return raw.trim();
}

// ─── Gender from division code + raw age group string ────────────────────────
// Returns 'Male' | 'Female' | 'Mixed' | null (unknown)
function parseGenderFromDivision(
  divisionCode: string | null,
  ageGroupRaw: string
): string | null {
  const s = `${divisionCode ?? ""} ${ageGroupRaw}`.toUpperCase();
  if (/MIXED|MIX(\b|$)|\bJMC\b/.test(s)) return "Mixed";
  // Female: digit followed by G (e.g. "16G", "10G"), or keyword
  if (/\d+G[\W._]|\d+G$|\bJGC?\b|GIRL|FEMALE|WOMEN/.test(s)) return "Female";
  // Male: digit followed by B (e.g. "16B", "10B"), or keyword
  if (/\d+B[\W._]|\d+B$|\bJBC?\b|BOY|\bMALE\b|\bMEN\b/.test(s)) return "Male";
  return null;
}

// ─── Age group from division code (for teams table) ──────────────────────────
// Extracts "U16" from "16B.2", "U10" from "10G.1", etc.
function parseAgeGroupFromCode(divisionCode: string | null): string | null {
  if (!divisionCode) return null;
  const numMatch = divisionCode.match(/^(\d{1,2})[A-Z]/);
  if (numMatch) return `U${numMatch[1]}`;
  const uMatch = divisionCode.match(/^U(\d{1,2})/i);
  if (uMatch) return `U${uMatch[1]}`;
  if (/^(JB|JG|JMC|JGC|JBC)/i.test(divisionCode)) return "Junior";
  if (/^OGC/i.test(divisionCode)) return "Open Girls"; // Open Girls (e.g. OGC1, OGC2)
  if (/^SLG/i.test(divisionCode)) return "SLG";        // Super League Girls
  return null;
}

// ─── Dedup priority score ─────────────────────────────────────────────────────
function dedupScore(p: ParsedPlayer): number {
  let score = 0;
  if (p.finalShirt === null) score += 100;
  if (p.isBorrowed) score += 10;
  if (p.playing !== "1") score += 1;
  return score;
}

// ─── YOB range estimation from age group ─────────────────────────────────────
// Returns estimated birth year range for clash-window calculations.
// min = oldest possible birth year, max = youngest possible birth year.
// Derived dynamically from competition year — never hardcoded year constants.
function estimateYobRange(
  ageGroup: string,
  competitionYear: number
): { min: number | null; max: number | null } {
  switch (ageGroup) {
    case "U8":   return { min: competitionYear - 7,  max: competitionYear - 5  }; // ages 5–7
    case "U10":  return { min: competitionYear - 9,  max: competitionYear - 8  }; // ages 8–9
    case "U12":  return { min: competitionYear - 11, max: competitionYear - 10 }; // ages 10–11
    case "U14":  return { min: competitionYear - 13, max: competitionYear - 12 }; // ages 12–13
    case "U16":  return { min: competitionYear - 15, max: competitionYear - 14 }; // ages 14–15
    case "U18":  return { min: competitionYear - 17, max: competitionYear - 16 }; // ages 16–17
    case "Open":
    case "Open Girls":
    case "Seniors":
    case "SLG":  return { min: competitionYear - 99, max: competitionYear - 18 }; // 18+
    case "Junior": return { min: null, max: null }; // TBD — awaiting GCB confirmation
    default:     return { min: null, max: null };
  }
}

// ─── Club name overrides ──────────────────────────────────────────────────────
const CLUB_NAME_OVERRIDES: Record<string, string> = {
  VARSTIY: "Varsity",   // typo variant
  VARSITY: "Varsity",   // all-caps variant
  COPPERHEADS: "Varsity",
  "KING'S": "King's",  // case variants
};

function normalizeClubName(raw: string): string {
  const upper = raw.trim().toUpperCase();
  return CLUB_NAME_OVERRIDES[upper] ?? raw.trim();
}

// ─── Multi-word club prefixes ─────────────────────────────────────────────────
const MULTI_WORD_CLUB_PREFIXES: string[] = [
  "EMMANUEL COLLEGE",
  "GOLD COAST BASKETBALL",
  "NORTH GOLD COAST SEAHAWKS",
];

function matchMultiWordClub(raw: string): [string, string] | null {
  const upper = raw.trim().toUpperCase();
  for (const prefix of MULTI_WORD_CLUB_PREFIXES) {
    if (upper === prefix || upper.startsWith(prefix + " ")) {
      const club = raw.trim().slice(0, prefix.length);
      const rest = raw.trim().slice(prefix.length).trim();
      return [club, rest];
    }
  }
  return null;
}

// ─── Team field parsing ───────────────────────────────────────────────────────
function looksLikeTeamCode(token: string): boolean {
  return /^(\d{1,2}|[JOS])[A-Z]{1,2}\d/i.test(token);
}

function deriveTeamFields(
  teamRaw: string,
  strategy: ParsingStrategy
): { clubName: string; divisionCode: string | null; teamName: string | null } {
  const trimmed = teamRaw.trim();
  const parts = trimmed.split(/\s+/).filter(Boolean);

  if (parts.length === 0) return { clubName: "", divisionCode: null, teamName: null };

  if (strategy === "north_gc") {
    const clubName = parts[0] ?? "";
    const divisionCode = parts.slice(1).join(" ") || null;
    return { clubName, divisionCode, teamName: null };
  }

  if (looksLikeTeamCode(parts[0])) {
    const divisionCode = parts[0];
    const remainder = parts.slice(1).join(" ");
    const multi = matchMultiWordClub(remainder);
    if (multi) {
      const [clubName, teamRest] = multi;
      return { clubName, divisionCode, teamName: teamRest || null };
    }
    const clubName = parts[1] ?? "";
    const teamName = parts.slice(2).join(" ") || null;
    return { clubName, divisionCode, teamName };
  } else {
    const multi = matchMultiWordClub(trimmed);
    if (multi) {
      const [clubName, teamRest] = multi;
      return { clubName, divisionCode: null, teamName: teamRest || null };
    }
    const clubName = parts[0] ?? "";
    const teamName = parts.slice(1).join(" ") || null;
    return { clubName, divisionCode: null, teamName };
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
    header.forEach((key, idx) => { row[key] = (cols[idx] ?? "").trim(); });
    rows.push(row);
  }
  return rows;
}

// ─── Component ────────────────────────────────────────────────────────────────
const Importer: React.FC = () => {
  const [file, setFile] = useState<File | null>(null);
  const [parsingStrategy, setParsingStrategy] = useState<ParsingStrategy>("north_gc");
  const [importMode, setImportMode] = useState<ImportMode>("upsert");

  // Competition selector
  const [competitions, setCompetitions] = useState<Competition[]>([]);
  const [selectedCompetitionId, setSelectedCompetitionId] = useState<string>("");
  const [newCompetitionName, setNewCompetitionName] = useState<string>("");
  const [loadingCompetitions, setLoadingCompetitions] = useState(false);

  const [previewRows, setPreviewRows] = useState<PreviewRow[]>([]);
  const [newClubNames, setNewClubNames] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const [resetConfirm, setResetConfirm] = useState("");
  const [resetLoading, setResetLoading] = useState(false);
  const [resetStatus, setResetStatus] = useState<string | null>(null);
  const [resetError, setResetError] = useState<string | null>(null);

  // Derived: is the user creating a new competition?
  const isCreatingNew = selectedCompetitionId === "__new__";

  // Derived: the competition name for labelling (used as competition_source on players)
  const competitionLabel = isCreatingNew
    ? newCompetitionName.trim()
    : (competitions.find((c) => c.id === selectedCompetitionId)?.name ?? "");

  // ── Load competitions on mount ──────────────────────────────────────────────
  useEffect(() => {
    const load = async () => {
      setLoadingCompetitions(true);
      const { data, error } = await supabase
        .from("competitions")
        .select("id, name")
        .order("name", { ascending: true });
      if (!error) setCompetitions((data ?? []) as Competition[]);
      setLoadingCompetitions(false);
    };
    void load();
  }, []);

  const handleFileChange = (e: ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0] ?? null;
    setFile(f);
    setPreviewRows([]);
    setNewClubNames([]);
    setStatusMessage(null);
    setErrorMessage(null);
  };

  // ── Validate competition selection ─────────────────────────────────────────
  const validateCompetition = (): boolean => {
    if (!selectedCompetitionId) {
      setErrorMessage("Please select a competition or choose 'Create new'.");
      return false;
    }
    if (isCreatingNew && !newCompetitionName.trim()) {
      setErrorMessage("Please enter a name for the new competition.");
      return false;
    }
    return true;
  };

  // ── Preview ────────────────────────────────────────────────────────────────
  const handlePreview = async () => {
    setStatusMessage(null);
    setErrorMessage(null);
    setPreviewRows([]);
    setNewClubNames([]);

    if (!file) { setErrorMessage("Please select a CSV file first."); return; }
    if (!validateCompetition()) return;

    setLoading(true);
    try {
      const text = await file.text();
      const rawRows = parseCsv(text);

      if (rawRows.length === 0) {
        setErrorMessage("No data rows found in CSV.");
        return;
      }

      const seenBcIds = new Map<string, ParsedPlayer>();
      const noBcIdRows: ParsedPlayer[] = [];

      for (const row of rawRows) {
        const teamRaw = (row["Played For (Team)"] ?? row["playedForTeam"] ?? "").trim();
        const { clubName, divisionCode, teamName } = deriveTeamFields(teamRaw, parsingStrategy);

        const bcPlayerId = (row["Player Id"] ?? row["Player ID"] ?? "").trim();
        const firstName = (row["First Name"] ?? row["FirstName"] ?? "").trim();
        const lastName = (row["Last Name"] ?? row["LastName"] ?? "").trim();

        const shirtStr = (row["finalShirt"] ?? row["FinalShirt"] ?? "").trim();
        const shirtNum = shirtStr !== "" ? Number(shirtStr) : NaN;
        const finalShirt = Number.isFinite(shirtNum) ? shirtNum : null;

        const ageGroupRaw = (row["playerDivisionName"] ?? "").trim();
        const ageGroup = normalizeAgeGroup(ageGroupRaw);
        const divisionGrade = (row["playerDivisionGrade"] ?? "").trim();
        const playing = (row["playing"] ?? "").trim();

        const currentDiv = (row["Current Team Division"] ?? "").trim().toUpperCase();
        const borrowingDiv = (row["Borrowing Team Division"] ?? "").trim().toUpperCase();
        const isBorrowed = borrowingDiv.length > 0 && borrowingDiv !== currentDiv;
        const borrowingDivision = isBorrowed
          ? normalizeAgeGroup(row["Borrowing Team Division"] ?? "")
          : null;

        const player: ParsedPlayer = {
          bcPlayerId,
          firstName,
          lastName,
          clubName: normalizeClubName(clubName),
          teamRaw,
          divisionCode,
          teamName,
          ageGroup,
          ageGroupRaw,
          divisionGrade,
          finalShirt,
          borrowingDivision,
          isBorrowed,
          playing,
        };

        if (bcPlayerId) {
          const existing = seenBcIds.get(bcPlayerId);
          if (!existing || dedupScore(player) < dedupScore(existing)) {
            seenBcIds.set(bcPlayerId, player);
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
        setErrorMessage("No player rows found after parsing. Check the CSV format.");
        return;
      }

      const uniqueClubNames = Array.from(
        new Set(parsed.map((r) => r.clubName).filter(Boolean))
      );

      const { data: allClubs, error: clubsError } = await supabase
        .from("clubs")
        .select("id, name");

      if (clubsError) {
        setErrorMessage("Failed to load clubs from database.");
        return;
      }

      const clubMapByLower = new Map<string, { id: string; name: string }>();
      for (const c of allClubs ?? [])
        clubMapByLower.set(c.name.toLowerCase(), { id: c.id, name: c.name });

      const clubMap = new Map<string, string>();
      for (const name of uniqueClubNames) {
        const match = clubMapByLower.get(name.toLowerCase());
        if (match) clubMap.set(name, match.id);
      }

      const newClubs = uniqueClubNames.filter((n) => !clubMap.has(n) && n.length > 0);
      setNewClubNames(newClubs);

      const preview: PreviewRow[] = parsed.map((p) => ({
        ...p,
        clubId: clubMap.get(p.clubName) ?? null,
        isNewClub: newClubs.includes(p.clubName),
      }));

      setPreviewRows(preview);

      const totalRaw = rawRows.length;
      const borrowedCount = preview.filter((r) => r.borrowingDivision).length;
      const noShirtCount = preview.filter((r) => r.finalShirt === null).length;

      // Count unique teams in this import
      const uniqueTeams = new Set(
        preview.map((r) => `${r.clubName}::${r.divisionCode ?? r.teamRaw}`)
      ).size;

      setStatusMessage(
        `Preview ready: ${preview.length} unique players (${totalRaw} raw rows), ` +
          `${uniqueTeams} teams` +
          (borrowedCount > 0 ? `, ${borrowedCount} cross-age borrows` : "") +
          (noShirtCount > 0 ? `, ${noShirtCount} without shirt #` : "") +
          "." +
          (newClubs.length > 0
            ? ` ${newClubs.length} new club(s) will be auto-created.`
            : " All clubs already in database.") +
          (importMode === "replace"
            ? " ⚠ Replace mode: existing players for these clubs will be deleted first."
            : "") +
          ` Competition: "${competitionLabel}".`
      );
    } catch (err: any) {
      setErrorMessage(err.message ?? "Unexpected error during preview.");
    } finally {
      setLoading(false);
    }
  };

  // ── Commit ─────────────────────────────────────────────────────────────────
  const handleCommit = async () => {
    setStatusMessage(null);
    setErrorMessage(null);

    if (previewRows.length === 0) {
      setErrorMessage("No preview rows to commit. Run Preview first.");
      return;
    }
    if (!validateCompetition()) return;

    setLoading(true);
    try {
      // ── Step 1: Resolve competition ID ──────────────────────────────────────
      let competitionId = selectedCompetitionId === "__new__" ? "" : selectedCompetitionId;

      if (isCreatingNew) {
        const name = newCompetitionName.trim();
        const { data: created, error: compErr } = await supabase
          .from("competitions")
          .insert({ name })
          .select("id, name")
          .single();

        if (compErr) {
          setErrorMessage(`Failed to create competition: ${compErr.message}`);
          return;
        }
        competitionId = created.id;
        setCompetitions((prev) => [...prev, { id: created.id, name: created.name }]);
        setSelectedCompetitionId(created.id);
        setNewCompetitionName("");
      }

      const season = competitionLabel; // competition name used as competition_source on players

      // ── Step 2: Resolve clubs (create new if needed) ───────────────────────
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
          return;
        }
        for (const c of created ?? []) clubMap.set(c.name, c.id);
      }

      // ── Step 3: Replace mode — clear existing players ──────────────────────
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
            return;
          }
        }
      }

      // ── Step 4: Upsert players ─────────────────────────────────────────────
      const currentYear = new Date().getFullYear();
      const withBcId = previewRows.filter((r) => r.bcPlayerId);
      if (withBcId.length > 0) {
        const upsertPayload = withBcId.map((r) => {
          const yob = estimateYobRange(r.ageGroup, currentYear);
          return {
            bc_player_id: r.bcPlayerId,
            first_name: r.firstName,
            last_name: r.lastName,
            club_id: clubMap.get(r.clubName) ?? r.clubId ?? null,
            team_id: (r.divisionCode ?? r.teamRaw) || null,
            team_name_raw: r.teamRaw || null,
            division_code: r.divisionCode ?? null,
            team_name: r.teamName ?? null,
            age_group: r.ageGroup || null,
            division_grade: r.divisionGrade || null,
            final_shirt: r.finalShirt ?? null,
            borrowing_division: r.borrowingDivision ?? null,
            competition_source: season,
            bc_last_seen_season: currentYear,        // integer year, not competition name
            estimated_yob_min: yob.min,
            estimated_yob_max: yob.max,
          };
        });

        const { error: upsertErr } = await supabase
          .from("players")
          .upsert(upsertPayload, { onConflict: "bc_player_id", ignoreDuplicates: false });

        if (upsertErr) {
          setErrorMessage(`Player upsert failed: ${upsertErr.message}`);
          return;
        }
      }

      const withoutBcId = previewRows.filter((r) => !r.bcPlayerId);
      if (withoutBcId.length > 0) {
        const insertPayload = withoutBcId.map((r) => {
          const yob = estimateYobRange(r.ageGroup, currentYear);
          return {
            first_name: r.firstName,
            last_name: r.lastName,
            club_id: clubMap.get(r.clubName) ?? r.clubId ?? null,
            team_id: (r.divisionCode ?? r.teamRaw) || null,
            team_name_raw: r.teamRaw || null,
            division_code: r.divisionCode ?? null,
            team_name: r.teamName ?? null,
            age_group: r.ageGroup || null,
            division_grade: r.divisionGrade || null,
            final_shirt: r.finalShirt ?? null,
            borrowing_division: r.borrowingDivision ?? null,
            competition_source: season,
            estimated_yob_min: yob.min,
            estimated_yob_max: yob.max,
          };
        });

        const { error: insertErr } = await supabase.from("players").insert(insertPayload);
        if (insertErr) {
          setErrorMessage(`Player insert failed: ${insertErr.message}`);
          return;
        }
      }

      // ── Step 5: Upsert teams with competition_id, age_group, gender ────────
      // Collect unique (club, divisionCode) combinations from this import.
      type TeamRow = {
        clubId: string;
        divisionCode: string;
        ageGroup: string | null;
        gender: string | null;
      };

      const teamMap = new Map<string, TeamRow>();
      for (const r of previewRows) {
        const clubId = clubMap.get(r.clubName) ?? r.clubId;
        if (!clubId) continue;
        const code = r.divisionCode ?? r.teamName ?? r.teamRaw;
        if (!code) continue;
        const key = `${clubId}::${code}`;
        if (!teamMap.has(key)) {
          teamMap.set(key, {
            clubId,
            divisionCode: code,
            ageGroup: parseAgeGroupFromCode(r.divisionCode) ?? (r.ageGroup || null),
            gender: parseGenderFromDivision(r.divisionCode, r.ageGroupRaw),
          });
        }
      }

      const teamRows = Array.from(teamMap.values());

      if (teamRows.length > 0 && competitionId) {
        // Clear existing teams for these clubs in this competition (fresh import)
        const affectedClubIds = Array.from(new Set(teamRows.map((t) => t.clubId)));

        // Delete teams linked to this competition for affected clubs
        const { error: delTeamsErr } = await supabase
          .from("teams")
          .delete()
          .eq("competition_id", competitionId)
          .in("club_id_uuid", affectedClubIds);

        if (delTeamsErr) {
          console.warn("teams delete warning:", delTeamsErr.message);
          // Non-fatal — continue with insert
        }

        const teamInsertPayload = teamRows.map((t) => ({
          id: `t_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
          club_id: t.clubId, // text FK (legacy)
          club_id_uuid: t.clubId,
          name: t.divisionCode,
          age_group: t.ageGroup ?? "N/A",
          gender: t.gender ?? "Unknown",
          competition_id: competitionId,
        }));

        const { error: teamInsertErr } = await supabase
          .from("teams")
          .insert(teamInsertPayload);

        if (teamInsertErr) {
          console.warn("teams insert warning:", teamInsertErr.message);
          // Non-fatal — players are imported successfully
        }
      }

      // ── Done ───────────────────────────────────────────────────────────────
      const parts: string[] = [];
      if (importMode === "replace") parts.push("existing players cleared");
      if (withBcId.length > 0) parts.push(`${withBcId.length} players upserted`);
      if (withoutBcId.length > 0) parts.push(`${withoutBcId.length} players inserted`);
      if (newClubNames.length > 0) parts.push(`${newClubNames.length} club(s) created`);
      if (teamRows.length > 0) parts.push(`${teamRows.length} teams linked to "${season}"`);

      setStatusMessage("Import complete: " + parts.join(", ") + ".");
      setPreviewRows([]);
      setNewClubNames([]);
    } catch (err: any) {
      setErrorMessage(err.message ?? "Unexpected error during commit.");
    } finally {
      setLoading(false);
    }
  };

  // ── Full data reset ────────────────────────────────────────────────────────
  const handleFullReset = async () => {
    if (resetConfirm !== "RESET") { setResetError("Type RESET to confirm."); return; }
    setResetLoading(true);
    setResetStatus(null);
    setResetError(null);

    try {
      const tables = ["orders", "pending_allocations", "allocations", "inventory", "players", "teams"];
      for (const table of tables) {
        const { error } = await supabase
          .from(table)
          .delete()
          .neq("id", "00000000-0000-0000-0000-000000000000");
        if (error) {
          setResetError(`Failed to clear ${table}: ${error.message}`);
          setResetLoading(false);
          return;
        }
      }
      setResetStatus(
        "All player, inventory, allocation, order, and team data cleared. Clubs, competitions, and settings retained."
      );
      setResetConfirm("");
    } catch (err: any) {
      setResetError(err.message ?? "Unexpected error during reset.");
    } finally {
      setResetLoading(false);
    }
  };

  // ── Render ─────────────────────────────────────────────────────────────────
  return (
    <div className="space-y-8">
      <div>
        <h2 className="text-2xl font-bold mb-2">Game Log Importer</h2>
        <p className="text-gray-600 text-sm">
          Import Basketball Connect game log exports. Players are deduplicated by BC Player ID.
          Teams are linked to the selected competition with parsed age group and gender.
        </p>
      </div>

      <div className="bg-white rounded-xl shadow p-6 max-w-2xl space-y-4">

        {/* CSV file */}
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

        {/* Competition selector */}
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">
            Competition
          </label>
          {loadingCompetitions ? (
            <p className="text-sm text-gray-400">Loading competitions…</p>
          ) : (
            <select
              value={selectedCompetitionId}
              onChange={(e) => {
                setSelectedCompetitionId(e.target.value);
                setNewCompetitionName("");
              }}
              className="w-full px-3 py-2 border rounded-md text-sm border-gray-300
                         focus:outline-none focus:ring-2 focus:ring-indigo-500"
            >
              <option value="">— Select competition —</option>
              {competitions.map((c) => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
              <option value="__new__">+ Create new competition…</option>
            </select>
          )}

          {isCreatingNew && (
            <input
              type="text"
              value={newCompetitionName}
              onChange={(e) => setNewCompetitionName(e.target.value)}
              placeholder="e.g. Gold Coast Basketball 2026 Summer"
              className="mt-2 w-full px-3 py-2 border rounded-md text-sm border-indigo-300
                         focus:outline-none focus:ring-2 focus:ring-indigo-500"
            />
          )}

          {selectedCompetitionId && !isCreatingNew && (
            <p className="text-xs text-gray-500 mt-1">
              Teams from this import will be linked to this competition.
            </p>
          )}
        </div>

        {/* Parsing strategy */}
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
            <option value="gold_coast">Gold Coast Association — "JGC1 HEAT BLAZES"</option>
          </select>
        </div>

        {/* Import mode */}
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Import Mode</label>
          <div className="space-y-2">
            <label className="flex items-start gap-2 cursor-pointer">
              <input type="radio" name="importMode" value="upsert"
                checked={importMode === "upsert"} onChange={() => setImportMode("upsert")}
                className="mt-0.5" />
              <div>
                <span className="text-sm font-medium">Upsert (merge)</span>
                <p className="text-xs text-gray-500">Update existing players by BC Player ID. Safe to re-run.</p>
              </div>
            </label>
            <label className="flex items-start gap-2 cursor-pointer">
              <input type="radio" name="importMode" value="replace"
                checked={importMode === "replace"} onChange={() => setImportMode("replace")}
                className="mt-0.5" />
              <div>
                <span className="text-sm font-medium text-amber-700">Replace (clear first)</span>
                <p className="text-xs text-gray-500">Deletes all players for clubs in this file, then inserts fresh.</p>
              </div>
            </label>
          </div>
        </div>

        {importMode === "replace" && (
          <div className="text-sm text-amber-700 bg-amber-50 border border-amber-300 rounded-md px-3 py-2">
            ⚠ Replace mode will permanently delete all player records for clubs in this import. This cannot be undone.
          </div>
        )}

        {/* Buttons */}
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

        {newClubNames.length > 0 && (
          <div className="text-sm text-amber-700 bg-amber-50 border border-amber-200 rounded-md px-3 py-2">
            <strong>{newClubNames.length} new club(s)</strong> will be auto-created:{" "}
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
                <th className="text-left px-2 py-1 border-b">Division</th>
                <th className="text-left px-2 py-1 border-b">Team</th>
                <th className="text-left px-2 py-1 border-b">Age Grp</th>
                <th className="text-left px-2 py-1 border-b">Gender</th>
                <th className="text-left px-2 py-1 border-b">Borrows</th>
                <th className="text-left px-2 py-1 border-b">Shirt #</th>
              </tr>
            </thead>
            <tbody>
              {previewRows.map((row, idx) => {
                const gender = parseGenderFromDivision(row.divisionCode, row.ageGroupRaw);
                return (
                  <tr key={idx} className={`odd:bg-white even:bg-gray-50 ${row.isNewClub ? "text-amber-700" : ""}`}>
                    <td className="px-2 py-1 border-b font-mono text-gray-500">{row.bcPlayerId || "—"}</td>
                    <td className="px-2 py-1 border-b">
                      {row.clubName}
                      {row.isNewClub && <span className="ml-1 text-xs bg-amber-100 text-amber-700 px-1 rounded">new</span>}
                    </td>
                    <td className="px-2 py-1 border-b">{row.firstName}</td>
                    <td className="px-2 py-1 border-b">{row.lastName}</td>
                    <td className="px-2 py-1 border-b font-mono">{row.divisionCode ?? "—"}</td>
                    <td className="px-2 py-1 border-b">{row.teamName ?? "—"}</td>
                    <td className="px-2 py-1 border-b font-semibold">{row.ageGroup}</td>
                    <td className="px-2 py-1 border-b">
                      {gender === "Male" && <span className="text-blue-600">♂ Male</span>}
                      {gender === "Female" && <span className="text-pink-600">♀ Female</span>}
                      {gender === "Mixed" && <span className="text-purple-600">⚥ Mixed</span>}
                      {!gender && <span className="text-gray-300">—</span>}
                    </td>
                    <td className="px-2 py-1 border-b">
                      {row.borrowingDivision
                        ? <span className="text-purple-600 font-semibold">{row.borrowingDivision}</span>
                        : <span className="text-gray-300">—</span>}
                    </td>
                    <td className="px-2 py-1 border-b">
                      {row.finalShirt !== null ? row.finalShirt : <span className="text-gray-300">—</span>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Full data reset */}
      <div className="bg-white rounded-xl shadow p-6 max-w-2xl border border-red-200">
        <h3 className="text-base font-bold text-red-700 mb-1">Full Data Reset</h3>
        <p className="text-sm text-gray-600 mb-4">
          Permanently deletes all <strong>players, teams, inventory, allocations, pending allocations,
          and orders</strong>. Clubs, competitions, and settings are retained.
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
