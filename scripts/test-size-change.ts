// A reserved number is held in ONE size (Wolves H2H2413715, Nov 2026: 5XS #10 reserved, size
// switched to 4XS, order bought a 4XS "#10"). This checks the order webhook's size comparison,
// which flags any line bought in a size other than the one the number was held in.
// The storefront side (widget.js drops the reservation on a size change) is checked in the browser.
// Run: npx tsx scripts/test-size-change.ts
import { boughtSizeDiffers } from "../api/shopify/orders-create";

let pass = 0, fail = 0;
const ok = (c: boolean, m: string) => { if (c) { pass++; console.log("  ✓ " + m); } else { fail++; console.log("  ✗ FAIL: " + m); } };

ok(boughtSizeDiffers("5XS", "4XS") === true, "George Bartle: reserved 5XS, bought 4XS → flagged");
ok(boughtSizeDiffers("4XS", "4XS") === false, "same size → not flagged");
ok(boughtSizeDiffers("M", "MM") === false && boughtSizeDiffers("3XS", "3xs") === false, "swatch double read / capitals → same size");
ok(boughtSizeDiffers("L", "Mens / L") === false && boughtSizeDiffers("L", "Mens / XL") === true, "multi-option variant title matches on its size option");
ok(boughtSizeDiffers("M", "") === false && boughtSizeDiffers("M", "Default Title") === false, "no size on the line → can't tell, not flagged");
ok(boughtSizeDiffers("", "4XS") === false, "no reserved size → not flagged");

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
