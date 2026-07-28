-- 2026-07-28: Allow multiple Shopify products of the same product_type per club.
--
-- Background: Gold Coast Basketball is adding standalone singlet products alongside
-- their existing bundle products.  Both the bundle and the singlet are "mens" or
-- "womens" product_type, drawing from the same pre-allocated number roster.
-- The existing UNIQUE (club_id, product_type) constraint on shopify_product_club_map
-- prevented this; drop it so a club can have e.g. both a mens-bundle and a mens-singlet.
--
-- Also adds shopify_product_id to preorder_requests so confirm-size can detect when
-- the same player is ordering via a second product and create a new row rather than
-- overwriting their existing allocation.

-- 1. Drop the per-club-per-type uniqueness constraint on the product map.
--    The only uniqueness now enforced is shopify_product_id itself (the PK / existing
--    unique index on that column), which is correct: each Shopify product still maps
--    to exactly one club+product_type, but a club can now have more than one product
--    per type.
ALTER TABLE shopify_product_club_map
  DROP CONSTRAINT IF EXISTS shopify_product_club_map_club_product_type_key;

-- 2. Track which Shopify product a preorder_requests row was confirmed through.
--    NULL = not yet claimed by any product (freshly imported roster row).
--    Set to the Shopify product ID when the player first confirms their size via
--    that product's widget.  If the same player orders via a second product, a
--    new preorder_requests row is created (same assigned_number, different product).
ALTER TABLE preorder_requests
  ADD COLUMN IF NOT EXISTS shopify_product_id TEXT;
