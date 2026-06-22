// Verifies the 4 demo scenarios against "Hoop2Hoop Test Club" exactly as the widget
// now calls allocation.ts (post-fix: new players' chosen team is passed through).
// Run with: npx tsx scripts/test-demo-scenarios.ts
import {
  isAgeGroupCrossPool,
  smartCheckNumber,
  reserveNumberForPurchase,
} from "../src/services/allocation";

const CLUB_ID = "00000000-0000-0000-0000-0000000000aa";
let failures = 0;
function check(label: string, condition: boolean) {
  console.log(`${condition ? "PASS" : "FAIL"} - ${label}`);
  if (!condition) failures++;
}

async function main() {
  const u10CrossPool = await isAgeGroupCrossPool(CLUB_ID, "U10");
  const u18CrossPool = await isAgeGroupCrossPool(CLUB_ID, "U18");

  // Scenario A: Noah Walker, new, Team A, #6 mens -> BLOCKED (Liam Carter, same team)
  const a = await smartCheckNumber(CLUB_ID, 6, {
    teamName: "H2H Test U10 Mixed Team A",
    divisionCode: null,
    ageGroup: "U10",
    crossPoolCheck: u10CrossPool,
    productType: "mens",
  });
  check("Scenario A: #6 mens blocked for same-team clash (Noah vs Liam)", a.clashes.length === 1);

  // Scenario B: Mia Brown, new, Team A, #7 mens -> BLOCKED (Ava Mitchell, Team B, cross-pool)
  const b = await smartCheckNumber(CLUB_ID, 7, {
    teamName: "H2H Test U10 Mixed Team A",
    divisionCode: null,
    ageGroup: "U10",
    crossPoolCheck: u10CrossPool,
    productType: "mens",
  });
  check("Scenario B: #7 mens blocked cross-pool (Mia vs Ava, different team)", b.clashes.length === 1);

  // Scenario C: Jack Taylor, new, Team B, #5 mens -> ALLOWED (Ethan Brooks on Team A, U18 not cross-pool)
  const c = await smartCheckNumber(CLUB_ID, 5, {
    teamName: "H2H Test U18 Boys Team B",
    divisionCode: null,
    ageGroup: "U18",
    crossPoolCheck: u18CrossPool,
    productType: "mens",
  });
  check("Scenario C: #5 mens NOT blocked, different team + non-cross-pool U18", c.clashes.length === 0);

  // Scenario D: dual-product independence on #9
  const zoeReserve = await reserveNumberForPurchase({
    clubId: CLUB_ID,
    jerseyNumber: 9,
    size: "Y14",
    seasonYear: 2026,
    yearOfBirth: 2009,
    teamId: "H2H-TEST-U18-B",
    productType: "mens",
    isNewPlayer: true,
    playerFirstName: "Zoe",
    playerLastName: "Nguyen",
  });
  check("Scenario D: Zoe (mens) reserves #9 successfully", zoeReserve.success === true);

  const rubyReserve = await reserveNumberForPurchase({
    clubId: CLUB_ID,
    jerseyNumber: 9,
    size: "Y14",
    seasonYear: 2026,
    yearOfBirth: 2009,
    teamId: "H2H-TEST-U18-B",
    productType: "womens",
    isNewPlayer: true,
    playerFirstName: "Ruby",
    playerLastName: "Adams",
  });
  check(
    "Scenario D: Ruby (womens) STILL reserves #9 successfully (separate pool)",
    rubyReserve.success === true
  );

  console.log(`\n${failures === 0 ? "ALL PASSED" : `${failures} FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("Test script error:", e);
  process.exit(1);
});
