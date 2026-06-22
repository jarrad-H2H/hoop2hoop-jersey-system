# H2H Jersey Number Allocator — Allocation Logic Bible

This document is the single source of truth for all jersey number allocation rules.
**ALWAYS read this before writing any code that touches numbers, clash checking, players, or the widget.**
Update this file whenever new rules are agreed, then update the code to match.

---

## 1. The Number Pool

- Valid jersey numbers: **0–99, excluding 69** = **99 usable numbers**
- The same number CAN be held by multiple players simultaneously across the same club
- Uniqueness is only required **within a team**
- Club-wide blocking is explicitly wrong — most clubs have 100+ members across many teams

---

## 2. Core Clash Rules

### 2a. Hard Rule — Same Team
- No two players on the **same team** can share a number
- "Team" = a specific team in a specific division (e.g., Blades U12B Team 1)
- Same club, different teams = same number is **allowed** (subject to YOB soft rule)

### 2b. Soft Rule — ±1 Year YOB Proxy (New / Unknown Players)
- When the player's team is unknown (new player, not found by name lookup), ±1 year YOB is the proxy for same-team risk
- If any existing holder within ±1 YOB year already holds that number, do NOT suggest it
- The ±1 year window is derived from the Age Group Clash Windows table (Section 3)
- **Bug fixed 2026-06-22**: `hasTeamContext` in `smartCheckNumber`/`suggestNumbersForClubRanked` used to flip true whenever `ageGroup` was supplied — but the widget always supplies `ageGroup` once YOB is known, even for "I don't know my team" players. That routed unknown-team players into the team-aware branch (which only soft-warns on age-group adjacency) instead of this hard-blocking YOB-window rule, silently disabling the documented safety net. Fixed: `hasTeamContext` now requires an actual `divisionCode`/`teamName`, not just `ageGroup`.

### 2c. Plan B — Different Team Override
- A ±1 year YOB clash is **acceptable** if both players are confirmed on **different teams**
- Plan B is **only possible for returning players** found by name lookup (we need to know their team)
- New players (not found in DB) cannot benefit from Plan B — the soft rule applies conservatively
- **Implemented**: `lookupPlayerByName` returns `divisionCode` + `teamName` from the player record; widget stores these and passes them to `suggestNumbersForClubRanked` / `smartCheckNumber` when the player is confirmed; this activates the team-aware path (only same-team numbers are hard-blocked; different-team numbers are allowed even within ±1 YOB window)

### 2d. Girls Merge-Bucket Matching
- The widget derives a NEW player's age group from YOB alone, via the standard ladder (U10/U12/U14/.../U18) — it has no gender input, so it never outputs "Junior" or "Open Girls" directly
- But existing Gold Coast girls players are imported with `age_group = "Junior"` or `"Open Girls"` (merged divisions — see Section 3)
- Without reconciliation, a new 13-year-old girl (derived "U14") would not be flagged as same/adjacent age group against an existing "Junior" player, even if they're on the same team
- **Implemented**: `ageGroupBucketSiblings()` / `isSameMergeBucket()` in `allocation.ts` treat `{U14, U16, Junior}` and `{U18, Open, Seniors, SLG, Open Girls}` as equivalent for all same-age-group / adjacent-age-group / cross-pool comparisons. Safe for boys too — "Junior"/"Open Girls" labels never appear on boys' teams structurally, so this can't introduce a false match for them

---

## 3. Age Group Clash Windows

| Player Age (current_year − YOB) | Division | Clash Window |
|---|---|---|
| ≤ 7 | U8 | Anyone aged ≤ 7 at this club |
| 8–9 **and U8 exists at club** | U10 | ±1 year (ages 7–10) |
| ≤ 9 **and no U8 at club** | U10 | Anyone aged ≤ 9 at this club |
| 10–11 | U12 | ±1 year (ages 9–12) |
| 12–13 | U14 | ±1 year |
| 14–15 | U16 | ±1 year |
| 16–17 | U18 | ±1 year |
| ≥ 18 | Open/Seniors | Anyone aged ≥ 18 at this club |
| 12–15 | Junior (girls only) | Anyone aged 12–15 at this club — Gold Coast girls-only division merging U14 + U16 |
| ≥ 16 | Open Girls (girls only) | Anyone aged ≥ 16 at this club — Gold Coast girls division merging U18 + Open/Seniors |

