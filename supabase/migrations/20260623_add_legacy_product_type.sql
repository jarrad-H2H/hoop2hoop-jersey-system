-- Warriors sells two unisex products: their own current-supplier stock ("default")
-- and a separate old-supplier product ("legacy"). Neither is gendered, but each is its
-- own stock pool. All five product_type CHECK constraints only allowed
-- default/mens/womens, which would have rejected 'legacy' the moment real stock or a
-- mapping row was inserted. Widened to add 'legacy' as a recognized pool label.
ALTER TABLE public.inventory DROP CONSTRAINT inventory_product_type_check;
ALTER TABLE public.inventory ADD CONSTRAINT inventory_product_type_check
  CHECK (product_type = ANY (ARRAY['default'::text, 'mens'::text, 'womens'::text, 'legacy'::text]));

ALTER TABLE public.allocations DROP CONSTRAINT allocations_product_type_check;
ALTER TABLE public.allocations ADD CONSTRAINT allocations_product_type_check
  CHECK (product_type = ANY (ARRAY['default'::text, 'mens'::text, 'womens'::text, 'legacy'::text]));

ALTER TABLE public.pending_allocations DROP CONSTRAINT pending_allocations_product_type_check;
ALTER TABLE public.pending_allocations ADD CONSTRAINT pending_allocations_product_type_check
  CHECK (product_type = ANY (ARRAY['default'::text, 'mens'::text, 'womens'::text, 'legacy'::text]));

ALTER TABLE public.club_sizes DROP CONSTRAINT club_sizes_product_type_check;
ALTER TABLE public.club_sizes ADD CONSTRAINT club_sizes_product_type_check
  CHECK (product_type = ANY (ARRAY['default'::text, 'mens'::text, 'womens'::text, 'legacy'::text]));

ALTER TABLE public.shopify_product_club_map DROP CONSTRAINT shopify_product_club_map_product_type_check;
ALTER TABLE public.shopify_product_club_map ADD CONSTRAINT shopify_product_club_map_product_type_check
  CHECK (product_type = ANY (ARRAY['default'::text, 'mens'::text, 'womens'::text, 'legacy'::text]));
