# H2H Jersey Number Allocator — Claude Code Context

This file is read automatically by Claude Code at session start. **Always read `ALLOCATION_LOGIC.md` before touching any code that involves numbers, clashes, players, or the widget.**

---

## What This Project Is

A Shopify-embedded widget that lets basketball players self-select a jersey number at purchase time, with automatic clash detection to prevent two players on the same team getting the same number. Built for Hoop2Hoop, who supply jerseys to basketball clubs on the Gold Coast and in Brisbane (Seahawks competition).

**Live URL**: Deployed on Vercel, embedded in Shopify product pages as an iframe.

---

## Tech Stack

| Layer | Technology |
|---|---|
| Frontend | React + TypeScript + Vite + Tailwind CSS |
| Backend / DB | Supabase (Postgres + RLS + Edge Functions) |
| Hosting | Vercel (frontend + API routes) |
| E-commerce | Shopify (product pages, checkout, webhooks) |
| Auth | Supabase Auth — admin panel only, no public signup |

**Supabase project name**: "Hoop2Hoop System"

---

## Repository Structure

```
src/
  components/
    JerseyWidget.tsx        ← Customer-facing widget (embedded in Shopify iframe)
    Importer.tsx            ← Admin: bulk-import BC CSV files
    StockPlanner.tsx        ← Admin: stock analytics, demand, purchase planning
    AllocationHistory.tsx   ← Admin: full allocation audit trail
    CompetitionGenderAdmin.tsx ← Admin: manage competition gender overrides
  pages/
    AdminDashboard.tsx      ← Admin shell / nav
    ClubManager.tsx         ← Admin: manage clubs + settings
    ClubOverview.tsx        ← Admin: per-club player/team overview
    Players.tsx             ← Admin: player records, inline YOB edit
    SalesHistory.tsx        ← Admin: Shopify order history
    BulkStockUpload.tsx     ← Admin: bulk stock entry
  services/
    allocation.ts           ← ALL clash/suggest/reserve logic (the brain)
    supabase.ts             ← Supabase client init
  types.ts                  ← Shared TypeScript types
api/
  shopify-sync.ts           ← Vercel API route: Shopify webhook handler (orders/paid)
  shopify/
    orders-create.ts        ← Vercel API route: Shopify orders/create webhook
ALLOCATION_LOGIC.md         ← Single source of truth for all jersey allocation rules
CLAUDE.md                   ← This file
```

---

## Database Schema (Key Tables)

### `clubs`
- `id` (uuid PK)
- `name`, `short_code`
- `is_client` (bool) — **widget only activates for is_client=true clubs**
- `competition_id` — links to which BC competition they play in

### `teams`
- `id` (uuid PK)
- `club_id` (short code, legacy), `club_id_uuid` (uuid FK to clubs)
- `name` — full team name as parsed from BC CSV
- `age_group` — e.g. "U10", "U12", "U14", "U16", "U18", "SLG", "Junior"
- `gender` — "Boys", "Girls", "Mixed" — sourced from BC CSV, authoritative for cross-pool checks
- `division_code` — e.g. "14B.2" (Seahawks) or "JGC1" (Gold Coast)
- `competition_id`

### `players`
- `id` (uuid PK)
- `club_id` (uuid FK to clubs)
- `team_id` (uuid FK to teams, nullable)
- `first_name`, `last_name`
- `year_of_birth` (nullable — BC CSV has no YOB; set only when player completes a widget purchase)
- `estimated_yob_min`, `estimated_yob_max` — derived at import time from age_group + season year
- `age_group` — the age group they played in at last import
- `division_code`, `team_name` — team identifiers (used for Plan B clash checking)
- `final_shirt` — their current jersey number (nullable)
- `bc_last_seen_season` — year of last BC import; if < current_year - 2, player is inactive/released
- `bc_player_id` — BC's own player identifier
- `gender` (nullable)

### `inventory`
- `id` (uuid PK)
- `club_id` (uuid FK)
- `jersey_number` (int)
- `size` (text)
- `status` — "Available", "Allocated", "Pending", "Written Off" (all title-case)
- `player_id` (uuid FK, nullable)

### `pending_allocations`
- `id` (uuid PK)
- `club_id`, `jersey_number`, `size`
- `player_first_name`, `player_last_name`, `year_of_birth`
- `expires_at` — 30-minute hold; expired rows are treated as released
- `status` — "pending" | "confirmed" | "expired"

### `allocations`
- Confirmed allocations (after Shopify payment webhook)
- `allocation_type` — "new" | "exchange" | "keep"

### `orders`
- Shopify order records, written by webhook

### `club_settings`
- Per-club settings: `min_order_qty`, `min_distinct_numbers`, `preferred_numbers` (jsonb array)

### `shopify_product_club_map`
- Maps Shopify product IDs → club UUIDs (one or two products per club: mens + womens)
- `jersey_gender` — "mens" | "womens" | "unisex"