**U8 detection is per-club** — not per-competition:
```sql
SELECT EXISTS (
  SELECT 1 FROM teams
  WHERE club_id_uuid = p_club_id AND age_group = 'U8'
)
```

**Junior age group** — confirmed with Gold Coast Basketball (2026-06-22): a girls-only division merging U14 + U16, i.e. ages 12–15. **Open Girls** — confirmed same date: a girls-only division merging U18 + Open/Seniors, i.e. ages 16 and up.

**SLG (Super League Girls)** — a separate age group in the Gold Coast competition, female-only, for elite girls. Treat as a single-gender pool; no cross-pool check.

---

## 4. Playing Up an Age Group

- A player can be granted permission to play in a **higher age group** than their YOB dictates
- When playing up, the clash check must run in **both**:
  - Their **usual age group** (derived from YOB)
  - The **higher age group** they are playing up into
- Suggested numbers must be safe in **both** windows simultaneously
- This is triggered by a "playing up" checkbox in the widget (player/parent self-declares)
- **NOT yet implemented in code** — marked as pending (Section 12)

---

## 5. Active vs. Released Players

- A player is **active** if:
  - `bc_last_seen_season >= current_year - 2` — appeared in a BC import within the last 2 seasons, OR
  - `bc_last_seen_season IS NULL` — player exists in the system (e.g., from a direct widget purchase) but has never appeared in a BC upload; treat as **active conservatively**
- Active players' numbers are **included** in clash checking
- **Released / inactive**: `bc_last_seen_season < current_year - 2` — their numbers re-enter the available pool
- `bc_last_seen_season` is updated every time a player appears in a BC import
- Jerseys are **not** season-refresh items — players carry their jersey across seasons until released (inactive)

---

## 6. Pending Reservations

- A number in a pending reservation (15-minute checkout window) is **blocked the same as a confirmed allocation**
- Two players cannot reserve the same number simultaneously
- Reservation expiry runs automatically; expired reservations re-release the number

---

## 7. YOB Data and Priority Order

BC CSV files do **not** include YOB. The system uses the following priority order for clash checking:

1. **Exact `year_of_birth`** — set when a player completes a widget purchase and enters their YOB. Most reliable.
2. **`estimated_yob_min` / `estimated_yob_max`** — set at BC import from age_group + season year. A range.
   - e.g., U12 imported in 2026 → yob_min = 2013 (age 13), yob_max = 2014 (age 12)
   - yob_min = the older (smaller year) bound; yob_max = the younger (larger year) bound
3. **Derived from `age_group` at query time** — least accurate, used if neither of the above is available
4. **Conservative default** — if no YOB data at all, treat as a potential clash (safe over sorry)

YOB values shift each season as players age — never hardcode year ranges. Always derive from `current_year − YOB`.

---

## 8. Widget Flow (What It Must Do)

1. Player selects club (inferred from Shopify product), size (jersey size), and enters YOB
2. System calculates age: `current_year − YOB`
3. System determines clash window from age group table (Section 3)
4. Optional: player checks "playing up" → also apply clash check for the next age group up
5. Query all **active** number holders at this club (Section 5)
6. Filter out numbers where any active holder's YOB falls within the clash window
7. Filter out numbers with no physical stock in the requested size
8. Present **only non-clashing, in-stock numbers** to the player

**Critical**: Numbers that would clash must **never be presented** — not rejected after selection.

9. Player selects a number → system reserves it (15-min pending allocation, Section 6)
10. Player checks out via Shopify → webhook fires → allocation confirmed

---

## 9. Physical Stock

- Completely separate concern from clash checking — **both** must pass
- Stock is tracked per number, per size, per club
- Multiple players CAN hold the same number (if age groups allow it) — each holds a physical jersey
- **Written-off jerseys do NOT return to available stock** — the jersey is gone (in a wardrobe, sold, lost)
- Inventory statuses should be consistent case (all lowercase or all uppercase — do not mix)

---

