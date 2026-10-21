// Number rules for BC imports of players already on record (ALLOCATION_LOGIC.md 13).
// Pure logic, no DB. Run with: npx tsx scripts/test-import-shirt-rules.ts
import { resolveImportedShirt, parseBcRows, latestGameTime, soldNumberCheck, buildTeamList, RawRow } from "../src/services/bcImport";

let failures = 0;
function check(label: string, condition: boolean) {
  console.log(`${condition ? "PASS" : "FAIL"} - ${label}`);
  if (!condition) failures++;
}

check("BC blank keeps our number (Lincoln McHale #78)", resolveImportedShirt(null, 78, false) === 78);
check("BC #0 does not replace our number (Joshua Berg #63)", resolveImportedShirt(0, 63, false) === 63);
check("BC #0 stored when we hold no number", resolveImportedShirt(0, null, false) === 0);
check("a number we sold beats BC (Jhye Farrell #17, BC #7)", resolveImportedShirt(7, 17, true) === 17);
check("otherwise BC's number wins (Storm Hunt #80 -> #21)", resolveImportedShirt(21, 80, false) === 21);

// Which numbers count as sold to the player (website purchase or pre-order).
const celtics = "celtics-id";
const sold = soldNumberCheck([
  { club_id: celtics, player_id: null, first_name: "Nate", last_name: "Beecham", number: 82 },
  { club_id: celtics, player_id: null, first_name: "Liam", last_name: "O'Neill", number: 26 },
  { club_id: celtics, player_id: "jos-profile", first_name: "Jos", last_name: "Fitzgibbon", number: 86 },
  { club_id: celtics, player_id: null, first_name: "Charlie", last_name: "Foster", number: 80 },
  { club_id: "blades-id", player_id: null, first_name: "Blake", last_name: "Skewes", number: 30 },
]);
const profile = (id: string, club: string, first: string, last: string, shirt: number | null) =>
  ({ id, club_id: club, first_name: first, last_name: last, final_shirt: shirt });
check("Nate Beecham's #82 is ours: BC #41 doesn't replace it", resolveImportedShirt(41, 82, sold(profile("p1", celtics, "Nate", "Beecham", 82))) === 82);
check("names compared without capitals/apostrophes (Liam O'Neill = liam oneill)", sold(profile("p2", celtics, "liam", "ONeill", 26)));
check("sale recorded on the profile id matches even if the name differs", sold(profile("jos-profile", celtics, "Joseph", "Fitzgibbon", 86)));
check("a sold number on another profile doesn't freeze this one (Charlie Foster BC record #61)", !sold(profile("p3", celtics, "Charlie", "Foster", 61)));
check("same name and number at another club isn't ours", !sold(profile("p4", celtics, "Blake", "Skewes", 30)));
check("pre-order number counts as sold (Blake Skewes #30, BC #1)", resolveImportedShirt(1, 30, sold(profile("p5", "blades-id", "Blake", "Skewes", 30))) === 30);

// BC's Summer 2026/27 name for Lindisfarne.
const lags = parseBcRows([{ "Player Id": "9", "User ID": "208076", "First Name": "Finn", "Last Name": "Whitaker", finalShirt: "1",
  "Played For (Team)": "18BC3 LAGs Kings", playerDivisionGrade: "UNDER 18 BOYS 3", playing: "1", "Start Time": "18/10/2026 9:00" }], "gold_coast")[0];
check("LAGs is imported as Lindisfarne (18BC3, team Kings)", lags.clubName === "Lindisfarne" && lags.divisionCode === "18BC3" && lags.teamName === "Kings");

// Team list for the widget's dropdown: one choice per team; the division code is kept for clash checks.
const gcRow = (pid: string, team: string, grade: string): RawRow => ({
  "Player Id": pid, "User ID": "u" + pid, "First Name": "A", "Last Name": "B", finalShirt: "1",
  "Played For (Team)": team, playerDivisionGrade: grade, playing: "1", "Start Time": "18/10/2026 9:00",
});
const gcTeams = buildTeamList(parseBcRows([
  gcRow("1", "14BC5 Celtics Boston", "UNDER 14 BOYS 5"),
  gcRow("2", "14BC5 Celtics Crushers", "UNDER 14 BOYS 5"),
  gcRow("3", "14BC5 Celtics Boston", "UNDER 14 BOYS 5"),
  gcRow("4", "10MC2 Celtics Shamrocks", "UNDER 10 MIXED 2"),
], "gold_coast").map((p) => ({ ...p, clubId: "celtics-id" })));
const u14 = gcTeams.filter((t) => t.divisionCode === "14BC5");
check("two teams in one division are two choices (14BC5 Boston, 14BC5 Crushers)",
  u14.length === 2 && u14.map((t) => t.teamName).sort().join("/") === "Boston/Crushers");
check("both keep division code 14BC5, U14 boys", u14.every((t) => t.ageGroup === "U14" && t.gender === "Male"));
const shamrocks = gcTeams.find((t) => t.teamName === "Shamrocks");
check("10MC2 Shamrocks is a mixed U10 team", shamrocks?.ageGroup === "U10" && shamrocks?.gender === "Mixed");

const row = (pid: string, shirt: string, start: string): RawRow => ({
  "Player Id": pid, "User ID": "u" + pid, "First Name": "A", "Last Name": "B", finalShirt: shirt,
  "Played For (Team)": "Pelicans 16B.7", playerDivisionGrade: "U16 BOYS C", playing: "1", "Start Time": start,
});
const rows = [row("1", "299", "9/10/2026 16:57"), row("2", "69", "11/10/2026 13:05"), row("3", "", "8/10/2026 17:55")];
const parsed = parseBcRows(rows, "north_gc");
check("#299 (scorer typo) imported as no number", parsed.find((p) => p.bcPlayerId === "1")?.finalShirt === null);
check("#69 kept as recorded", parsed.find((p) => p.bcPlayerId === "2")?.finalShirt === 69);
const ngcTeams = buildTeamList(parsed.map((p) => ({ ...p, clubId: "pelicans-id" })));
check("Seahawks team: one choice, code only (16B.7, no team name)",
  ngcTeams.length === 1 && ngcTeams[0].divisionCode === "16B.7" && ngcTeams[0].teamName === null);
const last = latestGameTime(rows);
check("report's last game is 11 Oct 2026 13:05", !!last && last.getDate() === 11 && last.getMonth() === 9 && last.getHours() === 13);

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nAll checks passed");
