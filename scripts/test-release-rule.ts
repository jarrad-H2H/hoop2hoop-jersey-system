// Number release rule (ALLOCATION_LOGIC.md 5): a player's number is released once the club's
// BC reports from the last 12 months (two seasons) no longer include them.
// Pure logic, no DB. Run with: npx tsx scripts/test-release-rule.ts
import { activeCutoff } from "../src/services/allocation";

let failures = 0;
function check(label: string, condition: boolean) {
  console.log(`${condition ? "PASS" : "FAIL"} - ${label}`);
  if (!condition) failures++;
}

const active = (lastSeen: string, clubNewestReport: string | null) => lastSeen >= activeCutoff(clubNewestReport);

// Caitlin McIntyre: last seen at Wolves in the Winter 2026 report (12 Sep 2026), now playing for CAC.
check("still blocked after one missed season (Wolves report Apr 2027)", active("2026-09-12", "2027-04-20"));
check("released after two missed seasons (Wolves report Oct 2027)", !active("2026-09-12", "2027-10-11"));
check("not released when the club has no newer report (no import for 2 years)", active("2026-09-12", "2026-10-11"));
check("seen in the club's newest report = active", active("2026-10-11", "2026-10-11"));
check("club with no BC reports: everyone active", active("2020-01-01", null));
check("cutoff is exactly 12 months before the newest report", activeCutoff("2027-10-11") === "2026-10-11");

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nAll checks passed");
