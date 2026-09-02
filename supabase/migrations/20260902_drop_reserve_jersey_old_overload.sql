-- Drop the old 14-param overload of reserve_jersey.
-- The new 15-param version (with p_is_made_to_order DEFAULT false) handles all cases,
-- including non-MTO calls where the param is omitted (defaults to false).
DROP FUNCTION IF EXISTS public.reserve_jersey(
  uuid, integer, text, integer, integer,
  text, integer, text, text,
  boolean, boolean, integer, uuid, text
);
