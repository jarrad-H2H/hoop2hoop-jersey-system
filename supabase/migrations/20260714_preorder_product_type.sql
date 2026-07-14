-- Add product_type to preorder_requests so finalise can create the right inventory rows
-- (e.g. "mens", "womens", "unisex"). Captured from shopify_product_club_map.jersey_gender
-- at webhook time based on which Shopify product the order came from.
ALTER TABLE preorder_requests
  ADD COLUMN IF NOT EXISTS product_type TEXT;