### `competition_age_groups`
- Manual override table for edge cases in gender/cross-pool detection
- `teams.gender` is the primary source; this table is override-only

### `admin_users`
- UUID, email — controls who can access the admin panel
- Public signup is disabled; must be manually added

### `webhook_events`
- Idempotency log for Shopify webhooks (prevents double-processing)

---

## The Allocation Engine (`src/services/allocation.ts`)

**Always read `ALLOCATION_LOGIC.md` first.** Key functions:

### `suggestNumbersForClubRanked(input)`
Returns ranked list of available numbers for a club + size. Two code paths:
- **Team-aware path** (`hasTeamContext = true`): when `divisionCode`, `teamName`, or `ageGroup` is passed. Hard-blocks same-team numbers; penalises adjacent-age different-team numbers.
- **YOB-window path** (`hasTeamContext = false`): when no team context at all. Blocks any number held by a player within ±1 YOB window.

`hasTeamContext` is true if ANY of `divisionCode`, `teamName`, `ageGroup` is non-undefined. Since the widget always passes `ageGroup` when known, it is almost always in team-aware mode.

### `smartCheckNumber(clubId, jerseyNumber, options)`
Checks a specific number for clashes + stock. Same two paths as above.

### `lookupPlayerByName(params)`
Fuzzy name+YOB search against `players` table for a given club. Returns:
- `found`, `playerId`, `matchedFirstName`, `matchedLastName`
- `currentJerseyNumber`, `previousInventoryId`
- `divisionCode`, `teamName` — **Plan B**: the player's team from the DB record

### `reserveNumberForPurchase(input)`
Creates a `pending_allocations` row (30-min hold). Calls the `reserve_jersey` Postgres RPC (atomic, handles race conditions).

### `isAgeGroupCrossPool(clubId, ageGroup)`
Returns true if the age group has `Mixed` gender teams at this club AND the club has both a mens and womens Shopify product. Used to decide whether jersey numbers must be unique across gender pools.

---

## Widget Flow (`src/components/JerseyWidget.tsx`)

Customer-facing, embedded as a Shopify iframe. All searching fires **only on button click** — no auto-triggers.

**State machine:**
1. Size comes from Shopify variant selector (postMessage)
2. Player enters: First name, Last name, YOB, New to club? (Yes/No)
3. Click "Find Available Numbers":
   - If **returning player** (New = No) and not yet looked up → runs `lookupPlayerByName`
   - If player found → shows "Did you mean [name]?" identity confirm
   - If identity confirmed + player has existing jersey → "Still keeping #X?" prompt
   - If keeping jersey → "Playing up an age group?" prompt
   - Once all prompts answered → runs `suggestNumbersForClubRanked`
4. Player picks a number from the grid
5. Disclaimer checkbox appears: "I accept responsibility for ensuring my playing number won't clash with other players in my team."
6. Click "Confirm & Reserve" → `reserveNumberForPurchase` → sends postMessage to Shopify parent

**Plan B** (different-team clash exemption):
- When a returning player is confirmed AND their DB record has a non-null `division_code`, the widget passes `divisionCode`/`teamName` to the suggestion functions
- This activates team-aware mode: only same-team numbers are hard-blocked; ±1 YOB different-team numbers are allowed

