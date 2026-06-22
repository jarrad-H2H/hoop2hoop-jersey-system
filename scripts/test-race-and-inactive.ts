// Verifies two fixes against "Hoop2Hoop Test Club":
//   1. Concurrent reservations on a single-stock number -- only one must succeed
//      (reserve_jersey's FOR UPDATE SKIP LOCKED atomicity).
//   2. Inactive/released players (bc_last_seen_season < currentYear - 2) must not block
//      their old number via the team-aware clash path (previously only the YOB-window
//      fallback path checked this).
// Run with: npx tsx scripts/test-race-and-inactive.ts
import { reserveNumberForPurchase, smartCheckNumber } from "../src/services/allocation";
import { supabase } from "../src/services/supabase";

const CLUB_ID = "00000000-0000-0000-0000-0000000000aa";
let failures = 0;
function check(label: string, condition: boolean) {
  console.log(`${condition ? "PASS" : "FAIL"} - ${label}`);
  if (!condition) failures++;
}

async function testRaceCondition() {
  // #7/Y14 has exactly 1 Available unit in the seeded fixtures.
  const [a, b] = await Promise.all([
    reserveNumberForPurchase({
      clubId: CLUB_ID, jerseyNumber: 7, size: "Y14", seasonYear: 2026, yearOfBirth: 2010,
      teamId: "H2H-TEST-U18-B", isNewPlayer: true, playerFirstName: "RaceA", playerLastName: "Buyer",
    }),
    reserveNumberForPurchase({
      clubId: CLUB_ID, jerseyNumber: 7, size: "Y14", seasonYear: 2026, yearOfBirth: 2010,
      teamId: "H2H-TEST-U18-B", isNewPlayer: true, playerFirstName: "RaceB", playerLastName: "Buyer",
    }),
  ]);
  const successCount = [a, b].filter((r) => r.success).length;
  check(`Exactly one concurrent reservation succeeded (got ${successCount})`, successCount === 1);

  // Reset #7 back to clean Available state for re-runs.
  await supabase.from("pending_allocations").delete().eq("club_id", CLUB_ID).eq("jersey_number", 7);
  await supabase.from("allocations").delete().eq("club_id", CLUB_ID).eq("jersey_number", 7);
  await supabase
    .from("inventory")
    .update({ status: "Available", allocated_player_id: null, allocation_date: null })
    .eq("club_id", CLUB_ID)
    .eq("jersey_number", 7);
}

async function testInactivePlayer() {
  await supabase.from("players").insert({
    first_name: "OldPlayer", last_name: "Departed", club_id: CLUB_ID,
    team_id: "H2H-TEST-U10-MIXED", team_name: "H2H Test U10 Mixed Team A",
    age_group: "U10", final_shirt: 9, year_of_birth: 2017, bc_last_seen_season: 2022,
  });

  const result = await smartCheckNumber(CLUB_ID, 9, {
    teamName: "H2H Test U10 Mixed Team A",
    divisionCode: null,
    ageGroup: "U10",
    seasonYear: 2026,
    crossPoolCheck: false,
    productType: "default",
  });
  check("#9 NOT blocked for new same-team player (holder inactive since 2022)", result.clashes.length === 0);

  await supabase.from("players").delete().eq("club_id", CLUB_ID).eq("first_name", "OldPlayer").eq("last_name", "Departed");
}

async function main() {
  await testRaceCondition();
  await testInactivePlayer();
  console.log(`\n${failures === 0 ? "ALL PASSED" : `${failures} FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
