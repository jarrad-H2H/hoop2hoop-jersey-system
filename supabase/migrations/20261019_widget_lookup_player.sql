-- The returning-player lookup ("Did you mean…?", made-to-order re-orders) runs here, so the public
-- (anon) key doesn't need to read players' names (20261019_players_anon_clash_columns_only.sql).
-- Same club only. Typed text is compared as plain text, never as a pattern, ignoring capitals,
-- spaces, hyphens, apostrophes and accents.
--   1. Every player whose first name and surname both match is returned, so the buyer can pick.
--   2. Otherwise ONE player whose surname matches (or one part of a double surname: Smith finds
--      Smith-Williams) and whose age fits the typed birth year: their exact birth year, else their
--      age group's estimated range allowing one age group of playing up (the BC importer's rule for
--      linking website buyers). The closest first name wins: same first 3 letters, then same first
--      letter (Mike finds Michael), then any; then the exact birth year, then a birth year inside
--      the age group's range (rather than only fitting as playing up), then the age group.
-- previous_inventory_id is the stock jersey the order webhook writes off if they say it will be their
-- only jersey: the one linked to them, else their own purchase (widget_own_purchased_jersey).
CREATE OR REPLACE FUNCTION public.widget_lookup_player(p_club_id uuid, p_first_name text, p_last_name text, p_year_of_birth integer DEFAULT NULL::integer, p_age_group text DEFAULT NULL::text, p_product_type text DEFAULT 'default'::text)
 RETURNS TABLE(player_id uuid, first_name text, last_name text, final_shirt integer, previous_inventory_id uuid, division_code text, team_name text, age_group text)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
#variable_conflict use_column
DECLARE
  -- accents left behind by NFKD (U+0300-U+036F), removed before a surname is split into parts
  v_marks      text := '[' || chr(768) || '-' || chr(879) || ']';
  v_first_raw  text := lower(btrim(coalesce(p_first_name, '')));
  v_last_raw   text := lower(btrim(coalesce(p_last_name, '')));
  v_first_key  text := regexp_replace(normalize(lower(coalesce(p_first_name, '')), NFKD), '[^a-z]', '', 'g');
  v_last_key   text := regexp_replace(normalize(lower(coalesce(p_last_name, '')), NFKD), '[^a-z]', '', 'g');
  v_last_parts text[];
  v_ids        uuid[];
BEGIN
  IF v_first_raw = '' OR v_last_raw = ''
     OR NOT EXISTS (SELECT 1 FROM shopify_product_club_map m WHERE m.club_id = p_club_id) THEN
    RETURN;
  END IF;
  v_last_parts := array_remove(regexp_split_to_array(
                    regexp_replace(normalize(lower(p_last_name), NFKD), v_marks, '', 'g'), '[^a-z]+'), '');

  -- 1. Same first name and surname
  SELECT array_agg(x.id ORDER BY x.created_at, x.id) INTO v_ids
  FROM (
    SELECT pl.id, pl.created_at
    FROM   players pl
    WHERE  pl.club_id = p_club_id
      AND  pl.deleted_at IS NULL
      AND  ((lower(btrim(pl.first_name)) = v_first_raw AND lower(btrim(pl.last_name)) = v_last_raw)
            OR (v_first_key <> '' AND v_last_key <> ''
                AND regexp_replace(normalize(lower(coalesce(pl.first_name, '')), NFKD), '[^a-z]', '', 'g') = v_first_key
                AND regexp_replace(normalize(lower(coalesce(pl.last_name, '')), NFKD), '[^a-z]', '', 'g') = v_last_key))
    ORDER  BY pl.created_at, pl.id
    LIMIT  10
  ) x;

  -- 2. Same surname (or part of it), birth year fits, closest first name
  IF v_ids IS NULL AND p_year_of_birth IS NOT NULL AND v_first_key <> '' AND v_last_key <> '' THEN
    SELECT ARRAY[c.id] INTO v_ids
    FROM (
      SELECT pl.id, pl.created_at, pl.year_of_birth, pl.estimated_yob_min, pl.estimated_yob_max, pl.age_group,
             regexp_replace(normalize(lower(coalesce(pl.first_name, '')), NFKD), '[^a-z]', '', 'g') AS first_key,
             regexp_replace(normalize(lower(coalesce(pl.last_name, '')), NFKD), '[^a-z]', '', 'g') AS last_key,
             array_remove(regexp_split_to_array(
               regexp_replace(normalize(lower(coalesce(pl.last_name, '')), NFKD), v_marks, '', 'g'),
               '[^a-z]+'), '') AS last_parts
      FROM   players pl
      WHERE  pl.club_id = p_club_id
        AND  pl.deleted_at IS NULL
        AND  CASE WHEN pl.year_of_birth IS NOT NULL THEN pl.year_of_birth = p_year_of_birth
                  ELSE p_year_of_birth BETWEEN pl.estimated_yob_min AND pl.estimated_yob_max + 2 END
    ) c
    WHERE  c.last_key = v_last_key
       OR  EXISTS (SELECT 1 FROM unnest(c.last_parts) AS part WHERE length(part) >= 3 AND part = ANY (v_last_parts))
    ORDER  BY CASE WHEN c.first_key = v_first_key THEN 0
                   WHEN length(v_first_key) >= 3 AND left(c.first_key, 3) = left(v_first_key, 3) THEN 1
                   WHEN left(c.first_key, 1) = left(v_first_key, 1) THEN 2
                   ELSE 3 END,
              coalesce(c.year_of_birth = p_year_of_birth, false) DESC,
              coalesce(p_year_of_birth BETWEEN c.estimated_yob_min AND c.estimated_yob_max, false) DESC,
              coalesce(c.age_group = p_age_group, false) DESC,
              c.created_at, c.id
    LIMIT  1;
  END IF;

  RETURN QUERY
  SELECT pl.id, pl.first_name, pl.last_name, pl.final_shirt,
         CASE WHEN pl.final_shirt IS NOT NULL THEN coalesce(
           (SELECT i.id FROM inventory i
            WHERE  i.club_id = p_club_id
              AND  i.allocated_player_id = pl.id
              AND  i.jersey_number = pl.final_shirt
              AND  i.status = 'Allocated'
              AND  i.product_type = p_product_type
            LIMIT  1),
           CASE WHEN btrim(coalesce(pl.first_name, '')) <> '' AND btrim(coalesce(pl.last_name, '')) <> ''
                THEN widget_own_purchased_jersey(p_club_id, pl.final_shirt, p_product_type,
                                                 btrim(pl.first_name), btrim(pl.last_name), pl.year_of_birth)
           END)
         END,
         pl.division_code, pl.team_name, pl.age_group
  FROM   unnest(v_ids) WITH ORDINALITY AS ids(id, ord)
  JOIN   players pl ON pl.id = ids.id
  ORDER  BY ids.ord;
END;
$function$;

REVOKE ALL ON FUNCTION public.widget_lookup_player(uuid,text,text,integer,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.widget_lookup_player(uuid,text,text,integer,text,text) TO anon, authenticated, service_role;
