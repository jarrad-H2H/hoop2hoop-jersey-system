// Ad-hoc verification for dual mens/womens product_type wiring (Task: Shopify dual product support).
// Run with: npx tsx scripts/test-dual-product.ts
import { smartCheckNumber, reserveNumberForPurchase } from "../src/services/allocation";
import { supabase } from "../src/services/supabase";

const CLUB_ID = "00000000-0000-0000-0000-0000000000aa";
let failures = 0;
function check(label: string, condition: boolean) {
  console.log(`${condition ? "PASS" : "FAIL"} - ${label}`);
  if (!condition) failures++;
}

async function main() {
  // Mens stock for #5 should be visible when checking with productType "mens"...
  const mensCheck = await smartCheckNumber(CLUB_ID, 5, { productType: "mens" });
  check(
    "mens product_type sees mens stock for #5",
    mensCheck.stockBySize.some((s) => s.size === "Y14" && s.count === 1)
  );

  // ...and womens stock for #5 should be a SEPARATE pool, also visible.
  const womensCheck = await smartCheckNumber(CLUB_ID, 5, { productType: "womens" });
  check(
    "womens product_type sees womens stock for #5",
    womensCheck.stockBySize.some((s) => s.size === "Y14" && s.count === 1)
  );

  // Reserve #5 in the mens pool only.
  const mensReserve = await reserveNumberForPurchase({
    clubId: CLUB_ID,
    jerseyNumber: 5,
    size: "Y14",
    seasonYear: 2026,
    yearOfBirth: 2017,
    productType: "mens",
    isNewPlayer: true,
  });
  check("mens reservation for #5 succeeded", mensReserve.success === true);

  // #5 in mens pool should now show zero stock...
  const mensAfter = await smartCheckNumber(CLUB_ID, 5, { productType: "mens" });
  check(
    "mens #5 stock now zero after mens reservation",
    !mensAfter.stockBySize.some((s) => s.size === "Y14" && s.count > 0)
  );

  // ...but #5 in the womens pool is a separate product_type row and must be untouched.
  const womensAfter = await smartCheckNumber(CLUB_ID, 5, { productType: "womens" });
  check(
    "womens #5 stock still available (separate pool, untouched by mens reservation)",
    womensAfter.stockBySize.some((s) => s.size === "Y14" && s.count === 1)
  );

  // Now: this club has a Mixed U10 team, so reserving #6 womens should hard-block #6 mens
  // (and vice versa) per reserve_jersey's cross-product Mixed-pool check.
  const womensReserve6 = await reserveNumberForPurchase({
    clubId: CLUB_ID,
    jerseyNumber: 6,
    size: "Y14",
    seasonYear: 2026,
    yearOfBirth: 2017, // age 9 -> U10
    productType: "womens",
    isNewPlayer: true,
  });
  check("womens reservation for #6 succeeded", womensReserve6.success === true);

  // Mark inventory as Allocated already happened via the RPC; now attempt mens #6 in the
  // same Mixed age group -> reserve_jersey should refuse (cross-product block), per its
  // own v_is_mixed + product_type != p_product_type check.
  const mensReserve6 = await reserveNumberForPurchase({
    clubId: CLUB_ID,
    jerseyNumber: 6,
    size: "Y14",
    seasonYear: 2026,
    yearOfBirth: 2017,
    productType: "mens",
    isNewPlayer: true,
  });
  check(
    "mens reservation for #6 BLOCKED by cross-product Mixed-pool check",
    mensReserve6.success === false
  );

  console.log(`\n${failures === 0 ? "ALL PASSED" : `${failures} FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("Test script error:", e);
  process.exit(1);
});
