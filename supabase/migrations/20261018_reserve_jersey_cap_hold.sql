-- reserve_jersey took the hold length from the caller with no upper limit, so anyone with the public
-- key could hold a real jersey (and block its number in clash checks) for years. The widget always
-- asks for 30 minutes (CLAUDE.md rule 9); holds are now capped at that. Same function otherwise.
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

  -- Keep the confirmed profile only if it is this club's player and shares a first or last
  -- name with the buyer's entry (the name lookup is fuzzy, so one name may differ slightly).
  SELECT pl.id INTO v_player_id
  FROM   players pl
  WHERE  pl.id = p_player_id
    AND  pl.club_id = p_club_id
    AND  pl.deleted_at IS NULL
    AND  (pl.first_name ILIKE p_player_first_name OR pl.last_name ILIKE p_player_last_name);

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
