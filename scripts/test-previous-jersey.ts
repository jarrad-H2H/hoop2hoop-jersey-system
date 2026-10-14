// lookupPlayerByName's previousInventoryId (the jersey the order webhook writes off when a returning
// player says "this will be my only jersey") must be THAT player's own stock jersey, never another
// child's jersey with the same number. Read-only, live data as of 2026-10-14.
// Run with: npx tsx scripts/test-previous-jersey.ts
import { lookupPlayerByName } from "../src/services/allocation";

const WOLVES = "ffdf0cca-757a-491a-b43f-ae04aa8f5d47";
const CELTICS = "1cc438ea-a37e-4cc8-a41b-ab0b596bd475";
let failures = 0;
function check(label: string, condition: boolean) {
  console.log(`${condition ? "PASS" : "FAIL"} - ${label}`);
  if (!condition) failures++;
}

async function main() {
  // Storm Hunt wears #80 from BC (never in our stock); Lucas James bought a #80 (L) from stock.
  const storm = await lookupPlayerByName({ clubId: WOLVES, firstName: "Storm", lastName: "Hunt", yearOfBirth: 2015 });
  check("Storm Hunt (#80 from BC) has no stock jersey to write off", storm.found && storm.previousInventoryId === null);
  const lucas = await lookupPlayerByName({ clubId: WOLVES, firstName: "Lucas", lastName: "James", yearOfBirth: 1996 });
  check("Lucas James's own #80 (L) is found", lucas.previousInventoryId === "fea88fe3-8ee5-4fcd-8242-1153b84c0819");

  // Celtics (mens/womens products). Harrison Cleary's BC #75 used to resolve to Cooper Mulheron's #75 L.
  const harrison = await lookupPlayerByName({ clubId: CELTICS, firstName: "Harrison", lastName: "Cleary", yearOfBirth: 2014, productType: "mens" });
  const harrisonInv = harrison.candidates?.map((c) => c.previousInventoryId) ?? [harrison.previousInventoryId];
  check("Harrison Cleary resolves to his own #75 (M), never Cooper's #75 (L)",
    harrisonInv.every((id) => id === "9d6ce17d-6cdd-47a8-a5b9-ce0f97b699cd"));
  const marisha = await lookupPlayerByName({ clubId: CELTICS, firstName: "Marisha", lastName: "Tasarz", yearOfBirth: 2011, productType: "womens" });
  check("Marisha Tasarz resolves to her own #88 (12)", marisha.previousInventoryId === "75beaeab-9a72-4eb6-9dc4-37bfe70dcaa1");

  if (failures > 0) {
    console.error(`\n${failures} check(s) failed`);
    process.exit(1);
  }
  console.log("\nAll checks passed");
}

main();
