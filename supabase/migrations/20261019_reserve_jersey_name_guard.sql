-- reserve_jersey kept a returning player's confirmed profile ("Did you mean…?") only when the typed
-- first name or surname matched it exactly, as a pattern. Since widget_lookup_player also confirms
-- near names ("Mike Smith" -> Michael Smith-Williams), those confirmations were dropped and the
-- order created a duplicate profile; and a typed "%" made any profile at the club pass. The guard
-- now accepts exactly the profiles the lookup can offer for the typed name and birth year. The name
-- rules live in two helpers shared by both functions (same idea as nameKey in src/services/bcImport.ts).

-- A name with capitals, spaces, hyphens, apostrophes and accents removed: "O'Brien-Zoë" -> obrienzoe
CREATE OR REPLACE FUNCTION public.player_name_key(p_name text)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO ''
AS $function$
  SELECT regexp_replace(normalize(lower(coalesce(p_name, '')), NFKD), '[^a-z]', '', 'g')
$function$;

-- The parts of a name, e.g. a double surname's halves: "Smith-Williams" -> {smith, williams}.
-- Accents left behind by NFKD (U+0300-U+036F) are removed first so they don't split a word.
CREATE OR REPLACE FUNCTION public.player_name_parts(p_name text)
 RETURNS text[]
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO ''
AS $function$
  SELECT array_remove(regexp_split_to_array(
           regexp_replace(normalize(lower(coalesce(p_name, '')), NFKD), '[' || chr(768) || '-' || chr(879) || ']', '', 'g'),
           '[^a-z]+'), '')
$function$;

