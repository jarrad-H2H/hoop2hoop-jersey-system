// FILE: src/services/bcImport.ts
// Pure (no DB / no React) helpers for the Basketball Connect game-log importer.
// Shared by src/components/Importer.tsx and ad-hoc scripts so both parse and
// match players identically.

export type ParsingStrategy = "north_gc" | "gold_coast";

export interface RawRow {
  [key: string]: string;
}

export interface ParsedPlayer {
  bcPlayerId: string;
  bcUserId: string;
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

// ─── Age group normalisation ──────────────────────────────────────────────────
export function normalizeAgeGroup(raw: string): string {
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
export function parseGenderFromDivision(
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
export function parseAgeGroupFromCode(divisionCode: string | null): string | null {
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
export function estimateYobRange(
  ageGroup: string,
  competitionYear: number,
  /** competitions.ngc_clash_rules — North Gold Coast SLG has no age limit (ALLOCATION_LOGIC.md 2f) */
  ngcRules = false
): { min: number | null; max: number | null } {
  // NGC: girls' age teams stop at U14 and younger girls play up, so SLG = aged 12 or older.
  if (ngcRules && ageGroup === "SLG") return { min: competitionYear - 99, max: competitionYear - 12 };
  switch (ageGroup) {
    case "U8":   return { min: competitionYear - 7,  max: competitionYear - 5  }; // ages 5–7
    case "U10":  return { min: competitionYear - 9,  max: competitionYear - 8  }; // ages 8–9
    case "U12":  return { min: competitionYear - 11, max: competitionYear - 10 }; // ages 10–11
    case "U14":  return { min: competitionYear - 13, max: competitionYear - 12 }; // ages 12–13
    case "U16":  return { min: competitionYear - 15, max: competitionYear - 14 }; // ages 14–15
    case "U18":  return { min: competitionYear - 17, max: competitionYear - 16 }; // ages 16–17
    case "U20":  return { min: competitionYear - 99, max: competitionYear - 17 }; // ages 17+ (born 2009 or earlier in 2026) — Hoop2Hoop rule 2026-10-13
    case "Open":
    case "Seniors":
    case "SLG":  return { min: competitionYear - 99, max: competitionYear - 18 }; // 18+
    case "Open Girls": return { min: competitionYear - 99, max: competitionYear - 16 }; // girls only: U18 + Open/Seniors merged, ages 16+
    case "Junior": return { min: competitionYear - 15, max: competitionYear - 12 }; // girls only: U14 + U16 merged, ages 12-15
    default:     return { min: null, max: null };
  }
}

// ─── Club name overrides ──────────────────────────────────────────────────────
const CLUB_NAME_OVERRIDES: Record<string, string> = {
  VARSTIY: "Varsity",   // typo variant
  VARSITY: "Varsity",   // all-caps variant
  COPPERHEADS: "Varsity",
  "KING'S": "King's",  // case variants
  LAGS: "Lindisfarne", // BC's Summer 2026/27 name for Lindisfarne (Lindisfarne Anglican Grammar School)
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
export function parseCsv(text: string): RawRow[] {
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

// ─── Game-log rows → one ParsedPlayer per BC registration ────────────────────
// BC exports one row per player per game; this collapses them to one row per
// Player Id, preferring a row that has a shirt number, isn't a borrow, and played.
export function parseBcRows(rawRows: RawRow[], strategy: ParsingStrategy): ParsedPlayer[] {
  const seenBcIds = new Map<string, ParsedPlayer>();
  const noBcIdRows: ParsedPlayer[] = [];

  for (const row of rawRows) {
    const teamRaw = (row["Played For (Team)"] ?? row["playedForTeam"] ?? "").trim();
    const { clubName, divisionCode, teamName } = deriveTeamFields(teamRaw, strategy);

    const bcPlayerId = (row["Player Id"] ?? row["Player ID"] ?? "").trim();
    // "User ID" is the stable cross-team identifier in BC's export -- unlike "Player Id"
    // (above), which can change between separate team registrations for the same person.
    const bcUserId = (row["User ID"] ?? row["UserId"] ?? "").trim();
    const firstName = (row["First Name"] ?? row["FirstName"] ?? "").trim();
    const lastName = (row["Last Name"] ?? row["LastName"] ?? "").trim();

    const shirtStr = (row["finalShirt"] ?? row["FinalShirt"] ?? "").trim();
    const shirtNum = shirtStr !== "" ? Number(shirtStr) : NaN;
    // Playing numbers are 0–99; anything else (e.g. a scorer typo like 299) counts as no number.
    const finalShirt = Number.isInteger(shirtNum) && shirtNum >= 0 && shirtNum <= 99 ? shirtNum : null;

    // playerDivisionGrade = "UNDER 10 MIXED 3" — age + gender + specific grade number
    // playerDivisionName  = "UNDER 10 MIXED"   — age + gender only (no grade)
    // Use grade as primary; fall back to name if grade is missing
    const divisionGrade = (row["playerDivisionGrade"] ?? "").trim();
    const ageGroupRaw = (divisionGrade || (row["playerDivisionName"] ?? "")).trim();
    // Prefer age group derived from the division code (e.g. "14G.1" → "U14") over
    // the raw BC text field (e.g. playerDivisionGrade = "Super League Girls 1" → "SLG"),
    // which can be misleading when a player has a cross-pool grade assignment.
    const ageGroupFromCode = parseAgeGroupFromCode(divisionCode ?? null);
    const ageGroup = ageGroupFromCode ?? normalizeAgeGroup(ageGroupRaw);
    const playing = (row["playing"] ?? "").trim();

    const currentDiv = (row["Current Team Division"] ?? "").trim().toUpperCase();
    const borrowingDiv = (row["Borrowing Team Division"] ?? "").trim().toUpperCase();
    const isBorrowed = borrowingDiv.length > 0 && borrowingDiv !== currentDiv;
    const borrowingDivision = isBorrowed
      ? normalizeAgeGroup(
          (row["Borrowing Team Grade"] || (row["Borrowing Team Division"] ?? ""))
        )
      : null;

    const player: ParsedPlayer = {
      bcPlayerId,
      bcUserId,
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

  return [...Array.from(seenBcIds.values()), ...noBcIdRows];
}

// ─── Report date ──────────────────────────────────────────────────────────────
// Latest game in the export ("Start Time", d/m/yyyy H:mm, local time).
export function latestGameTime(rawRows: RawRow[]): Date | null {
  let latest: Date | null = null;
  for (const row of rawRows) {
    const m = (row["Start Time"] ?? "").trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+(\d{1,2}):(\d{2}))?/);
    if (!m) continue;
    const t = new Date(+m[3], +m[2] - 1, +m[1], +(m[4] ?? 23), +(m[5] ?? 59));
    if (!latest || t > latest) latest = t;
  }
  return latest;
}

// ─── Number to store for a player already on record ──────────────────────────
// BC's number wins, except: no BC number keeps ours (registered but not played); a BC #0
// doesn't replace a different number we hold (#0 is often the scorer's "not entered"); and
// a number we sold this player is never replaced (soldNumberCheck): BC lags behind sales —
// grading games played before the jersey arrived, spare or borrowed singlets.
export function resolveImportedShirt(
  bcShirt: number | null,
  existingShirt: number | null,
  soldByUs: boolean
): number | null {
  if (soldByUs || bcShirt === null) return existingShirt;
  if (bcShirt === 0 && existingShirt !== null && existingShirt !== 0) return existingShirt;
  return bcShirt;
}

// ─── Returning-player matching by BC User ID ─────────────────────────────────
// BC issues a NEW Player Id every season, but User ID stays the same for a person.
// Matching only on Player Id therefore turned every returning player into a
// duplicate record each season. This pairs each new-season registration with the
// person's existing record (same club + same User ID) so it is updated in place.

export interface ImportRegistration {
  key: number;                 // caller's index for the row
  clubId: string | null;
  bcPlayerId: string;
  bcUserId: string;
  divisionCode: string | null;
  ageGroup: string;
}

export interface ExistingPlayerRef {
  id: string;
  club_id: string | null;
  bc_player_id: string | null;
  bc_user_id: string | null;
  division_code: string | null;
  age_group: string | null;
  final_shirt: number | null;
}

export interface ReturningPlayerPlan {
  /** registration key → existing players.id to update in place (new Player Id written onto it) */
  matches: Map<number, ExistingPlayerRef>;
  /** older records for a person who IS in this import but now on fewer teams — retire (soft-delete) */
  surplusIds: string[];
}

/**
 * @param registrations  the import's rows that have a BC Player Id
 * @param knownPlayerIds Player Ids from this import that already exist in `players`
 *                       (those rows keep the normal Player Id upsert path)
 * @param existing       non-deleted players at the import's clubs that have a bc_user_id
 *
 * People absent from the import are never touched (club decision 2026-10-13: a
 * player may sit a season out and come back expecting to keep their singlet).
 */
export function planReturningPlayers(
  registrations: ImportRegistration[],
  knownPlayerIds: Set<string>,
  existing: ExistingPlayerRef[]
): ReturningPlayerPlan {
  const personKey = (clubId: string | null, userId: string | null) =>
    clubId && userId ? `${clubId}::${userId}` : null;

  // Records already claimed by an exact Player Id match (same-season re-import).
  const claimed = new Set<string>();
  const existingByPid = new Map<string, ExistingPlayerRef>();
  for (const e of existing) if (e.bc_player_id) existingByPid.set(e.bc_player_id, e);

  const peopleInImport = new Set<string>();
  const pending = new Map<string, ImportRegistration[]>();
  for (const r of registrations) {
    const pk = personKey(r.clubId, r.bcUserId);
    if (pk) peopleInImport.add(pk);
    if (knownPlayerIds.has(r.bcPlayerId)) {
      const e = existingByPid.get(r.bcPlayerId);
      if (e) claimed.add(e.id);
      continue;
    }
    if (!pk) continue;
    if (!pending.has(pk)) pending.set(pk, []);
    pending.get(pk)!.push(r);
  }

  const candidates = new Map<string, ExistingPlayerRef[]>();
  for (const e of existing) {
    const pk = personKey(e.club_id, e.bc_user_id);
    if (!pk || claimed.has(e.id) || !peopleInImport.has(pk)) continue;
    if (!candidates.has(pk)) candidates.set(pk, []);
    candidates.get(pk)!.push(e);
  }

  const matches = new Map<number, ExistingPlayerRef>();
  const surplusIds: string[] = [];

  for (const [pk, olds] of candidates) {
    const regs = [...(pending.get(pk) ?? [])];
    const free = [...olds];
    // Prefer the same team, then the same age group, then whatever is left.
    const passes: ((r: ImportRegistration, e: ExistingPlayerRef) => boolean)[] = [
      (r, e) => !!r.divisionCode && r.divisionCode === e.division_code,
      (r, e) => !!r.ageGroup && r.ageGroup === e.age_group,
      () => true,
    ];
    for (const fits of passes) {
      for (let i = 0; i < regs.length; ) {
        const j = free.findIndex((e) => fits(regs[i], e));
        if (j === -1) { i++; continue; }
        matches.set(regs[i].key, free[j]);
        regs.splice(i, 1);
        free.splice(j, 1);
      }
    }
    for (const e of free) surplusIds.push(e.id);
  }

  return { matches, surplusIds };
}

// ─── Website buyers → their first BC registration ────────────────────────────
// A jersey bought on the website creates a profile with no BC IDs (the website never knows
// them). When that player first appears in a BC report, the registration is linked to that
// profile — same club, same name, birth year fits the team's age group (or is up to one age
// group younger: playing up) — so it is updated in place instead of duplicated. Only
// unambiguous pairs are linked: exactly one profile for the registration and vice versa.

export interface WebsiteBuyerRef extends ExistingPlayerRef {
  first_name: string | null;
  last_name: string | null;
  year_of_birth: number | null;
}

export interface UnmatchedRegistration {
  key: number;
  clubId: string | null;
  firstName: string;
  lastName: string;
  /** estimated birth-year range for the registration's age group (estimateYobRange) */
  yobMin: number | null;
  yobMax: number | null;
}

const nameKey = (s: string | null | undefined) =>
  (s ?? "").normalize("NFKD").toLowerCase().replace(/[^a-z]/g, "");

export function linkWebsiteBuyers(
  registrations: UnmatchedRegistration[],
  buyers: WebsiteBuyerRef[]
): Map<number, WebsiteBuyerRef> {
  const links = new Map<number, WebsiteBuyerRef>();
  const claimed = new Set<string>();
  const sameKid = (r: UnmatchedRegistration, b: WebsiteBuyerRef) =>
    b.club_id === r.clubId &&
    nameKey(b.first_name) === nameKey(r.firstName) &&
    nameKey(b.last_name) === nameKey(r.lastName);
  const passes: ((yob: number, min: number, max: number) => boolean)[] = [
    (yob, min, max) => yob >= min && yob <= max, // birth year fits the age group
    (yob, _min, max) => yob > max && yob <= max + 2, // playing up one age group
  ];

  for (const fits of passes) {
    const forReg = new Map<number, WebsiteBuyerRef[]>();
    const regsForBuyer = new Map<string, number>();
    for (const r of registrations) {
      if (links.has(r.key) || r.yobMin == null || r.yobMax == null) continue;
      const found = buyers.filter(
        (b) => !claimed.has(b.id) && b.year_of_birth != null && sameKid(r, b) &&
          fits(b.year_of_birth, r.yobMin!, r.yobMax!)
      );
      forReg.set(r.key, found);
      for (const b of found) regsForBuyer.set(b.id, (regsForBuyer.get(b.id) ?? 0) + 1);
    }
    for (const [key, found] of forReg) {
      if (found.length === 1 && regsForBuyer.get(found[0].id) === 1) {
        links.set(key, found[0]);
        claimed.add(found[0].id);
      }
    }
  }
  return links;
}

// ─── Numbers we sold ──────────────────────────────────────────────────────────
// A number we sold a player in the last SOLD_NUMBER_MONTHS — a website purchase or a
// pre-order number — is kept over BC's (resolveImportedShirt; Celtics Oct 2026: Nate Beecham
// bought #82, BC's grading games showed #41). Matched on the profile id the sale recorded,
// otherwise on club + name (as nameKey) + number.

export const SOLD_NUMBER_MONTHS = 12;

export interface SaleRef {
  club_id: string | null;
  player_id: string | null;
  first_name: string | null;
  last_name: string | null;
  number: number | null;
}

type SoldCheckProfile = Pick<WebsiteBuyerRef, "id" | "club_id" | "first_name" | "last_name" | "final_shirt">;

export function soldNumberCheck(sales: SaleRef[]): (profile: SoldCheckProfile) => boolean {
  const key = (club: string | null, first: string | null, last: string | null, n: number) =>
    `${club}|${nameKey(first)}|${nameKey(last)}|${n}`;
  const byProfile = new Set<string>();
  const byName = new Set<string>();
  for (const s of sales) {
    if (s.number == null) continue;
    if (s.player_id) byProfile.add(`${s.player_id}|${s.number}`);
    byName.add(key(s.club_id, s.first_name, s.last_name, s.number));
  }
  return (p) =>
    p.final_shirt != null &&
    (byProfile.has(`${p.id}|${p.final_shirt}`) || byName.has(key(p.club_id, p.first_name, p.last_name, p.final_shirt)));
}
