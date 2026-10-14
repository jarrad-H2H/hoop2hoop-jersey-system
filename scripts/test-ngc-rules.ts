// Verifies the North Gold Coast rules (ALLOCATION_LOGIC.md §2f) against live Wolves data,
// exactly as JerseyWidget calls allocation.ts. Read-only. Holders as of 2026-10-14:
//   #29 Piper Thams (SLG.2, kept from last season)   #40 Violet Emmett (SLG.1)
//   #37 Archer Whyte (14B.2)   #30 Noah Turner (18B.1), Jaden Rendle (16B.2), Liam Smith (14B.2)
// Run with: npx tsx scripts/test-ngc-rules.ts
import { supabase } from "../src/services/supabase";
import { smartCheckNumber, suggestNumbersForClubRanked, lookupPlayerByName, BuyerGender } from "../src/services/allocation";

const WOLVES = "ffdf0cca-757a-491a-b43f-ae04aa8f5d47";
const CELTICS = "1cc438ea-a37e-4cc8-a41b-ab0b596bd475";
const YEAR = 2026;
let failures = 0;
function check(label: string, condition: boolean) {
  console.log(`${condition ? "PASS" : "FAIL"} - ${label}`);
  if (!condition) failures++;
}

/** A new buyer as the widget sends them (Layer 1): birth-year window always on, picked team additive. */
async function newBuyerClash(n: number, yob: number, gender: BuyerGender, team?: string) {
  const r = await smartCheckNumber(WOLVES, n, {
    seasonYear: YEAR, yearOfBirth: yob, teamName: team, enforceYobWindow: true,
    selectedTeamCode: team, buyerGender: gender, productType: "default",
  });
  return r.clashes.map((p) => `${p.first_name} ${p.last_name}`);
}

async function main() {
  const { data: wolvesNgc } = await supabase.rpc("club_uses_ngc_clash_rules", { p_club_id: WOLVES });
  const { data: celticsNgc } = await supabase.rpc("club_uses_ngc_clash_rules", { p_club_id: CELTICS });
  check("Wolves plays North Gold Coast (rules on)", wolvesNgc === true);
  check("Celtics does not (rules off)", celticsNgc === false);

  // Rule 1: SLG number pool
  check("SLG.1 girl: #40 blocked (SLG.1 teammate)", (await newBuyerClash(40, 2010, "Female", "SLG.1")).includes("Violet Emmett"));
  check("SLG.1 girl: #29 blocked (SLG.2 girl kept from last season)", (await newBuyerClash(29, 2010, "Female", "SLG.1")).includes("Piper Thams"));
  check("SLG.2 girl: #40 blocked (pool covers every SLG team)", (await newBuyerClash(40, 2010, "Female", "SLG.2")).includes("Violet Emmett"));
  check("girl born 2008, team 'I don't know': #29 blocked (12+ = SLG pool)", (await newBuyerClash(29, 2008, "Female")).includes("Piper Thams"));
  check("girl born 2013, team 'I don't know': #40 blocked (12+ = SLG pool)", (await newBuyerClash(40, 2013, "Female")).includes("Violet Emmett"));
  check("girl born 2015 (U12), 'I don't know': #29 NOT blocked (pool is 12+)", (await newBuyerClash(29, 2015, "Female")).length === 0);

  // Rule 2: boys' and girls' teams never block each other
  check("boy born 2008 (U20): #40 NOT blocked by an SLG girl", (await newBuyerClash(40, 2008, "Male")).length === 0);
  check("boy born 2013 (U14): #40 NOT blocked by an SLG girl", (await newBuyerClash(40, 2013, "Male")).length === 0);
  check("boy born 2013 (U14): #37 still blocked (Archer Whyte, boy, same age)", (await newBuyerClash(37, 2013, "Male")).includes("Archer Whyte"));
  check("girl born 2013: #37 NOT blocked by a boys' team player", (await newBuyerClash(37, 2013, "Female")).length === 0);

  // Plan B fix: a returning Seahawks player who also picks their own team keeps teammate blocking
  const c = await lookupPlayerByName({ clubId: WOLVES, firstName: "Callum", lastName: "Honeycombe", yearOfBirth: 2009 });
  for (const picked of [undefined, "18B.1"]) {
    const r = await smartCheckNumber(WOLVES, 30, {
      seasonYear: YEAR, yearOfBirth: 2009, ageGroup: "U18", divisionCode: c.divisionCode, teamName: c.teamName ?? undefined,
      excludePlayerId: c.playerId, enforceYobWindow: false, selectedTeamCode: picked, buyerGender: "Male", productType: "default",
    });
    check(`Plan B Callum (team list: ${picked ?? "I don't know"}): #30 blocked (teammate Noah Turner)`,
      r.clashes.some((p) => p.first_name === "Noah" && p.last_name === "Turner"));
  }

  // Number grid: an SLG girl never sees any SLG girl's number; boys' numbers aren't held against her
  const grid = (await suggestNumbersForClubRanked({
    clubId: WOLVES, size: "3XS", seasonYear: YEAR, yearOfBirth: 2010, ageGroup: "U18", teamName: "SLG.1",
    enforceYobWindow: true, selectedTeamCode: "SLG.1", buyerGender: "Female", productType: "default", limit: 30,
  })).map((s) => s.jersey_number);
  console.log(`   3XS grid for an SLG.1 girl: ${grid.sort((a, b) => a - b).join(", ")}`);
  check("SLG.1 girl's 3XS grid excludes SLG numbers 29, 31, 32, 40", [29, 31, 32, 40].every((n) => !grid.includes(n)));
  check("SLG.1 girl's 3XS grid offers boys-only numbers 34 and 37", [34, 37].every((n) => grid.includes(n)));

  if (failures > 0) {
    console.error(`\n${failures} check(s) failed`);
    process.exit(1);
  }
  console.log("\nAll checks passed");
}

main();
