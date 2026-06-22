import { lookupPlayerByName, smartCheckNumber, isAgeGroupCrossPool } from "../src/services/allocation";
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
  check("Liam found via lookup", lookup.found === true);

  const u10CrossPool = await isAgeGroupCrossPool(CLUB_ID, "U10");

  // Scenario F: Liam buys a SPARE #6 (same team, same number, same age group) -- must
  // NOT be blocked now that his own record is excluded from the clash check.
  const spareCheck = await smartCheckNumber(CLUB_ID, 6, {
    divisionCode: lookup.divisionCode,
    teamName: lookup.teamName ?? undefined,
    ageGroup: "U10",
    crossPoolCheck: u10CrossPool,
    productType: "default",
    excludePlayerId: lookup.playerId,
  });
  check("Scenario F: spare #6 NOT blocked (self-exclusion works)", spareCheck.clashes.length === 0);
  const spareStock = spareCheck.stockBySize.find((s) => s.size === "Y14")?.count ?? 0;
  check("Scenario F: exactly 1 spare #6 unit in stock (Available)", spareStock === 1);

  // Scenario G: Liam is ALSO playing up into U12 and needs a second jersey, #8, on the
  // U12 team -- must use the U12 team identity (dropdown selection), not his U10 Plan B team.
  const upCheck = await smartCheckNumber(CLUB_ID, 8, {
    divisionCode: undefined,
    teamName: "H2H Test U12 Mixed Team A",
    ageGroup: "U12",
    crossPoolCheck: await isAgeGroupCrossPool(CLUB_ID, "U12"),
    productType: "default",
    excludePlayerId: lookup.playerId,
  });
  check("Scenario G: #8 on U12 team NOT blocked (clean, no holder yet)", upCheck.clashes.length === 0);

  console.log(`\n${failures === 0 ? "ALL PASSED" : `${failures} FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
