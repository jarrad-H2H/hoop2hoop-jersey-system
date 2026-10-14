// Number rules for BC imports of players already on record (ALLOCATION_LOGIC.md 13).
// Pure logic, no DB. Run with: npx tsx scripts/test-import-shirt-rules.ts
import { resolveImportedShirt, parseBcRows, latestGameTime, RawRow } from "../src/services/bcImport";

let failures = 0;
function check(label: string, condition: boolean) {
  console.log(`${condition ? "PASS" : "FAIL"} - ${label}`);
  if (!condition) failures++;
}

check("BC blank keeps our number (Lincoln McHale #78)", resolveImportedShirt(null, 78, false) === 78);
check("BC #0 does not replace our number (Joshua Berg #63)", resolveImportedShirt(0, 63, false) === 63);
check("BC #0 stored when we hold no number", resolveImportedShirt(0, null, false) === 0);
check("number bought after the report beats BC (Jhye Farrell #17, BC #7)", resolveImportedShirt(7, 17, true) === 17);
check("otherwise BC's number wins (Storm Hunt #80 -> #21)", resolveImportedShirt(21, 80, false) === 21);

const row = (pid: string, shirt: string, start: string): RawRow => ({
  "Player Id": pid, "User ID": "u" + pid, "First Name": "A", "Last Name": "B", finalShirt: shirt,
  "Played For (Team)": "Pelicans 16B.7", playerDivisionGrade: "U16 BOYS C", playing: "1", "Start Time": start,
});
const rows = [row("1", "299", "9/10/2026 16:57"), row("2", "69", "11/10/2026 13:05"), row("3", "", "8/10/2026 17:55")];
const parsed = parseBcRows(rows, "north_gc");
check("#299 (scorer typo) imported as no number", parsed.find((p) => p.bcPlayerId === "1")?.finalShirt === null);
check("#69 kept as recorded", parsed.find((p) => p.bcPlayerId === "2")?.finalShirt === 69);
const last = latestGameTime(rows);
check("report's last game is 11 Oct 2026 13:05", !!last && last.getDate() === 11 && last.getMonth() === 9 && last.getHours() === 13);

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nAll checks passed");
