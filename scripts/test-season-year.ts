// Ages count from the season's registration year (Basketball Queensland): Summer 2026/27 is
// "2027 BQ Player", so a 2013-born plays U16. Pure logic, no DB. Run with: npx tsx scripts/test-season-year.ts
import { seasonAgeYear, estimateYobRange, RawRow } from "../src/services/bcImport";
import { getClashYobWindow } from "../src/services/allocation";

let failures = 0;
function check(label: string, condition: boolean) {
  console.log(`${condition ? "PASS" : "FAIL"} - ${label}`);
  if (!condition) failures++;
}

const game = (start: string, membership?: string): RawRow =>
  ({ "Start Time": start, ...(membership ? { "Linked Membership Product": membership } : {}) });

const summer = seasonAgeYear([game("18/10/2026 9:00", "2027 BQ Player"), game("17/10/2026 9:00", "2027 BQ U10 Player")]);
check("GC Oct 2026 report: ages count from 2027 (BC registrations)", summer?.year === 2027 && summer?.from === "membership");
const winter = seasonAgeYear([game("12/9/2026 9:00", "2026 BQ Player")]);
check("Winter 2026 report: ages count from 2026", winter?.year === 2026);
check("no membership column, last game in October: next year (summer season)",
  seasonAgeYear([game("11/10/2026 13:05")])?.year === 2027);
check("no membership column, last game in February: that year (summer season ending)",
  seasonAgeYear([game("21/2/2026 10:00")])?.year === 2026);
check("no membership column, last game in September: that year (winter season)",
  seasonAgeYear([game("12/9/2026 9:00")])?.year === 2026);
check("no games and no membership: unknown", seasonAgeYear([{}]) === null);

// Oscar Wen, born 2013, plays U16 in Summer 2026/27.
const u16 = estimateYobRange("U16", 2027);
check("U16 in 2027 is born 2012-2013 (Oscar Wen, 2013, fits)", u16.min === 2012 && u16.max === 2013);
check("U14 in 2027 is born 2014-2015", estimateYobRange("U14", 2027).min === 2014 && estimateYobRange("U14", 2027).max === 2015);
const oscar = getClashYobWindow(2013, 2027, false);
check("a 2013-born buyer is checked against U16 birth years (2011-2014), not U14's (2012-2015)",
  oscar.min === 2011 && oscar.max === 2014);
check("U10 in 2027 is born 2018-2019 (a 2019-born girl is U10, not U8)",
  estimateYobRange("U10", 2027).min === 2018 && estimateYobRange("U10", 2027).max === 2019);

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nAll checks passed");
