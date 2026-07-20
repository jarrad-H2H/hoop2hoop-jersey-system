-- Adds optional Simple Bundles jersey component property name to the product mapping.
-- When set, widget.js uses this exact property name to read the selected jersey size
-- from Simple Bundles' <select name="properties[...]"> instead of the standard
-- variant-radios / variant-selects detection path.
-- Null (default) = standard Shopify product, no change to existing behaviour.
ALTER TABLE shopify_product_club_map
  ADD COLUMN IF NOT EXISTS bundle_jersey_property text;
