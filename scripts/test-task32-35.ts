// Ad-hoc integration test for Task #32 (cross-pool) and Task #35 (30-min hold).
// Run with: npx tsx scripts/test-task32-35.ts
// Exercises the real exported functions against the synthetic "H2H Test Club" fixtures.
import {
  isAgeGroupCrossPool,
  smartCheckNumber,
  reserveNumberForPurchase,
} from "../src/services/allocation";
import { supabase } from "../src/services/supabase";

const CLUB_ID = "00000000-0000-0000-0000-000000000001";
let failures = 0;

function check(label: string, condition: boolean) {
  console.log(`${condition ? "PASS" : "FAIL"} - ${label}`);
  if (!condition) failures++;
}

async function main() {
  // ── #32a: U10 has a Mixed team -> cross-pool true ──
  const u10CrossPool = await isAgeGroupCrossPool(CLUB_ID, "U10");
  check("#32a isAgeGroupCrossPool(U10) is true (Mixed team present)", u10CrossPool === true);

  // ── #32b: U12 has no Mixed team -> cross-pool false ──
  const u12CrossPool = await isAgeGroupCrossPool(CLUB_ID, "U12");
  check("#32b isAgeGroupCrossPool(U12) is false (no Mixed team)", u12CrossPool === false);

  // ── #32c: U14 has manual override in competition_age_groups -> cross-pool true ──
  const u14CrossPool = await isAgeGroupCrossPool(CLUB_ID, "U14");
  check("#32c isAgeGroupCrossPool(U14) is true (manual override)", u14CrossPool === true);

  // ── #32a continued: number 7 held on Mixed U10 team must hard-block a different U10 team ──
  const u10Check = await smartCheckNumber(CLUB_ID, 7, {
    divisionCode: null,
    teamName: "Test U10 Girls Team 2",
    ageGroup: "U10",
    crossPoolCheck: u10CrossPool,
  });
  check(
    "#32a number 7 hard-blocked across different U10 teams (cross-pool)",
    u10Check.clashes.length === 1
  );

  // ── #32b continued: number 7 held on U12 Boys Team 1 must NOT block U12 Boys Team 2 (no cross-pool) ──
  const u12Check = await smartCheckNumber(CLUB_ID, 7, {
    divisionCode: null,
    teamName: "Test U12 Boys Team 2",
    ageGroup: "U12",
    crossPoolCheck: u12CrossPool,
  });
  check(
    "#32b number 7 NOT blocked across different U12 teams (no cross-pool)",
    u12Check.clashes.length === 0
  );

  // ── #32c continued: number 7 held on U14 Boys Team 1 must hard-block U14 Boys Team 2 (override) ──
  const u14Check = await smartCheckNumber(CLUB_ID, 7, {
    divisionCode: null,
    teamName: "Test U14 Boys Team 2",
    ageGroup: "U14",
    crossPoolCheck: u14CrossPool,
  });
  check(
    "#32c number 7 hard-blocked across different U14 teams (manual override)",
    u14Check.clashes.length === 1
  );

  // ── #35: reservation hold defaults to 30 minutes ──
  const reserveResult = await reserveNumberForPurchase({
    clubId: CLUB_ID,
    jerseyNumber: 8,
    size: "M",
    seasonYear: 2026,
    yearOfBirth: 2015,
    teamId: "TEST-U12-BOYS-2",
    playerFirstName: "Dana",
    playerLastName: "NewPlayer",
    isNewPlayer: true,
  });
  check("#35 reservation succeeded", reserveResult.success === true);

  if (reserveResult.success) {
    const { data: pending } = await supabase
      .from("pending_allocations")
      .select("expires_at, created_at")
      .eq("club_id", CLUB_ID)
      .eq("jersey_number", 8)
      .order("created_at", { ascending: false })
      .limit(1)
      .single();

    const createdAt = new Date(pending!.created_at).getTime();
    const expiresAt = new Date(pending!.expires_at).getTime();
    const minutes = (expiresAt - createdAt) / 60000;
    check(`#35 hold is ~30 minutes (actual: ${minutes.toFixed(1)} min)`, Math.abs(minutes - 30) < 1);
  }

  // ── #35: an EXPIRED hold must be released by the expire_pending_allocations() cron job ──
  // Create a REAL hold via the real RPC (flips inventory to Allocated), then back-date its
  // expires_at and invoke the same function pg_cron calls every minute, exactly as production does.
  const firstHold = await reserveNumberForPurchase({
    clubId: CLUB_ID,
    jerseyNumber: 9,
    size: "M",
    seasonYear: 2026,
    yearOfBirth: 2015,
    teamId: "TEST-U12-BOYS-2",
    playerFirstName: "Eve",
    playerLastName: "FirstBuyer",
    isNewPlayer: true,
  });
  check("#35 first hold on number 9 succeeded", firstHold.success === true);

  console.log(`\n${failures === 0 ? "ALL PASSED (phase 1)" : `${failures} FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
}

async function verifyExpiry() {
  // pending_allocations has no anon UPDATE policy and expire_pending_allocations() has no
  // anon EXECUTE grant (correctly so — only pg_cron, running as postgres, should call this),
  // so the back-date + expiry trigger for jersey 9's hold was done out-of-band via the
  // privileged Supabase MCP SQL tool. This phase verifies the resulting state and re-reserves,
  // both via the same anon-key client the real widget uses.
  const { data: invAfterExpiry } = await supabase
    .from("inventory")
    .select("status")
    .eq("club_id", CLUB_ID)
    .eq("jersey_number", 9)
    .eq("size", "M")
    .single();
  check(
    `#35 inventory reverted to Available after expiry (actual: ${invAfterExpiry?.status})`,
    invAfterExpiry?.status === "Available"
  );

  // Per ALLOCATION_LOGIC.md, expired holds should be treated as released — number 9
  // should now be reservable by a second buyer.
  const secondReserve = await reserveNumberForPurchase({
    clubId: CLUB_ID,
    jerseyNumber: 9,
    size: "M",
    seasonYear: 2026,
    yearOfBirth: 2015,
    teamId: "TEST-U12-BOYS-2",
    playerFirstName: "Eve",
    playerLastName: "SecondBuyer",
    isNewPlayer: true,
  });
  check(
    "#35 expired pending_allocation does not block re-reservation",
    secondReserve.success === true
  );

  console.log(`\n${failures === 0 ? "ALL PASSED (phase 2)" : `${failures} FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
}

const phase = process.argv[2] === "verify-expiry" ? verifyExpiry : main;
phase().catch((e) => {
  console.error("Test script error:", e);
  process.exit(1);
});
