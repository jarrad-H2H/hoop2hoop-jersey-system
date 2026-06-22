// Verifies the team-dropdown gender/merge-bucket fix against "Hoop2Hoop Test Club".
// Replicates JerseyWidget.tsx's filteredTeams logic exactly (can't import it directly --
// it's defined inside the React component). Confirms:
//   - A 13yo girl sees "Junior" (merge-bucket sibling of U14), not the U14 Boys team.
//   - A 13yo boy sees the U14 Boys team, not Junior.
//   - A 17yo girl sees "Open Girls" (merge-bucket sibling of U18).
// Run with: npx tsx scripts/test-junior-open-girls-dropdown.ts
import { supabase } from "../src/services/supabase";
import { ageGroupBucketSiblings } from "../src/services/allocation";

const CLUB_ID = "00000000-0000-0000-0000-0000000000aa";
type AgeGroupLabel = "U10" | "U12" | "U14" | "U16" | "U18" | "U20" | "SLG";

function normalizeAgeGroup(raw: unknown): AgeGroupLabel | null {
  const s = String(raw ?? "").trim().toUpperCase();
  if (!s || s === "N/A") return null;
  if (s.includes("SLG")) return "SLG";
  const m = s.match(/U?\s*(10|12|14|16|18|20)\b/);
  if (!m) return null;
  return (["U10", "U12", "U14", "U16", "U18", "U20"].find((x) => x === `U${m[1]}`) as AgeGroupLabel) ?? null;
}
function inferTeamAgeGroupFromName(name: string): AgeGroupLabel | null {
  const s = String(name ?? "").trim().toUpperCase();
  if (!s) return null;
  if (s.startsWith("SLG") || s.includes(" SLG") || s.includes("SLG.")) return "SLG";
  const mU = s.match(/\bU\s*(10|12|14|16|18|20)\b/);
  if (mU) return (["U10", "U12", "U14", "U16", "U18", "U20"].find((x) => x === `U${mU[1]}`) as AgeGroupLabel) ?? null;
  return null;
}

function filterTeams(allTeams: any[], effectiveAgeGroup: string, effectivePlayerGender: "Male" | "Female" | null) {
  const bucketSiblingsLower = ageGroupBucketSiblings(effectiveAgeGroup).map((s) => s.toLowerCase());
  return allTeams.filter((t) => {
    const tag = normalizeAgeGroup(t.age_group) ?? inferTeamAgeGroupFromName(t.name);
    const standardMatch = tag === effectiveAgeGroup;
    const bucketMatch =
      effectivePlayerGender === "Female" &&
      !!t.age_group &&
      bucketSiblingsLower.includes(t.age_group.trim().toLowerCase());
    if (!standardMatch && !bucketMatch) return false;
    if (!effectivePlayerGender) return true;
    const teamGender = (t.gender || "").trim();
    if (!teamGender || teamGender === "Mixed") return true;
    return effectivePlayerGender === "Female" ? teamGender === "Female" : teamGender === "Male";
  });
}

let failures = 0;
function check(label: string, condition: boolean) {
  console.log(`${condition ? "PASS" : "FAIL"} - ${label}`);
  if (!condition) failures++;
}

async function main() {
  const { data: allTeams } = await supabase
    .from("teams")
    .select("id, name, club_id, club_id_uuid, age_group, gender")
    .eq("club_id_uuid", CLUB_ID);

  const girlTeams = filterTeams(allTeams ?? [], "U14", "Female").map((t) => t.name);
  check("13yo girl sees Junior Girls team", girlTeams.includes("H2H Test Junior Girls Team"));
  check("13yo girl does NOT see U14 Boys team", !girlTeams.includes("H2H Test U14 Boys Team"));

  const boyTeams = filterTeams(allTeams ?? [], "U14", "Male").map((t) => t.name);
  check("13yo boy sees U14 Boys team", boyTeams.includes("H2H Test U14 Boys Team"));
  check("13yo boy does NOT see Junior Girls team", !boyTeams.includes("H2H Test Junior Girls Team"));

  const olderGirlTeams = filterTeams(allTeams ?? [], "U18", "Female").map((t) => t.name);
  check("17yo girl sees Open Girls team", olderGirlTeams.includes("H2H Test Open Girls Team"));

  console.log(`\n${failures === 0 ? "ALL PASSED" : `${failures} FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
