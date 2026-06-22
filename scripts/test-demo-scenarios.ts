// Verifies the 4 demo scenarios against "Hoop2Hoop Test Club" (single-product/unisex
// setup) exactly as the widget calls allocation.ts, post-fixes:
//   1. new players' chosen team is now passed through to clash checking
//   2. ageGroup alone no longer forces the team-aware path, so "I don't know my team"
//      players correctly fall through to the +/-1 YOB-window hard-block (ALLOCATION_LOGIC.md 2b)
// Run with: npx tsx scripts/test-demo-scenarios.ts
import { isAgeGroupCrossPool, smartCheckNumber } from "../src/services/allocation";

const CLUB_ID = "00000000-0000-0000-0000-0000000000aa";
let failures = 0;
function check(label: string, condition: boolean) {
  console.log(`${condition ? "PASS" : "FAIL"} - ${label}`);
  if (!condition) failures++;
}

async function main() {
  const u10CrossPool = await isAgeGroupCrossPool(CLUB_ID, "U10");
  const u18CrossPool = await isAgeGroupCrossPool(CLUB_ID, "U18");

  // Scenario A: Noah Walker, new, Team A, #6 -> BLOCKED (Liam Carter, same team)
  const a = await smartCheckNumber(CLUB_ID, 6, {
    teamName: "H2H Test U10 Mixed Team A",
    divisionCode: null,
    ageGroup: "U10",
    crossPoolCheck: u10CrossPool,
    productType: "default",
  });
  check("Scenario A: #6 blocked for same-team clash (Noah vs Liam)", a.clashes.length === 1);

  // Scenario B: Mia Brown, new, Team A, #7 -> BLOCKED (Ava Mitchell, Team B, cross-pool)
  const b = await smartCheckNumber(CLUB_ID, 7, {
    teamName: "H2H Test U10 Mixed Team A",
    divisionCode: null,
    ageGroup: "U10",
    crossPoolCheck: u10CrossPool,
    productType: "default",
  });
  check("Scenario B: #7 blocked cross-pool (Mia vs Ava, different team)", b.clashes.length === 1);

  // Scenario C: Jack Taylor, new, Team B, #5 -> ALLOWED (Ethan Brooks on Team A, U18 not cross-pool)
  const c = await smartCheckNumber(CLUB_ID, 5, {
    teamName: "H2H Test U18 Boys Team B",
    divisionCode: null,
    ageGroup: "U18",
    crossPoolCheck: u18CrossPool,
    productType: "default",
  });
  check("Scenario C: #5 NOT blocked, different team + non-cross-pool U18", c.clashes.length === 0);

  // Scenario D: Sam (YOB 2009, same as Ethan), team UNKNOWN ("I don't know my team") -> BLOCKED.
  // This exercises ALLOCATION_LOGIC.md 2b's +/-1 YOB proxy hard-block, which only just got
  // fixed (ageGroup alone was incorrectly forcing the team-aware path, bypassing this rule).
  const d = await smartCheckNumber(CLUB_ID, 5, {
    ageGroup: "U18",
    crossPoolCheck: u18CrossPool,
    productType: "default",
    yearOfBirth: 2009,
    seasonYear: 2026,
  });
  check(
    "Scenario D: #5 blocked via +/-1 YOB proxy when team is unknown (Sam vs Ethan)",
    d.clashes.length === 1
  );

  console.log(`\n${failures === 0 ? "ALL PASSED" : `${failures} FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("Test script error:", e);
  process.exit(1);
});
