// Verifies planReturningPlayers (BC User ID matching for season-to-season Merge imports).
// Also checks the U20 birth-year rule. Pure logic, no DB. Run with: npx tsx scripts/test-bc-user-id-merge.ts
import { planReturningPlayers, estimateYobRange, ExistingPlayerRef, ImportRegistration } from "../src/services/bcImport";
import { yobOverlapsWindow, getClashYobWindow } from "../src/services/allocation";

let failures = 0;
function check(label: string, condition: boolean) {
  console.log(`${condition ? "PASS" : "FAIL"} - ${label}`);
  if (!condition) failures++;
}

const CLUB = "club-wolves";
const OTHER = "club-other";
const old = (id: string, pid: string, uid: string | null, div: string, age: string, shirt: number | null = 1, club = CLUB): ExistingPlayerRef =>
  ({ id, club_id: club, bc_player_id: pid, bc_user_id: uid, division_code: div, age_group: age, final_shirt: shirt });
const reg = (key: number, pid: string, uid: string, div: string, age: string, club = CLUB): ImportRegistration =>
  ({ key, clubId: club, bcPlayerId: pid, bcUserId: uid, divisionCode: div, ageGroup: age });

const existing: ExistingPlayerRef[] = [
  old("callum", "p-old-1", "u1", "18B.1", "U18", 17),          // returning, new number
  old("arlo-10", "p-old-2", "u2", "10B.1", "U10"),             // returning on two teams
  old("arlo-12", "p-old-3", "u2", "12B.2", "U12"),
  old("toby-14", "p-old-4", "u3", "14B.1", "U14"),             // two teams last season, one now
  old("toby-16", "p-old-5", "u3", "16B.1", "U16"),
  old("leaver", "p-old-6", "u4", "16B.1", "U16"),              // not in import
  old("same-season", "p-same", "u5", "SLG.1", "SLG"),          // re-import within season
  old("no-uid", "p-old-7", null, "12B.1", "U12"),              // legacy record, no User ID
  old("other-club", "p-old-8", "u6", "14B.1", "U14", 1, OTHER),// same person, other club
];

const regs: ImportRegistration[] = [
  reg(0, "p-new-1", "u1", "18B.1", "U18"),
  reg(1, "p-new-2", "u2", "12B.1", "U12"),
  reg(2, "p-new-3", "u2", "10B.1", "U10"),
  reg(3, "p-new-4", "u3", "14B.1", "U14"),
  reg(4, "p-same", "u5", "SLG.1", "SLG"),
  reg(5, "p-new-5", "u7", "12B.1", "U12"),                     // brand new player
  reg(6, "p-new-6", "u6", "14B.1", "U14"),                     // joined Wolves from other club
];

const plan = planReturningPlayers(regs, new Set(["p-same"]), existing);
const m = (k: number) => plan.matches.get(k)?.id;

check("returning player matched to their existing record", m(0) === "callum");
check("two-team player: 10B.1 registration matched to old 10B.1 record", m(2) === "arlo-10");
check("two-team player: 12B.1 registration matched to old U12 record", m(1) === "arlo-12");
check("one-team player matched to same-team old record", m(3) === "toby-14");
check("old extra registration of a present player is retired", plan.surplusIds.includes("toby-16"));
check("leaver (absent from import) is NOT retired", !plan.surplusIds.includes("leaver"));
check("same-season Player Id match keeps normal path", m(4) === undefined && !plan.surplusIds.includes("same-season"));
check("brand new player is not matched", m(5) === undefined);
check("record from another club is never matched", m(6) === undefined && !plan.surplusIds.includes("other-club"));
check("legacy record without User ID untouched", !plan.surplusIds.includes("no-uid"));
check("exactly one record retired", plan.surplusIds.length === 1);

// U20 rule (2026-10-13): BC U20 players are born 2009 or earlier (in 2026).
const u20 = estimateYobRange("U20", 2026);
check("U20 estimate is 2009 or older", u20.min === 1927 && u20.max === 2009);
const clashes = (buyerYob: number) =>
  yobOverlapsWindow(null, u20.min, u20.max, "U20", 2026, getClashYobWindow(buyerYob, 2026, false));
check("U20 player clashes with a U18 buyer (born 2010)", clashes(2010));
check("U20 player clashes with an adult buyer (born 2000)", clashes(2000));
check("U20 player does NOT clash with a U16 buyer (born 2011)", !clashes(2011));
check("U20 player does NOT clash with a U10 buyer (born 2017)", !clashes(2017));

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nAll checks passed");
