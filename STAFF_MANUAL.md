# H2H Jersey Number Allocator — Staff Manual

This is the plain-English guide to the jersey number system: what it does, how a customer
order actually flows, and exactly how to process the day-to-day jobs — exchanges, returns,
fixing player records, and what to do when something looks wrong.

This is **not** a technical document. If you ever need the technical detail behind any of
this, ask Jarrad — this manual is everything you need for normal day-to-day use.

---

## 1. What This System Does

When a parent buys a jersey on the club's Shopify page, a small form (the "widget")
appears on the product page asking for the player's details. It:

1. Lets them pick an available **jersey number** for the size they're buying.
2. Makes sure that number **isn't already worn by someone else on the same team**.
3. **Reserves** that number and that physical jersey for 30 minutes while they check out.
4. Once they pay, the system **permanently records** the player against that number and
   marks the physical jersey as no longer available to anyone else.

Everything in the admin panel exists to support that — checking stock, fixing mistakes,
handling exchanges and returns, and keeping an eye on whether anything's broken.

---

## 2. Key Things You Need to Understand

**A number can be reused — just not within the same team.**
Two different teams at the same club can absolutely both have a "#7". The system only
blocks a number if someone *on the same team* already has it. If you ever see a "team
clash" warning, that's what it means — don't override it without checking with the
family first.

**"Available" stock means a physical jersey sitting in the warehouse, unclaimed.**
Once a customer buys it, that exact jersey gets marked **Allocated** to that player — it's
not deleted, it's just no longer offered to anyone else. If a jersey gets written off
(damaged, lost, sold), it's marked **Written Off** and never comes back into available
stock — that physical jersey is gone for good as far as the system's concerned.

**A reservation only lasts 30 minutes.**
If a customer picks a number and size but doesn't finish checkout within 30 minutes, the
hold automatically releases and that number/size becomes available to someone else again.
You don't need to do anything for this — it happens on its own.

**Players who haven't played in over 2 seasons are treated as inactive.**
Their old number quietly becomes available for someone else to take. This is automatic —
you don't need to manually "free up" an old player's number just because they've left,
unless you want it gone immediately rather than waiting.

---

## 3. The Admin Panel — Where Everything Lives

Log in at the admin panel and you'll see this menu down the left:

| Page | What it's for |
|---|---|
| **Dashboard / Club Overview** | Quick snapshot of a club — player counts, numbers used, etc. |
| **System Health** | Automated checks for things that might be broken — check this first if something seems off |
| **Club Manager** | Add clubs, turn the widget on/off per club (`is_client`) |
| **Inventory** | See exactly what stock (which numbers, which sizes) is Available vs Allocated for a club |
| **Product Mapping** | Links a club's Shopify product(s) to the club record — only Jarrad/admin should touch this |
| **Players** | Browse, search, and fix player records (names, YOB, numbers); soft-delete duplicates |
| **Number Allocation** | **The main tool for staff** — manually allocate, exchange, end, or return jerseys |
| **Allocation History** | Full log of every allocation/exchange/return ever done — useful for "what happened to this number" questions |
| **Sales History** | Every Shopify order that's gone through the widget |
| **Stock Planner** | Reorder recommendations — how much stock to print/order next |
| **Bulk Stock Upload** | Add new stock in bulk, by typing numbers in or uploading a CSV/Excel file |
| **Cross-Club Search** | Search a player or order **without knowing which club** they belong to |
| **CSV Importer** | Bulk-imports competition data (teams/players) from Basketball Connect — admin only |
| **Competition Gender Admin** | Manual overrides for mixed-gender age groups — admin only |

---

## 4. Day-to-Day Tasks

### 4.1 Checking what's in stock for a club

Go to **Inventory**, pick the club (and Product Type, if that club sells mens/womens
separately). You'll see, per size: how many are **Available**, how many **Allocated**,
and the actual numbers in each bucket.

### 4.2 Adding new stock

Go to **Bulk Stock Upload**, pick the club and product type. Two ways to add numbers:

- **Type them in manually** — for each size, type the jersey numbers (comma-separated)
  you're adding. The quantity fills in automatically.
- **Upload a file** — a CSV or Excel file with a `size` column and a `jersey_number`
  column (one row per physical jersey). The system pre-fills the manual fields from your
  file so you can double-check everything before saving — nothing is saved until you
  click **"Upload Stock to Inventory"**.

Sizes must already exist for that club before you can add stock for them (add a size
first if it's missing).

### 4.3 Finding a player or order when you don't know which club

Go to **Cross-Club Search**. Type a name, jersey number, or Shopify order number — it
searches every club at once and tells you which club it belongs to.

### 4.4 Processing a size or number exchange

This is the most common staff job. Go to **Number Allocation**:

1. Pick the **Club**, **Product Type**, and **Size** at the top.
2. In the **Player** field, search by name or current jersey number and select them.
   Their current number shows under "Current Allocation".
3. Scroll to **"Exchange / Swap Jersey"**.
4. Set the **New Size** and either type a **New Number**, or click **"Suggest"** to get a
   list of clash-free numbers that have stock in that size — click one to use it.
5. Pick a **Reason** from the dropdown (Size exchange, Damaged jersey, Number preference,
   Admin correction, Other).
6. Click **"Confirm Exchange"**.

What happens automatically:
- Their old jersey is freed back to Available stock.
- The new number is checked for clashes and stock, then reserved and linked to the player.
- The whole exchange is logged (visible later in **Allocation History**) with your reason
  attached, so there's always a record of why a number changed.

If you get a "Cannot exchange" message, it's telling you exactly why (team clash, or no
stock) — pick a different number/size and try again.

