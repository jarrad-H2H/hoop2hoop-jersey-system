-- Discovered while setting up a real dual-product club: club_sizes had
-- UNIQUE(club_id, size_label) with no product_type in the key, so two product types
-- could never share the same size label -- breaking the multi-product design entirely,
-- since mens/womens almost always use identical size naming with separate stock pools.
ALTER TABLE public.club_sizes DROP CONSTRAINT club_sizes_club_id_size_label_key;
ALTER TABLE public.club_sizes ADD CONSTRAINT club_sizes_club_id_size_label_product_type_key
  UNIQUE (club_id, size_label, product_type);
