// Verifies two fixes against "Hoop2Hoop Test Club":
//   1. Concurrent reservations on a single-stock number -- only one must succeed
//      (reserve_jersey's FOR UPDATE SKIP LOCKED atomicity).
//   2. Inactive/released players (bc_last_seen_season < currentYear - 2) must not block
//      their old number via the team-aware clash path (previously only the YOB-window
//      fallback path checked this).
// Run with: npx tsx scripts/test-race-and-inactive.ts
import { reserveNumberForPurchase, smartCheckNumber } from "../src/services/allocation";

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

  // NOTE: cannot reset #7 here -- this script runs as the anon key (same as the real
  // widget), which correctly has no UPDATE/DELETE policy on inventory/pending_allocations.
  // Reset #7 back to Available via the Supabase SQL tool (service role) between runs:
  //   delete from pending_allocations where club_id = '<CLUB_ID>' and jersey_number = 7;
  //   delete from allocations where club_id = '<CLUB_ID>' and jersey_number = 7;
  //   update inventory set status='Available', allocated_player_id=null, allocation_date=null
  //     where club_id = '<CLUB_ID>' and jersey_number = 7;
}

// Requires this fixture to exist first (run via the privileged Supabase SQL tool --
// anon, same as the real widget, has no INSERT permission on players):
//   insert into players (first_name, last_name, club_id, team_id, team_name, age_group,
//     final_shirt, year_of_birth, bc_last_seen_season) values
//     ('OldPlayer', 'Departed', '<CLUB_ID>', 'H2H-TEST-U10-MIXED',
//      'H2H Test U10 Mixed Team A', 'U10', 9, 2017, 2022);
// Clean up afterwards with:
//   delete from players where club_id = '<CLUB_ID>' and first_name = 'OldPlayer';
async function testInactivePlayer() {
  const result = await smartCheckNumber(CLUB_ID, 9, {
    teamName: "H2H Test U10 Mixed Team A",
    divisionCode: null,
    ageGroup: "U10",
    seasonYear: 2026,
    crossPoolCheck: false,
    productType: "default",
  });
  check("#9 NOT blocked for new same-team player (holder inactive since 2022)", result.clashes.length === 0);
}

async function main() {
  await testRaceCondition();
  await testInactivePlayer();
  console.log(`\n${failures === 0 ? "ALL PASSED" : `${failures} FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
