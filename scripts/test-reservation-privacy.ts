// The public key (the one in the widget page) must not read buyers' names and birth years from
// pending_allocations or write reservations past reserve_jersey. The widget gets live holds and a
// returning player's own jersey through two database functions instead. Live data, 2026-10-18.
// The insert attempt is expected to be refused; its row would be expired and block nothing anyway.
// Run with: npx tsx scripts/test-reservation-privacy.ts
import { supabase } from "../src/services/supabase";
import { lookupPlayerByName } from "../src/services/allocation";

const WOLVES = "ffdf0cca-757a-491a-b43f-ae04aa8f5d47";
const ALL_NUMBERS = Array.from({ length: 100 }, (_, n) => n);
let failures = 0;
function check(label: string, condition: boolean) {
  console.log(`${condition ? "PASS" : "FAIL"} - ${label}`);
  if (!condition) failures++;
}

async function main() {
  const { data: rows } = await supabase.from("pending_allocations").select("id, player_first_name").limit(5);
  check("public key reads no reservation rows", (rows ?? []).length === 0);

  const { error: insertErr } = await supabase.from("pending_allocations").insert({
    club_id: WOLVES, jersey_number: 1, size: "TEST", season_year: 2026, year_of_birth: 2014,
    player_first_name: "Testwolf", player_last_name: "Privacycheck",
    status: "expired", expires_at: "2000-01-01T00:00:00Z",
  });
  check("public key can't insert a reservation", insertErr?.code === "42501");

  const { data: holds, error: holdsErr } = await supabase.rpc("widget_reservation_holds", {
    p_club_id: WOLVES,
    p_jersey_numbers: ALL_NUMBERS,
  });
  const allowed = new Set(["jersey_number", "year_of_birth", "team_id", "status", "expires_at"]);
  check("live holds come back without names",
    !holdsErr && (holds ?? []).length > 0 && (holds ?? []).every((h: object) => Object.keys(h).every((k) => allowed.has(k))));
  check("only purchases and unexpired reservations are returned",
    (holds ?? []).every((h: any) => h.status === "purchased" || (h.status === "reserved" && Date.parse(h.expires_at) > Date.now())));

  // Lucas James bought a #80 (L) from stock; the returning-player lookup still finds it.
  const lucas = await lookupPlayerByName({ clubId: WOLVES, firstName: "Lucas", lastName: "James", yearOfBirth: 1996 });
  check("Lucas James's own #80 (L) is still found", lucas.previousInventoryId === "fea88fe3-8ee5-4fcd-8242-1153b84c0819");

  const patterns = await Promise.all(
    [["%", "%"], ["Luc%", "James"], ["_ucas", "James"]].map(([first, last]) =>
      supabase.rpc("widget_own_purchased_jersey", {
        p_club_id: WOLVES, p_jersey_number: 80, p_product_type: "default",
        p_first_name: first, p_last_name: last, p_year_of_birth: null,
      })
    )
  );
  check("a pattern can't stand in for a buyer's name", patterns.every((r) => !r.error && r.data === null));

  if (failures > 0) {
    console.error(`\n${failures} check(s) failed`);
    process.exit(1);
  }
  console.log("\nAll checks passed");
}

main();