-- Only used inside widget_lookup_player and reserve_jersey (which run as their owner).
REVOKE ALL ON FUNCTION public.player_name_key(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.player_name_parts(text) FROM PUBLIC, anon, authenticated;

-- Same lookup as 20261019_widget_lookup_player.sql, using the helpers.
CREATE OR REPLACE FUNCTION public.widget_lookup_player(p_club_id uuid, p_first_name text, p_last_name text, p_year_of_birth integer DEFAULT NULL::integer, p_age_group text DEFAULT NULL::text, p_product_type text DEFAULT 'default'::text)
 RETURNS TABLE(player_id uuid, first_name text, last_name text, final_shirt integer, previous_inventory_id uuid, division_code text, team_name text, age_group text)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
#variable_conflict use_column
DECLARE
  v_first_raw  text := lower(btrim(coalesce(p_first_name, '')));
  v_last_raw   text := lower(btrim(coalesce(p_last_name, '')));
  v_first_key  text := player_name_key(p_first_name);
  v_last_key   text := player_name_key(p_last_name);
  v_last_parts text[] := player_name_parts(p_last_name);
  v_ids        uuid[];
BEGIN
  IF v_first_raw = '' OR v_last_raw = ''
     OR NOT EXISTS (SELECT 1 FROM shopify_product_club_map m WHERE m.club_id = p_club_id) THEN
    RETURN;
  END IF;

  -- 1. Same first name and surname
  SELECT array_agg(x.id ORDER BY x.created_at, x.id) INTO v_ids
  FROM (
    SELECT pl.id, pl.created_at
    FROM   players pl
    WHERE  pl.club_id = p_club_id
      AND  pl.deleted_at IS NULL
      AND  ((lower(btrim(pl.first_name)) = v_first_raw AND lower(btrim(pl.last_name)) = v_last_raw)
            OR (v_first_key <> '' AND v_last_key <> ''
                AND player_name_key(pl.first_name) = v_first_key
                AND player_name_key(pl.last_name) = v_last_key))
    ORDER  BY pl.created_at, pl.id
    LIMIT  10
  ) x;

  -- 2. Same surname (or part of it), birth year fits, closest first name
  IF v_ids IS NULL AND p_year_of_birth IS NOT NULL AND v_first_key <> '' AND v_last_key <> '' THEN
    SELECT ARRAY[c.id] INTO v_ids
    FROM (
      SELECT pl.id, pl.created_at, pl.year_of_birth, pl.estimated_yob_min, pl.estimated_yob_max, pl.age_group,
             player_name_key(pl.first_name) AS first_key,
             player_name_key(pl.last_name) AS last_key,
             player_name_parts(pl.last_name) AS last_parts
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

-- reserve_jersey as in 20261018_reserve_jersey_cap_hold.sql; only the profile guard changes.
CREATE OR REPLACE FUNCTION public.reserve_jersey(p_club_id uuid, p_jersey_number integer, p_size text, p_season_year integer, p_year_of_birth integer, p_team_id text DEFAULT NULL::text, p_expires_minutes integer DEFAULT 30, p_player_first_name text DEFAULT NULL::text, p_player_last_name text DEFAULT NULL::text, p_is_new_player boolean DEFAULT NULL::boolean, p_keep_existing_jersey boolean DEFAULT NULL::boolean, p_previous_jersey_number integer DEFAULT NULL::integer, p_previous_inventory_id uuid DEFAULT NULL::uuid, p_product_type text DEFAULT 'default'::text, p_is_made_to_order boolean DEFAULT false, p_player_id uuid DEFAULT NULL::uuid)
 RETURNS TABLE(pending_allocation_id uuid, inventory_id uuid)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_inv_id      uuid;
  v_pending_id  uuid;
  v_is_mixed    boolean := false;
  v_player_age  integer;
  v_age_label   text;
  v_team_gender text;
  v_player_id   uuid;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM shopify_product_club_map m WHERE m.club_id = p_club_id
  ) THEN
    RAISE EXCEPTION 'Club is not enabled for online reservations';
  END IF;

  -- Keep the confirmed profile only if it is this club's player and the typed name could be them
  -- the way widget_lookup_player matches: the same first name and surname, or the same surname (or
  -- one part of a double surname) with a birth year that fits their age.
  SELECT pl.id INTO v_player_id
  FROM   players pl
  WHERE  pl.id = p_player_id
    AND  pl.club_id = p_club_id
    AND  pl.deleted_at IS NULL
    AND  (   (lower(btrim(pl.first_name)) = lower(btrim(p_player_first_name))
              AND lower(btrim(pl.last_name)) = lower(btrim(p_player_last_name)))
          OR (player_name_key(p_player_first_name) <> '' AND player_name_key(p_player_last_name) <> ''
              AND (   (player_name_key(pl.first_name) = player_name_key(p_player_first_name)
                       AND player_name_key(pl.last_name) = player_name_key(p_player_last_name))
                   OR ((player_name_key(pl.last_name) = player_name_key(p_player_last_name)
                        OR EXISTS (SELECT 1 FROM unnest(player_name_parts(pl.last_name)) AS part
                                   WHERE length(part) >= 3 AND part = ANY (player_name_parts(p_player_last_name))))
                       AND CASE WHEN pl.year_of_birth IS NOT NULL THEN pl.year_of_birth = p_year_of_birth
                                ELSE p_year_of_birth BETWEEN pl.estimated_yob_min AND pl.estimated_yob_max + 2 END))));

  v_player_age := EXTRACT(YEAR FROM now())::int - p_year_of_birth;
  v_age_label  := CASE
    WHEN v_player_age <= 7  THEN 'U8'
    WHEN v_player_age <= 9  THEN 'U10'
    WHEN v_player_age <= 11 THEN 'U12'
    WHEN v_player_age <= 13 THEN 'U14'
    WHEN v_player_age <= 15 THEN 'U16'
    WHEN v_player_age <= 17 THEN 'U18'
    ELSE 'Open'
  END;

  IF p_player_first_name IS NOT NULL AND p_player_last_name IS NOT NULL THEN
    SELECT t.gender INTO v_team_gender
    FROM   players pl
    JOIN   teams   t  ON t.name = pl.team_id
                      AND t.club_id_uuid = p_club_id
    WHERE  pl.club_id    = p_club_id
      AND  pl.first_name ILIKE p_player_first_name
      AND  pl.last_name  ILIKE p_player_last_name
    LIMIT 1;

    IF v_team_gender IS NOT NULL THEN
      v_is_mixed := (v_team_gender = 'Mixed');
    END IF;
  END IF;

  IF v_team_gender IS NULL THEN
    SELECT EXISTS (
      SELECT 1
      FROM   teams t
      WHERE  t.club_id_uuid = p_club_id
        AND  t.age_group    = v_age_label
        AND  t.gender       = 'Mixed'
      UNION ALL
      SELECT 1
      FROM   teams t
      JOIN   competition_age_groups cag ON cag.competition_id = t.competition_id
      WHERE  t.club_id_uuid  = p_club_id
        AND  cag.age_label   = v_age_label
        AND  cag.gender_type = 'Mixed'
    ) INTO v_is_mixed;
  END IF;

  IF v_is_mixed AND p_product_type IN ('mens', 'womens') THEN
    IF EXISTS (
      SELECT 1 FROM inventory
      WHERE  club_id        = p_club_id
        AND  jersey_number  = p_jersey_number
        AND  status         = 'Allocated'
        AND  product_type  != p_product_type
        AND  product_type  != 'default'
    ) THEN
      RETURN;
    END IF;

    IF EXISTS (
      SELECT 1 FROM pending_allocations
      WHERE  club_id        = p_club_id
        AND  jersey_number  = p_jersey_number
        AND  status         = 'reserved'
        AND  expires_at     > now()
        AND  product_type  != p_product_type
        AND  product_type  != 'default'
    ) THEN
      RETURN;
    END IF;
  END IF;

  IF p_is_made_to_order THEN
    -- Prevent a player from double-reserving the same number
    IF EXISTS (
      SELECT 1 FROM pending_allocations
      WHERE  club_id             = p_club_id
        AND  jersey_number       = p_jersey_number
        AND  status              = 'reserved'
        AND  expires_at          > now()
        AND  player_first_name   ILIKE p_player_first_name
        AND  player_last_name    ILIKE p_player_last_name
    ) THEN
      RETURN;
    END IF;

    -- Create a placeholder inventory row for the made-to-order item
    INSERT INTO inventory (club_id, jersey_number, size, status, product_type)
    VALUES (p_club_id, p_jersey_number, p_size, 'Pending', p_product_type)
    RETURNING id INTO v_inv_id;

  ELSE
    SELECT i.id INTO v_inv_id
    FROM   inventory i
    WHERE  i.club_id        = p_club_id
      AND  i.jersey_number  = p_jersey_number
      AND  i.size           = p_size
      AND  i.status         = 'Available'
      AND  i.product_type   = p_product_type
    LIMIT 1
    FOR UPDATE SKIP LOCKED;

    IF v_inv_id IS NULL THEN
      RETURN;
    END IF;

    UPDATE inventory
    SET    status = 'Allocated', allocation_date = now()
    WHERE  id = v_inv_id;
  END IF;

  INSERT INTO pending_allocations (
    club_id, inventory_id, jersey_number, size,
    season_year, year_of_birth, team_id,
    player_first_name, player_last_name,
    is_new_player, keep_existing_jersey,
    previous_jersey_number, previous_inventory_id,
    product_type, status, expires_at, player_id
  ) VALUES (
    p_club_id, v_inv_id, p_jersey_number, p_size,
    p_season_year, p_year_of_birth, p_team_id,
    p_player_first_name, p_player_last_name,
    p_is_new_player, p_keep_existing_jersey,
    p_previous_jersey_number, p_previous_inventory_id,
    p_product_type, 'reserved',
    now() + make_interval(mins => LEAST(GREATEST(1, p_expires_minutes), 30)),
    v_player_id
  )
  RETURNING id INTO v_pending_id;

  INSERT INTO allocations (club_id, jersey_number, size, allocation_type, product_type, note)
  VALUES (p_club_id, p_jersey_number, p_size,
          CASE WHEN p_is_made_to_order THEN 'keep' ELSE 'new' END,
          p_product_type,
          CASE WHEN p_is_made_to_order
               THEN 'Reserved via widget (made-to-order retention)'
               ELSE 'Reserved via widget (pending allocation)'
          END);

  RETURN QUERY SELECT v_pending_id, v_inv_id;
END;
$function$;
