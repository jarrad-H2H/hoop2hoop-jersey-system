-- Discovered while auditing ClubOverview.tsx: this view never exposed product_type,
-- so for a dual-product club, mens/womens/default stock sharing a size label would be
-- silently combined in the "Inventory by Size" summary -- same class of bug as the
-- earlier shopify-sync.ts and Bulk Stock Upload gaps. security_invoker=on preserved
-- (confirmed already set) so the view continues to enforce the underlying table's RLS.
CREATE OR REPLACE VIEW public.inventory_with_club
WITH (security_invoker=on) AS
SELECT
  i.id,
  i.club_id,
  c.name AS club_name,
  i.jersey_number,
  i.size,
  i.status,
  i.allocated_player_id,
  i.allocation_date,
  i.return_date_due,
  i.created_at,
  i.product_type
FROM inventory i
LEFT JOIN clubs c ON c.id = i.club_id;
