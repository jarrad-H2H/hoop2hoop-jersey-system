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
- **Bigger bug fixed 2026-06-22 — Junior/Open Girls teams were entirely unselectable**: the merge-bucket fix above only covered clash *comparisons*, but the team-selection dropdown itself (`JerseyWidget.tsx`'s `filteredTeams`) had no concept of "Junior"/"Open Girls" at all — `normalizeAgeGroup()`/`inferTeamAgeGroupFromName()` can only parse numeric U-bands and "SLG", so a team literally labeled `age_group = "Junior"` could never match ANY buyer's derived age group, for any gender. These teams were invisible in the dropdown, full stop. Fixed per direction from Jarrad: for **dual-product** (mens/womens) clubs, player gender is inferred automatically from the Shopify product being bought (no new question needed) — buying a womens jersey searches Female + Mixed teams only, mens searches Male + Mixed only. For **single/unisex-product** clubs, there's no such signal, so the widget now asks an explicit "Player's Gender" question. Either way, the resolved gender widens `filteredTeams` to also include raw-label merge-bucket siblings (so a 13yo girl sees "Junior" alongside/instead of "U14") and narrows it to exclude opposite-gender-only teams (Mixed/unset-gender teams always shown, to avoid hiding real data when gender isn't populated).

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
- **Second jersey, same number (spare/replacement)**: a returning player can buy an additional physical jersey under their own current number (e.g. a spare kept at another parent's house). **Bug fixed 2026-06-22**: clash checks had no self-exclusion — a player's own existing jersey record was flagged as a "same-team clash" against themselves, blocking this entirely. Fixed via `excludePlayerId` (the confirmed `playerId` from `lookupPlayerByName`) threaded through `smartCheckNumber`/`suggestNumbersForClubRanked`.
- **Second jersey, different team/age group (playing up)**: a returning player playing up needs a second jersey for the higher team, with its own number. **Bug fixed 2026-06-22**: the team dropdown filtered by the player's raw YOB-derived age group, not the playing-up-adjusted one, so the higher team was never selectable; and Plan B's matched team (their primary/lower team) was incorrectly used instead of the dropdown-selected higher team for clash checking. Both fixed in `JerseyWidget.tsx`.
- **Critical data-integrity bug fixed 2026-06-22**: `api/shopify/orders-create.ts` matched the existing player record to update purely by `(club_id, first_name, last_name, year_of_birth)` — no team disambiguation. For a player with two team memberships (e.g. playing up, or any organically multi-team BC-imported player), confirming the SECOND purchase would silently overwrite the FIRST team's `final_shirt`, corrupting their original jersey record. Fixed: now resolves the purchase's team via `pending_allocations.team_id` → `teams.name`/`age_group`, matches the existing row by team too, and **inserts a new row** (rather than updating an unrelated team's row) when no row exists yet for that specific team.

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
- **BC ID columns (2026-06-22)**: the CSV's `Player Id` column (stored as `bc_player_id`, used as the upsert conflict key — one row per team registration) is **not** reliably stable across a player's separate team registrations. The CSV's `User ID` column **is** stable across teams for the same person — confirmed by direct analysis of real export data (e.g. "Annabel Ashton": same `User ID` on both her LEPRECHAUNS and SHAMROCKS rows, but a different `Player Id` for each). `User ID` is now also captured, into `bc_user_id`, purely for linking/display purposes — it is NOT an upsert key, since multi-team players are intentionally represented as separate rows (one per team).

### Club name structure differences
- **Gold Coast**: division embedded in team name (e.g., "JGC1 Celtics Leprechauns")
- **Seahawks**: Club + AgeGroup + Gender + TeamId (e.g., "Clippers 14B.2" = Clippers, U14 Boys, team #2); grading rounds may create temporary duplicate team names — treat as same team

---

## 14. Shopify / Product Mapping

- Each Shopify product is mapped to a club via `shopify_product_club_map` (`product_type`/`gender` columns support mens+womens dual products per club)
- Widget activates only for Shopify products tagged `h2h-jersey-allocation`
- Shopify buy-buttons.liquid theme snippet (not in repo) sends "Jersey Number" and "Reservation ID" line-item properties at checkout
- **Dual product support (2026-06-22)**: `shopify_product_club_map.product_type` was already in the DB/RPC layer but never threaded through the TS code. Now wired: `JerseyWidget.tsx` resolves `product_type` from the mapping row for the detected `productId` (or from the demo `gender` prop in `WidgetDemo`/demoMode) and passes it through `smartCheckNumber`/`suggestNumbersForClubRanked`/`reserveNumberForPurchase`/`lookupPlayerByName`, so stock and reservations are correctly scoped to the mens or womens inventory pool. No liquid snippet change is needed — the existing `productId` postMessage already disambiguates which product (and therefore which pool) is in play via the mapping table lookup. `reserve_jersey`'s cross-product Mixed-pool block (for clubs with a genuinely Mixed-gender age group) was also fixed to check `teams.gender` directly using the real age-group windows, not just the manual `competition_age_groups` override with a naive `'U' || age` label. Verified end-to-end against a persistent "Hoop2Hoop Test Club" (`scripts/test-dual-product.ts`).
- **Admin-side dual product gaps fixed 2026-06-22**: `api/shopify-sync.ts` computed ONE combined available-count per size across ALL product types and pushed that same combined number to every mapped Shopify product — a club with mens+womens products would have had both products' Shopify stock levels set to the mens+womens TOTAL, not their own pool. Fixed to count per `product_type` and sync each product against only its own pool. Separately, the admin **Bulk Stock Upload** page had no `product_type` concept at all — `club_sizes` loading, stock display, and every inventory insert/rename always operated on `product_type = 'default'` only, so there was no way to actually stock a womens (or mens) pool through the admin UI. Fixed by adding a Product Type selector that's populated from `shopify_product_club_map` for the selected club, threaded through all the size/stock queries and writes.
- First real (non-synthetic) dual-product setup: Hoop2Hoop Test Club's womens singlet, Shopify product id `10431328485675`, sizes G6/G8/G10/G12/10/12/14/16/18/20/22.
- **`product_type` is NOT inherently a gender field — "legacy" pool added 2026-06-23**: `product_type` actually means "which stock pool" and only `mens`/`womens` carry gender semantics; any other value is treated as unisex by the widget (the gender prompt condition checks `!== "mens" && !== "womens"`, not `=== "default"`). This was needed for **Warriors**, who sell from TWO separate unisex products — their own current-supplier stock (`product_type = "default"`) and a leftover old-supplier product (`product_type = "legacy"`) — each with completely different size labels. Same-team clash detection is unaffected either way: it's based on `players`/team identity, never on `product_type`, so a number bought from either pool still correctly clashes against the same team's other purchases. All five `product_type` CHECK constraints (`inventory`, `allocations`, `pending_allocations`, `club_sizes`, `shopify_product_club_map`) were widened to allow `legacy` alongside `default`/`mens`/`womens`. Add further labels the same way if another club needs a third pool.

---

## 15. Things Pending / Not Yet Built

| Item | Status |
|---|---|
| Seahawks BC CSV import | ✅ Imported — 232 teams under "North Gold Coast Seahawks Domestic Competition" |
| Plan B (different-team override) | ✅ Implemented — returning player lookup returns `divisionCode`/`teamName`; widget passes to allocation functions |
| Playing-up-an-age-group widget checkbox | ✅ Implemented — "Are you also playing up an age group?" prompt in `JerseyWidget.tsx`, verified live end-to-end 2026-06-23 |
| Dual Shopify product per club (mens + womens) | ✅ Code wired 2026-06-22, verified live end-to-end 2026-06-23 against Hoop2Hoop Test Club's real unisex + womens Shopify products (full reserve → checkout → webhook → player/inventory/orders chain confirmed) |
| Cross-pool check wired into allocation.ts | ✅ Implemented — `isAgeGroupCrossPool` checks `teams.gender = 'Mixed'` (authoritative) and `competition_age_groups` (manual override) |
| Reservation hold time | ✅ 30 min, verified end-to-end 2026-06-22 (Task #35) — see Section 16 |
| Cross-pool clash tests (Task #32) | ✅ Verified end-to-end 2026-06-22 against a synthetic test club — see Section 16 |
| **Map real Shopify products for every live client club** | ⏳ Not started — all 11 real `is_client=true` clubs currently have **zero** `shopify_product_club_map` rows. Use the admin **Product Mapping** page (now fixed 2026-06-23 to set `product_type` alongside `gender`). Confirm per club/product whether unisex-only or unisex+female dual-product, and the real size labels — never assume (see Key Decision #12 in CLAUDE.md). |

---

## 17. Pre-Order System (Planned — Not Yet Built)

> This section documents the agreed design for a pre-order allocation mode. No code has been written. Read this before starting any implementation work on pre-orders.

### What Pre-Order Is (and Isn't)

The existing widget allocates jersey numbers from **physical stock already sitting in the H2H warehouse**. A customer picks a number, it reserves a specific jersey on the shelf, and the webhook confirms the allocation at checkout. The stock must exist before any order is taken.

Pre-order is a **separate mode** for situations where jersey stock does not yet exist and won't be produced until after all the orders are collected — for example, a club launching a new jersey design, or a new club H2H is onboarding for the first time. In pre-order mode:

- Players declare their **number preferences** (first, second, third choice, or "any")
- H2H collects all requests before production begins
- Once the pre-order window closes, numbers are **batch-assigned** using a FCFS-by-payment algorithm
- The assigned numbers inform the production run (which numbers and sizes to make)

Pre-order is **additive** — it does not replace the existing stock-based widget. Both modes coexist. The per-club `is_client` flag already gates the widget; a new per-club `preorder_mode` setting will gate pre-order independently.

---

### When Pre-Order Applies — Two Scenarios

**Scenario A — New jersey design / new club rollout (no prior records):**
The system has BC-imported player records (names, teams, age groups) but **no jersey number history at all** — `final_shirt` is null for everyone. The "I currently wear #X" reclaim tickbox (see below) is the *sole* mechanism to capture what numbers returning players already wear on their old jersey.

**Scenario B — Established club already using the live widget (has records):**
The `players` table already has `final_shirt` values from prior widget purchases. The system can treat those stored numbers as the player's existing claimed number — the reclaim tickbox is still offered but the system can pre-populate it from `final_shirt`.

In both scenarios the algorithm and data model are the same. The only difference is whether `final_shirt` is already populated.

---

### Number Pool and Age-Group Boundaries

Jersey number uniqueness in pre-order is scoped to **age-group pools**, not to individual teams. The pool boundary is the same 2-year age-group window already defined in Section 3 (`getClashYobWindow` / the age-group clash window table).

**Why age-group pools, not single-year cohorts:**
A player born in 2013 and a player born in 2014 can and do play on the same real team (age groups are 2-year bands). Splitting them into separate pools by single birth year would allow number clashes between genuine teammates. The existing 2-year window already captures this correctly.

**Pool capacity:** 99 usable numbers (0–99 excluding 69). A pool is considered "at capacity" when all 99 numbers are claimed within it — see Overflow Handling below.

---

### FCFS-by-Payment Algorithm

When the admin closes the pre-order window, the system runs a batch allocation in order of **payment timestamp** (Shopify `created_at` for the order, i.e. the time payment was confirmed).

For each age-group pool at a club, working strictly in payment order:

1. Take the player's **first preference** — if unclaimed in this pool, assign it.
2. If first preference is taken, try **second preference**, then **third preference**.
3. If all stated preferences are taken, assign any **remaining available number** automatically (system picks — no admin intervention needed for the routine case).
4. Players who ticked "any number" (no specific preference) are processed last within each pool and receive whatever is still available.

**Reclaimed existing numbers are processed before preferences:**
Before the FCFS pass runs, all players who ticked "I currently wear #X" have that number tentatively reserved for them. Then FCFS runs on everyone else. If two players claim the same existing number via the reclaim tickbox, the earlier payer keeps it and the later payer is treated as if they had no reclaim (their numbered preferences are used instead).

**No manual step is required** for the routine assignment — the algorithm fully allocates every player. The admin export/import flow (see below) exists for the exception case: reviewing and correcting assignments before production is finalised.

---

### Number Preference Collection (Widget Side)

The pre-order widget asks players for, in addition to the standard fields (name, YOB, size):

- **1st preference number** (required)
- **2nd preference number** (optional)
- **3rd preference number** (optional)
- **"Any number" tickbox** — if ticked, preferences are ignored and the system assigns freely
- **"I currently wear #X" tickbox** — see Reclaim Mechanism below

The widget validates that stated preferences are valid jersey numbers (0–99, not 69) but does **not** do real-time clash checking — it cannot know whether that number will conflict with a later payer. Clash resolution happens in the batch step after the window closes, not at order time. The widget should make this expectation explicit to the customer: "We'll confirm your number after the pre-order window closes."

---

### Returning Player / Reclaim Mechanism

In the live widget, `lookupPlayerByName` checks the `players` table for a player's existing jersey and allows them to "keep" it. This works because the system holds a confirmed `final_shirt` from a prior purchase.

**In a pre-order rollout (Scenario A), there are no prior purchase records.** The reclaim tickbox is the only source of truth:

- Player ticks "I currently wear number X on my old jersey"
- This is taken **on trust** — no verification is possible
- It is recorded on the `preorder_requests` row as `claimed_current_number`
- During batch allocation, claimed numbers get first priority for those players (subject to collision resolution — see FCFS above)
- If a player falsely claims a number that isn't theirs, admin can correct it via the export/import round-trip before production is locked in

In Scenario B (established club), `final_shirt` from the players table is shown to the player as their known current number, and the reclaim tickbox is pre-ticked accordingly. The player can un-tick if they want a different number this season.

---

### Overflow Handling

**Design principle: never hard-cap an order.** If more than 99 players in one age-group pool place pre-orders, the system must not block the 100th order. Basketball is unpredictable — a club can't guarantee exact headcounts — and refusing to take an order creates more operational pain than having two players share a number temporarily.

**When a pool exceeds 99 pre-orders:**
- Accept the order normally and record the request
- Flag the overflow to the admin (email alert or a System Health indicator)
- The excess players (those who did not receive an unshared number after the batch run) appear clearly in the admin export as "overflow — needs resolution"
- Admin resolves by: (a) negotiating with the club (some players may agree to share across different teams, which is allowed per Sections 2a and 2c), (b) adding numbers from a different pool if the player is permitted to play up, or (c) contacting affected players to assign a number manually

The overflow case is expected to be genuinely rare given that a typical team is 8–12 players and an age-group pool can fit 99. It becomes possible only if a single club has 8+ full teams in one age group. Admin is the safety valve — the system surfaces the problem but does not attempt to auto-resolve it.

---

### Admin Workflow

1. **Open pre-order window** — admin sets the club to `preorder_mode = 'open'`. From this point, the pre-order widget is live for that club.
2. **Monitor requests** — admin can view incoming pre-order requests in real time (no allocation yet — just a list of requests).
3. **Close window and run allocation** — admin clicks "Close & Allocate". System runs the FCFS batch and writes assigned numbers to each `preorder_requests` row.
4. **Review and correct** — admin exports to Excel, reviews the assignments, and corrects any overflow or edge cases. Clubs cannot re-submit the spreadsheet with freeform annotations — strict re-import format only (see below).
5. **Import corrections** — admin re-imports the corrected Excel. System validates format strictly and updates assignments.
6. **Lock and produce** — admin marks the pre-order as finalised. The assigned numbers are written back to `players.final_shirt` and `inventory` rows are created, so the records look the same as if the purchases had gone through the live widget.
7. **Optional: reopen for another round** — admin can reopen the pre-order window for late registrations. A new FCFS pass runs over the late requests using the already-assigned numbers as taken, so latecomers fill whatever gaps remain. Multiple rounds are supported.

---

### Excel Export/Import Round-Trip

**Export format (columns we control — never deviate):**

| Column | Notes |
|---|---|
| `request_id` | UUID generated by the system — the re-import key. Never modify. |
| `club_name` | Read-only label (display only). |
| `age_group` | Read-only label. |
| `first_name` | Read-only label. |
| `last_name` | Read-only label. |
| `year_of_birth` | Read-only label. |
| `size` | Read-only label. |
| `pref_1` | Player's stated 1st preference (read-only). |
| `pref_2` | Player's stated 2nd preference (read-only). |
| `pref_3` | Player's stated 3rd preference (read-only). |
| `any_number` | TRUE/FALSE — player's "any" flag (read-only). |
| `claimed_current` | Player's reclaim tickbox value, if set (read-only). |
| `assigned_number` | The system-assigned number. **Admin edits this column only.** |
| `admin_notes` | Free text for internal use — ignored on re-import. |

**Import validation rules (strict — no exceptions):**
- All columns must be present with exact header names (case-sensitive)
- No extra columns, no merged cells, no hidden rows
- `request_id` must match an existing pre-order request exactly — unknown IDs are rejected
- `assigned_number` must be a valid integer 0–99 (excluding 69), or blank (means "leave unchanged")
- Any row that fails validation rejects the **entire import** with a clear error listing which row(s) failed and why
- The `admin_notes` column is accepted but completely ignored — it is there so staff can leave annotations without breaking the import
- Colour coding, bold, italics, borders — all ignored silently (we read cell values only)

**Why this strictness:** Clubs will inevitably try to send back spreadsheets with highlights, strikethroughs, and margin notes. Attempting to interpret these would introduce silent data corruption. The rule is: `assigned_number` column + `request_id` key only. Everything else is decoration.

---

### Data Model (Planned — Not Yet Created)

**New table: `preorder_requests`**
```
id               uuid PK
club_id          uuid FK → clubs
player_id        uuid FK → players (nullable — new players won't have a record yet)
season           int  (e.g. 2027)
first_name       text
last_name        text
year_of_birth    int
size             text
age_group        text  (derived at request time from YOB)
pref_1           int nullable
pref_2           int nullable
pref_3           int nullable
any_number       bool default false
claimed_current  int nullable   (reclaim tickbox value)
assigned_number  int nullable   (set by batch allocation or admin override)
shopify_order_id text           (for FCFS sort — matches orders.shopify_order_id)
paid_at          timestamptz    (for FCFS sort)
status           text           ('pending' | 'allocated' | 'overflow' | 'locked')
created_at       timestamptz default now()
```

**New column: `clubs.preorder_mode`**
```
preorder_mode    text default 'off'   ('off' | 'open' | 'closed' | 'locked')
```

The `preorder_mode` column gates the pre-order widget independently of `is_client`. A club can be `is_client = true` (live widget active) and `preorder_mode = 'open'` simultaneously — the two modes serve different products/seasons and do not interfere with each other.

---

### What Is Not Changing

- **Clash logic in `allocation.ts`** is not touched for pre-order. The batch allocator re-uses `getClashYobWindow` to determine pool boundaries, but does not call `smartCheckNumber`/`suggestNumbersForClubRanked` (those are for real-time stock-based checking).
- **`reserve_jersey` RPC** is not involved in pre-order — there is no inventory to reserve against until after production.
- **The existing live widget** continues operating unchanged for clubs in stock-based mode.
- **BC CSV import** is unchanged — pre-order relies on the same `players` table populated by BC import.

---

## 16. Task #32 / #35 Test Results (2026-06-22)

Verified using a synthetic "H2H Test Club" fixture and `scripts/test-task32-35.ts`, which calls the real exported functions (`isAgeGroupCrossPool`, `smartCheckNumber`, `reserveNumberForPurchase`) under the anon key, the same way the live widget does. All scenarios passed after fixing three real bugs uncovered along the way:

1. **`reserve_jersey` uuid/text mismatch** — `pl.club_id = p_club_id::text` compared a `uuid` column against a `text`-cast parameter, throwing `operator does not exist: uuid = text` for every returning-player reservation (i.e. whenever `playerFirstName`/`playerLastName` were supplied). Fixed in migration `20260622_fix_reserve_jersey_uuid_text_mismatch.sql`.
2. **Missing anon RLS policies on `players` and `competition_age_groups`** — both tables had no SELECT policy for the `anon` role at all, only `admin_full_access` for `authenticated`. Since the public widget runs unauthenticated, this meant `smartCheckNumber`, `suggestNumbersForClubRanked`, `lookupPlayerByName` (Plan B), and the manual cross-pool override path were silently seeing zero rows for every real customer — same-team clash detection was non-functional. Fixed in migration `20260622_add_anon_read_policies_players_cag.sql`, scoped the same way as the existing `widget_read_teams_for_mapped_clubs` policy. **Low blast radius so far**: `shopify_product_club_map` had zero rows before this testing, so no club has gone fully live for checkout yet — but this had to be fixed before any club does.
3. **15-minute fallback defaults left over from the 30-minute change** — the `pending_allocations.expires_at` column default and `reserve_jersey`'s `p_expires_minutes` parameter default were both still 15. The live widget always passes `expiresMinutes: 30` explicitly, so this was a latent fallback-only inconsistency. Fixed in migration `20260622_reserve_jersey_30min_default.sql`.

Also confirmed: `expire_pending_allocations()`, run every minute by a `pg_cron` job, correctly reverts `inventory.status` to `Available` when a hold lapses — this is the actual stock-release mechanism, not anything in application code.