## 10. Multiple Jerseys Per Player

- A player may hold **multiple jersey numbers simultaneously**, e.g.:
  - Playing a borrowed team appearance with a different number
  - Split household — one jersey at each parent's home
- **All of a player's active numbers count** when other players in the same YOB window check for clashes
- A player attempting to buy a number they **already hold** is **flat blocked**
  - No self-purchase of duplicates — the complexity/risk outweighs the edge case benefit

---

## 11. Mixed Gender Cross-Pool Check

### Source of Truth
- The **`teams.gender` column** is the authoritative source — populated at BC import time from the BC CSV
- The BC CSV clearly labels each team/division as "Boys", "Girls", or "Mixed" in a dedicated column
- Both Gold Coast Basketball and Seahawks CSVs use this format
- `competition_age_groups` table = **manual override only** (for edge cases where BC data is wrong or ambiguous)

### When Cross-Pool Check Applies
Both conditions must be true:
1. The player's age group has at least one `Mixed` team at their club (`teams.gender = 'Mixed'`)
2. The club has **both** a mens product AND a womens product configured in `shopify_product_club_map`

If either condition is false → no cross-pool check (treat as single-gender pool).

### What Cross-Pool Means
- **Single-gender division** (Male only OR Female only): clash check within that gender pool only
- **Mixed division**: jersey number must be unique across **both** the mens and womens pools

### Known Gender Data (Gold Coast Basketball)
| Age Group | Detected Genders | Cross-pool? |
|---|---|---|
| U10 | Mixed (18 teams) + Female (4 teams) | Yes — has Mixed |
| U12 | Male (32 teams) + Female (10 teams) | No — no Mixed teams |
| U14 | Male only (50 teams) | No |
| U16 | Male only (48 teams) | No |
| U18 | Male only (37 teams) | No |
| Junior | Female only (26 teams) | No |
| SLG | Female only (9 teams) | No |

---

## 12. Returning Player Name Lookup

- Player enters first name + last name + selects club in the widget
- System fuzzy-searches `players` table for a match at that club
- **Important**: BC-imported players have `year_of_birth = NULL` (BC CSV has no YOB)
  - Name lookup must **NOT** filter by `year_of_birth` — it will miss all BC-imported players
  - Use name + club match; use `estimated_yob_min/max` or `age_group` for context only
