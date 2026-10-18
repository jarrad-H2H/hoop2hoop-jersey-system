// The public key (the one in the widget page) can read only the clash columns of players, never
// names, BC IDs or import details; the returning-player lookup runs inside the database
// (widget_lookup_player) and only answers for a name typed close enough, with a birth year that fits.
// Live data, read-only, 2026-10-19. Run with: npx tsx scripts/test-player-privacy.ts
import { supabase } from "../src/services/supabase";
import { lookupPlayerByName } from "../src/services/allocation";

const WOLVES = "ffdf0cca-757a-491a-b43f-ae04aa8f5d47";
const LUCAS_OWN_80 = "fea88fe3-8ee5-4fcd-8242-1153b84c0819"; // Lucas James (born 1996) bought a #80 (L)
let failures = 0;
function check(label: string, condition: boolean) {
  console.log(`${condition ? "PASS" : "FAIL"} - ${label}`);
  if (!condition) failures++;
}

async function main() {
  const names = await supabase.from("players").select("first_name, last_name").eq("club_id", WOLVES).limit(1);
  const bcIds = await supabase.from("players").select("bc_player_id, bc_user_id").eq("club_id", WOLVES).limit(1);
  check("public key can't read players' names", names.error?.code === "42501");
  check("public key can't read BC IDs", bcIds.error?.code === "42501");

  const clash = await supabase.from("players")
    .select("id, final_shirt, year_of_birth, estimated_yob_min, estimated_yob_max, age_group, division_code, team_name, team_id, bc_last_seen_at")
    .eq("club_id", WOLVES).is("deleted_at", null).limit(5);
  check("public key still reads the clash columns", !clash.error && (clash.data ?? []).length > 0);

  const exact = await lookupPlayerByName({ clubId: WOLVES, firstName: "lucas", lastName: "JAMES", yearOfBirth: 1996 });
  check("exact name finds Lucas James with his #80 and his own jersey",
    exact.found && exact.currentJerseyNumber === 80 && exact.previousInventoryId === LUCAS_OWN_80);

  const typoRightYear = await lookupPlayerByName({ clubId: WOLVES, firstName: "Lucaz", lastName: "James", yearOfBirth: 1996 });
  const typoWrongYear = await lookupPlayerByName({ clubId: WOLVES, firstName: "Lucaz", lastName: "James", yearOfBirth: 2012 });
  check("a typo finds him only with a birth year that fits",
    typoRightYear.playerId === exact.playerId && typoWrongYear.playerId !== exact.playerId);

  // Symbols are ignored, not wildcards: none of these name anyone (a near name like "Luc" + "James"
  // with his birth year is a legitimate "Did you mean Lucas James?").
  const patterns = await Promise.all(
    [["%", "%"], ["*", "*"], ["%", "James"], ["Lucas", "%"], ["Lucas", "Jam%"]].map(([firstName, lastName]) =>
      lookupPlayerByName({ clubId: WOLVES, firstName, lastName, yearOfBirth: 1996 })
    )
  );
  check("a pattern can't stand in for a name", patterns.every((r) => !r.found));

  if (failures > 0) {
    console.error(`\n${failures} check(s) failed`);
    process.exit(1);
  }
  console.log("\nAll checks passed");
}

main();
