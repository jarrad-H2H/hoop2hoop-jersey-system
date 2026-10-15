// Order webhook: does a confirmed returning player's purchase update their own profile?
// (ALLOCATION_LOGIC.md 12). Pure logic, no DB. Run with: npx tsx scripts/test-own-profile.ts
import { purchaseUpdatesOwnProfile } from "../api/shopify/orders-create";

let failures = 0;
function check(label: string, condition: boolean) {
  console.log(`${condition ? "PASS" : "FAIL"} - ${label}`);
  if (!condition) failures++;
}

check("only jersey: new number replaces the old one (Eagleton Liao #22 -> #2)", purchaseUpdatesOwnProfile(false, 2, 22));
check("had no number yet: purchase goes on their profile", purchaseUpdatesOwnProfile(null, 7, null));
check("spare of their own number (Eddie Zhang #79)", purchaseUpdatesOwnProfile(true, 79, 79));
check("keeps #15 and buys a second number: separate profile (Amaris Nicholson #78)", !purchaseUpdatesOwnProfile(true, 78, 15));

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nAll checks passed");