**Playing up:**
- `effectiveAgeGroup` = `nextAgeGroup(derivedAgeGroup)` when `keepExistingJersey === true && playingUp === true`
- `yobForSearch` = `undefined` (bypasses YOB window, uses higher age group's window)

---

## BC CSV Import (`src/components/Importer.tsx`)

Imports Basketball Connect CSV files to populate `players` and `teams`.

**Two competition formats:**
- **Gold Coast Basketball**: Team name format `"JGC1 Celtics Leprechauns"` → divisionCode = "JGC1", teamName = "Celtics Leprechauns". Strategy: `gc_teamname`.
- **Seahawks BC**: Team name format `"Clippers 14B.2"` → club = "Clippers", divisionCode = "14B.2". Strategy: `north_gc`.

**Import modes**: Merge (update existing records) or Replace (wipe and re-import club).

**YOB estimation**: At import time, calculates `estimated_yob_min`/`estimated_yob_max` from age_group + season year. Updates `bc_last_seen_season`.

**Known quirk**: "Kings/Wildcats 10G.1 SH" is a combined team from an older Seahawks CSV (two clubs played U10G together). Their club is stored as `is_client = false` and the widget is inactive for them. Leave it as-is.

---

## Shopify Integration

- Widget is embedded as an iframe on Shopify product pages via `buy-buttons.liquid` theme snippet
- Size is sent to widget via `postMessage` when variant changes
- On reservation, widget posts back: `{ type: "h2h:reservation:ready", jerseyNumber, pendingAllocationId }`
- At checkout, `pendingAllocationId` is sent as a line-item property
- Shopify fires `orders/create` webhook → Vercel route `api/shopify/orders-create.ts` → confirms allocation

**Product mapping**: Each club has 1–2 Shopify products mapped in `shopify_product_club_map`. Dual product support (mens + womens) was added in Task #33.

---

## Admin Panel

Accessed at `/admin/*` routes. Protected by Supabase Auth — user must be in `admin_users` table. Public signup is off.

Key pages: Club Manager, Club Overview, Players, Importer, Stock Planner, Allocation History, Sales History, Competition Gender Admin.

---

## Deployment

- **Vercel**: Auto-deploys from GitHub `main` branch. Environment variables: `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`, `SHOPIFY_WEBHOOK_SECRET`.
- **Supabase**: Migrations tracked in `supabase/migrations/`. Apply via Supabase MCP or dashboard.
- To deploy: push to GitHub main → Vercel auto-builds.

---

## Pending Work

| # | Task | Notes |
|---|---|---|
| — | Map real Shopify products for every live client club | Dual mens/womens flow is fully built and verified live end-to-end 2026-06-23 (real checkout → webhook → player/inventory/orders). All 11 real `is_client=true` clubs currently have **zero** Shopify product mappings — use the admin Product Mapping page (fixed 2026-06-23 to set `product_type` correctly). Confirm per club/product whether unisex-only or dual, and the real size labels — never assume from another club/product. |

---

## Key Decisions & Non-Obvious Rules

1. **`is_client` flag**: All BC clubs are imported regardless. `is_client = true` is the only switch that activates the widget for a club. Flip it in the `clubs` table when a club goes live.

2. **Player inactivity**: `bc_last_seen_season < current_year - 2` = released. `bc_last_seen_season IS NULL` = treat as active (conservative — these are widget-purchase players who've never appeared in a BC import). **Bug fixed 2026-06-22**: this filter previously only applied in the YOB-window fallback path (`smartCheckNumber`/`suggestNumbersForClubRanked`'s `else` branch) — the team-aware path (the default whenever a team is known, i.e. almost always) never checked it at all, so a released player's old number could never free up in the common case. Fixed by applying the active-player filter directly in the SQL queries for both paths.

3. **YOB is null for BC players**: BC CSV has no YOB. The `year_of_birth` column on `players` is only populated when a player completes a widget purchase. Clash checking uses `estimated_yob_min`/`estimated_yob_max` for BC-imported players.

4. **Inventory statuses are title-case**: "Available", "Allocated", "Pending", "Written Off". Do not use uppercase or lowercase. **Critical bug fixed 2026-06-22**: the DB's `status_check` constraint never actually allowed `'Written Off'` or `'Pending'` as values — only `Available`/`Reserved`/`Allocated` (+ lowercase). Every order-confirmation write-off (releasing an old number for a new one) would have failed with a constraint violation in production. Fixed by widening the constraint.

5. **Written-off jerseys don't return to stock**: The physical jersey is gone. Only "Available" inventory can be allocated. **Related bug fixed 2026-06-22**: the anon RLS policy on `inventory` only exposed `status = 'Available'` rows, so `lookupPlayerByName`'s `previousInventoryId` (the returning player's currently-Allocated jersey, needed to write it off) always resolved to `null` in production — silently breaking this entire flow upstream of the constraint bug above. Fixed by widening the policy to also expose `Allocated` rows (still scoped to mapped clubs; `Written Off`/`Pending` remain hidden from anon).

6. **No 69**: Valid jersey numbers are 0–99 excluding 69 (99 usable numbers).

7. **Cross-pool check**: Only applies when (a) the age group has Mixed gender teams at the club AND (b) the club has both mens and womens products configured. Both conditions required.

8. **`teams.gender` is authoritative** for cross-pool detection, not `competition_age_groups`. The latter table is manual override only.

9. **Reservation hold is 30 minutes** (changed from 15 in Task #35 — checkout took 13 of 15 in testing).

10. **Race conditions**: Jersey reservation uses a Postgres RPC `reserve_jersey` (atomic). Never bypass this with a direct INSERT to `pending_allocations`.

11. **Admin auth**: The `admin_users` table controls access. To add an admin: insert their Supabase auth UUID and email. Public signup is permanently disabled.

12. **Never assume product config or size labels across clubs/products**: confirmed 2026-06-23 — garment patterns (and therefore size labels) vary per club and even per product within the same club (e.g. a unisex singlet and its dual-product female counterpart can use completely different size ranges — Hoop2Hoop's unisex uses YXS/YS/YM/YL/XS/S/M/L/XL/2XL/3XL, NOT the youth-numbered G6...22 set used by its female product). Always confirm directly with the user whether a club is unisex-only or unisex+female dual-product, and what the actual size labels are for each product, before setting up `club_sizes`/inventory. Never copy/duplicate another product's or club's size set as a shortcut.

13. **`club_sizes` is scoped by `(club_id, size_label, product_type)`**: a size label can be reused across product types (mens/womens almost always share the same size names with separate stock pools). **Bug fixed 2026-06-23**: the original unique constraint was `(club_id, size_label)` only, which made the multi-product design impossible the moment two product types shared a size label. Fixed by widening the constraint to include `product_type`.