- If found: show "Did you mean [First Last]?" confirmation prompt
- If confirmed: use the player's known team membership for Plan B (Section 2c)
- If player holds an existing jersey: offer choice — keep existing number vs. buy a new one
- Keeping existing number: system verifies it is still in stock / producible (don't re-allocate; flag if jersey is written off)

---

## 13. Import Process (BC CSV)

- All clubs in the BC report are imported regardless of `is_client` status
- `is_client` flag on `clubs` table controls whether the widget activates for a club
- Non-client clubs have data stored; widget is inactive. Activating = flipping `is_client = true`
- Importer parses per team:
  - `age_group` — e.g., "U10", "U12", "Junior"
  - `gender` — "Boys", "Girls", "Mixed" (from BC CSV column C or D)
  - `competition_id` — set from selected competition in the Importer UI
- Importer estimates YOB range and stores `estimated_yob_min` / `estimated_yob_max` on each player
- `bc_last_seen_season` is updated to the import year on every player seen in that run
- Club name normalisation handles known aliases: VARSITY → Varsity, COPPERHEADS → Varsity, king's → King's

### Club name structure differences
- **Gold Coast**: division embedded in team name (e.g., "JGC1 Celtics Leprechauns")
- **Seahawks**: Club + AgeGroup + Gender + TeamId (e.g., "Clippers 14B.2" = Clippers, U14 Boys, team #2); grading rounds may create temporary duplicate team names — treat as same team

---

## 14. Shopify / Product Mapping

- Each Shopify product is mapped to a club via `shopify_product_club_map` (`product_type`/`gender` columns support mens+womens dual products per club)
- Widget activates only for Shopify products tagged `h2h-jersey-allocation`
- Shopify buy-buttons.liquid theme snippet (not in repo) sends "Jersey Number" and "Reservation ID" line-item properties at checkout
- **Dual product support (2026-06-22)**: `shopify_product_club_map.product_type` was already in the DB/RPC layer but never threaded through the TS code. Now wired: `JerseyWidget.tsx` resolves `product_type` from the mapping row for the detected `productId` (or from the demo `gender` prop in `WidgetDemo`/demoMode) and passes it through `smartCheckNumber`/`suggestNumbersForClubRanked`/`reserveNumberForPurchase`/`lookupPlayerByName`, so stock and reservations are correctly scoped to the mens or womens inventory pool. No liquid snippet change is needed — the existing `productId` postMessage already disambiguates which product (and therefore which pool) is in play via the mapping table lookup. `reserve_jersey`'s cross-product Mixed-pool block (for clubs with a genuinely Mixed-gender age group) was also fixed to check `teams.gender` directly using the real age-group windows, not just the manual `competition_age_groups` override with a naive `'U' || age` label. Verified end-to-end against a persistent "Hoop2Hoop Test Club" (`scripts/test-dual-product.ts`). Still blocked on real Shopify products/theme config for an actual second club.

---

## 15. Things Pending / Not Yet Built

| Item | Status |
|---|---|
| Seahawks BC CSV import | Data available; not yet imported |
| Plan B (different-team override) | ✅ Implemented — returning player lookup returns `divisionCode`/`teamName`; widget passes to allocation functions |
| Playing-up-an-age-group widget checkbox | Designed; not yet coded |
| Dual Shopify product per club (mens + womens) | ✅ Code wired 2026-06-22 — see Section 14. Still needs a real second club's Shopify products + theme config |
| Cross-pool check wired into allocation.ts | ✅ Implemented — `isAgeGroupCrossPool` checks `teams.gender = 'Mixed'` (authoritative) and `competition_age_groups` (manual override) |
| Reservation hold time | ✅ 30 min, verified end-to-end 2026-06-22 (Task #35) — see Section 16 |
| Cross-pool clash tests (Task #32) | ✅ Verified end-to-end 2026-06-22 against a synthetic test club — see Section 16 |

---

## 16. Task #32 / #35 Test Results (2026-06-22)

Verified using a synthetic "H2H Test Club" fixture and `scripts/test-task32-35.ts`, which calls the real exported functions (`isAgeGroupCrossPool`, `smartCheckNumber`, `reserveNumberForPurchase`) under the anon key, the same way the live widget does. All scenarios passed after fixing three real bugs uncovered along the way:

1. **`reserve_jersey` uuid/text mismatch** — `pl.club_id = p_club_id::text` compared a `uuid` column against a `text`-cast parameter, throwing `operator does not exist: uuid = text` for every returning-player reservation (i.e. whenever `playerFirstName`/`playerLastName` were supplied). Fixed in migration `20260622_fix_reserve_jersey_uuid_text_mismatch.sql`.
2. **Missing anon RLS policies on `players` and `competition_age_groups`** — both tables had no SELECT policy for the `anon` role at all, only `admin_full_access` for `authenticated`. Since the public widget runs unauthenticated, this meant `smartCheckNumber`, `suggestNumbersForClubRanked`, `lookupPlayerByName` (Plan B), and the manual cross-pool override path were silently seeing zero rows for every real customer — same-team clash detection was non-functional. Fixed in migration `20260622_add_anon_read_policies_players_cag.sql`, scoped the same way as the existing `widget_read_teams_for_mapped_clubs` policy. **Low blast radius so far**: `shopify_product_club_map` had zero rows before this testing, so no club has gone fully live for checkout yet — but this had to be fixed before any club does.
3. **15-minute fallback defaults left over from the 30-minute change** — the `pending_allocations.expires_at` column default and `reserve_jersey`'s `p_expires_minutes` parameter default were both still 15. The live widget always passes `expiresMinutes: 30` explicitly, so this was a latent fallback-only inconsistency. Fixed in migration `20260622_reserve_jersey_30min_default.sql`.

Also confirmed: `expire_pending_allocations()`, run every minute by a `pg_cron` job, correctly reverts `inventory.status` to `Available` when a hold lapses — this is the actual stock-release mechanism, not anything in application code.
