-- Discovered while testing the "release old number for a new one" flow.

-- Bug 1: the anon SELECT policy on inventory only allowed status = 'Available', so
-- lookupPlayerByName's previousInventoryId query (which specifically targets the
-- player's currently Allocated jersey) always returned null in production. That null
-- then propagates into reserveNumberForPurchase -> the order-confirmation webhook's
-- write-off step never fires (it's guarded by `prevInventoryId` being truthy), so a
-- released jersey's inventory row stayed permanently stuck as Allocated, leaking stock
-- with no cleanup.
DROP POLICY IF EXISTS widget_read_available_inventory ON public.inventory;
CREATE POLICY widget_read_inventory_for_mapped_clubs
ON public.inventory
FOR SELECT
TO anon
USING (
  status IN ('Available', 'Allocated')
  AND EXISTS (
    SELECT 1 FROM shopify_product_club_map m
    WHERE m.club_id::text = inventory.club_id::text
  )
);

-- Bug 2: inventory.status_check never allowed 'Written Off' (or 'Pending'), despite both
-- being documented production statuses (CLAUDE.md: "Inventory statuses are title-case:
-- Available, Allocated, Pending, Written Off" / "Written-off jerseys don't return to
-- stock"). Every order-confirmation webhook write-off (api/shopify/orders-create.ts,
-- keepExistingJersey=false path) would have failed with a constraint violation.
ALTER TABLE public.inventory DROP CONSTRAINT status_check;
ALTER TABLE public.inventory ADD CONSTRAINT status_check
  CHECK (status = ANY (ARRAY[
    'Available'::text, 'Reserved'::text, 'Allocated'::text, 'Pending'::text, 'Written Off'::text,
    'available'::text, 'reserved'::text, 'allocated'::text
  ]));
