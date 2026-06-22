// Verifies the "release old number for a new one" flow against "Hoop2Hoop Test Club".
// Liam Carter holds #6 (inventory id baseline: d6d91e40..., Allocated). This script
// reserves a NEW number (#5) for him with keepExistingJersey=false, then prints the
// previousInventoryId the order-confirmation webhook would write off. The actual
// write-off + player record update happen server-side at order confirmation (Allocated
// -> Written Off; final_shirt updated on the same player row) -- not simulated here,
// since that requires the service-role client api/shopify/orders-create.ts uses.
//
// Run with: npx tsx scripts/test-release-flow.ts
// IMPORTANT: leaves a real pending_allocation for #5 -- reset via the Supabase SQL tool:
//   delete from pending_allocations where club_id = '<CLUB_ID>' and jersey_number = 5;
//   delete from allocations where club_id = '<CLUB_ID>' and jersey_number = 5;
//   update inventory set status='Available', allocated_player_id=null, allocation_date=null
//     where club_id = '<CLUB_ID>' and jersey_number = 5;
import { lookupPlayerByName, reserveNumberForPurchase } from "../src/services/allocation";

const CLUB_ID = "00000000-0000-0000-0000-0000000000aa";
let failures = 0;
function check(label: string, condition: boolean) {
  console.log(`${condition ? "PASS" : "FAIL"} - ${label}`);
  if (!condition) failures++;
}

async function main() {
  const lookup = await lookupPlayerByName({
    clubId: CLUB_ID, firstName: "Liam", lastName: "Carter",
    yearOfBirth: 2017, ageGroup: "U10", productType: "default",
  });
  check("Found Liam with currentJerseyNumber 6", lookup.currentJerseyNumber === 6);
  // Requires the inventory anon-read fix (status IN ('Available','Allocated')) --
  // previously this always came back null because RLS only exposed Available rows.
  check("previousInventoryId resolved to his Allocated row (not null)", !!lookup.previousInventoryId);

  const reserve = await reserveNumberForPurchase({
    clubId: CLUB_ID, jerseyNumber: 5, size: "Y14", seasonYear: 2026, yearOfBirth: 2017,
    teamId: "H2H-TEST-U10-MIXED",
    playerFirstName: "Liam", playerLastName: "Carter", isNewPlayer: false,
    keepExistingJersey: false, previousJerseyNumber: 6, previousInventoryId: lookup.previousInventoryId,
  });
  check("Reservation for new #5 succeeded", reserve.success === true);

  console.log(`\n${failures === 0 ? "ALL PASSED" : `${failures} FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
