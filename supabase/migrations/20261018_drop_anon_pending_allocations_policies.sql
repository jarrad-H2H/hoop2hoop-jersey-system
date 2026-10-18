-- The widget reads reservations through widget_reservation_holds / widget_own_purchased_jersey
-- (20261018_widget_reservation_functions.sql) and reserves through reserve_jersey, so the public
-- (anon) key no longer needs pending_allocations at all. These policies let it read every buyer's
-- name and birth year, and insert rows past reserve_jersey: fake holds that block numbers, or fake
-- "purchased" rows that the BC importer and End allocation trust.
DROP POLICY IF EXISTS widget_insert_pending_allocations ON public.pending_allocations;
DROP POLICY IF EXISTS widget_read_pending_allocations ON public.pending_allocations;
