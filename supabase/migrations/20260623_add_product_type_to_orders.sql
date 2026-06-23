-- Discovered while auditing Stock Planner: the orders table (used by Stock Planner's
-- demand-trend/age-group analysis and Sales History) had no product_type column at
-- all, and the webhook never even selected pending_allocations.product_type to carry
-- it forward. For a dual-product club, orders sharing a size label across mens/womens
-- pools would be silently conflated in all order-based reporting.
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS product_type text NOT NULL DEFAULT 'default';