### 4.5 A player is leaving the club (end their allocation)

In **Number Allocation**, search for and select the player, then click
**"End Allocation (free number)"** under "Current Allocation". This frees their number
back to Available stock and clears it from their record. Use this instead of an exchange
when there's no new number being issued.

### 4.6 A jersey is physically returned to the warehouse (no player/number change)

Scroll to the bottom of **Number Allocation** → **"Return Jersey to Stock (Warehouse)"**.
Enter the size and number, click **"Return to Stock"**. This only changes the inventory
status back to Available — it does **not** touch any player record. Use this for things
like a customer returning a wrong/unworn jersey, separate from any exchange.

> If a jersey is damaged or unusable, don't return it to stock — that would offer a
> defective jersey to the next customer. Instead, process it as an exchange with reason
> "Damaged jersey" (which issues the player a fresh one) and leave the damaged physical
> jersey out of the system entirely, or ask Jarrad how to mark it Written Off if it needs
> to come out of count.

### 4.7 Fixing a player's record (wrong name, YOB, or number)

Go to **Players**, select the club, find them in the list, and use **Edit Name**,
**Edit YOB**, or **Edit #** inline. These are quick corrections to the player record
itself — they do **not** touch inventory. If you're changing their *number* (not just
fixing a typo), use the Exchange flow in Number Allocation instead, so the old number
properly frees up and the new one is properly clash-checked and reserved.

**Removing a duplicate or wrong player record**: click **Delete** on that player's row.
This doesn't permanently destroy anything — it's a "soft delete." Tick **"Show deleted
players"** at the top of the page to see anything you've removed, and **Restore** it if
you change your mind.

### 4.8 A customer says "the website/widget isn't working"

Before assuming something's broken, check the usual culprits:

- **Did they actually fill in every field?** The "Add to Cart" button stays greyed out
  until name, YOB, gender (if asked), "new to club?", team, and a chosen number are all
  filled in. This is the single most common "it's not working" complaint — it's working,
  they just haven't finished the form.
- **Did they select a size first?** Until a size is picked from the product page's normal
  size selector, the widget has nothing to search stock against.
- Ask them to try refreshing the page and re-selecting their size if it seems stuck.

If none of that explains it, check **System Health** (see 4.10) and then escalate to
Jarrad with the club name, approximate time, and what the customer described.

### 4.9 You got a "Low stock alert" email

This means a club's available stock for a particular size has dropped to or below its
reorder buffer. Go to **Stock Planner** for that club to see the recommended reorder
quantity, or just check **Inventory** directly if you already know what's needed.

### 4.10 Something flagged on the System Health page

Each flag on that page explains in plain English what it means and exactly how to fix it
— read the card, it's written for this purpose. If you're ever unsure whether a flag is
serious, screenshot it and ask Jarrad rather than guessing.

---

## 5. Frequently Asked Questions

**Q: A parent wants their kid's old number back after a season away. Can we just give it
to them?**
A: If the player's been inactive 2+ seasons, their old number is already back in the
available pool automatically — search for the number in Number Allocation and allocate
it normally if it's still free. If someone else has already taken it in the meantime,
it's no longer available and they'll need to choose another.

**Q: Customer wants to swap to a completely different size category (e.g. youth to
adult) — is that still just an "Exchange"?**
A: Yes — Exchange handles both size and number changes together, regardless of how
different the sizes are. Just make sure you're picking from sizes that actually exist for
that club/product type.

**Q: Two siblings/players ended up with the same number on the same team — how?**
A: This shouldn't be possible through the widget (same-team clashes are blocked
automatically). If you see it, it was very likely a manual admin correction that
bypassed the check, or one of the player records is a duplicate that should be merged or
soft-deleted. Check **Players** for duplicates first.

**Q: A customer's reservation expired before they finished paying and now they're stuck —
what do I do?**
A: Nothing special — once it expires, the number/size is back in the open pool and they
(or you, on their behalf via Number Allocation) can simply pick it again, assuming nobody
else has taken it in the meantime.

---

## 6. Who to Contact

For anything not covered here, or if you're not confident about an action that changes a
player's number (especially anything that looks like it might cause a team clash),
contact Jarrad before proceeding. It's always better to ask than to risk two players on
the same team ending up with the same number.

---

## 7. Quick Glossary

| Term | Meaning |
|---|---|
| **Clash** | Two players on the same team with the same number — not allowed |
| **Available** | A physical jersey sitting in stock, not yet claimed |
| **Allocated** | A physical jersey currently assigned to a specific player |
| **Written Off** | A physical jersey that's gone for good (damaged/lost/sold) — never returns to stock |
| **Reservation / Hold** | A 30-minute lock on a number+size while a customer checks out |
| **Active / Inactive player** | Inactive = hasn't played in 2+ seasons; their number frees up automatically |
| **Product Type** | Which stock pool a club's product draws from — most clubs have one ("default"), some have separate mens/womens pools |
| **Soft delete** | Hiding a record instead of destroying it — always recoverable |
