-- ============================================================
-- Migration: update reserve_jersey to use teams.gender for
-- mixed detection (primary), with competition_age_groups fallback
-- for new players not yet in BC data.
-- ============================================================

DROP FUNCTION IF EXISTS public.reserve_jersey(
  uuid, integer, text, integer, integer,
  text, integer, text, text, boolean, boolean, integer, uuid, text
);

CREATE OR REPLACE FUNCTION public.reserve_jersey(
  p_club_id                 uuid,
  p_jersey_number           integer,
  p_size                    text,
  p_season_year             integer,
  p_year_of_birth           integer,
  p_team_id                 text    DEFAULT NULL,
  p_expires_minutes         integer DEFAULT 15,
  p_player_first_name       text    DEFAULT NULL,
  p_player_last_name        text    DEFAULT NULL,
  p_is_new_player           boolean DEFAULT NULL,
  p_keep_existing_jersey    boolean DEFAULT NULL,
  p_previous_jersey_number  integer DEFAULT NULL,
  p_previous_inventory_id   uuid    DEFAULT NULL,
  p_product_type            text    DEFAULT 'default'
)
RETURNS TABLE(pending_allocation_id uuid, inventory_id uuid)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_inv_id      uuid;
  v_pending_id  uuid;
  v_is_mixed    boolean := false;
  v_player_age  integer;
  v_age_label   text;
  v_team_gender text;
BEGIN
  -- Widget runs as anon: only allow clubs wired to a Shopify product
  IF NOT EXISTS (
    SELECT 1 FROM shopify_product_club_map m WHERE m.club_id = p_club_id
  ) THEN
    RAISE EXCEPTION 'Club is not enabled for online reservations';
  END IF;

  -- ── Mixed gender detection ──────────────────────────────────
  --
  -- Phase 1 (primary): look up the player by name + club to find
  -- their team, then read teams.gender directly.
  -- This handles known players accurately — a U10 girl in a
  -- girls-only division is correctly identified as single-gender.
  --
  -- Phase 2 (fallback): if the player is not found in the DB
  -- (new player not yet in BC data), fall back to the
  -- competition_age_groups table which is admin-configured.
  -- This applies a conservative cross-pool check for age groups
  -- that have any Mixed divisions — over-blocks in rare edge
  -- cases but never under-blocks.

  IF p_player_first_name IS NOT NULL AND p_player_last_name IS NOT NULL THEN

    -- Phase 1: player lookup via name + club
    SELECT t.gender INTO v_team_gender
    FROM   players pl
    JOIN   teams   t  ON t.name = pl.team_id
                      AND t.club_id_uuid = p_club_id
    WHERE  pl.club_id    = p_club_id::text
      AND  pl.first_name ILIKE p_player_first_name
      AND  pl.last_name  ILIKE p_player_last_name
    LIMIT 1;

    IF v_team_gender IS NOT NULL THEN
      -- Found the player — use their team's gender directly
      v_is_mixed := (v_team_gender = 'Mixed');
    ELSE
      -- Phase 2 fallback: player not in DB yet, use competition_age_groups
      v_player_age := EXTRACT(YEAR FROM now())::int - p_year_of_birth;
      v_age_label  := CASE
        WHEN v_player_age >= 18 THEN 'Open'
        ELSE 'U' || v_player_age::text
      END;

      SELECT EXISTS (
        SELECT 1
        FROM   teams t
        JOIN   competition_age_groups cag ON cag.competition_id = t.competition_id
        WHERE  t.club_id_uuid  = p_club_id
          AND  cag.age_label   = v_age_label
          AND  cag.gender_type = 'Mixed'
      ) INTO v_is_mixed;
    END IF;

  ELSE
    -- No player name provided — use YOB + competition_age_groups
    v_player_age := EXTRACT(YEAR FROM now())::int - p_year_of_birth;
    v_age_label  := CASE
      WHEN v_player_age >= 18 THEN 'Open'
      ELSE 'U' || v_player_age::text
    END;

    SELECT EXISTS (
      SELECT 1
      FROM   teams t
      JOIN   competition_age_groups cag ON cag.competition_id = t.competition_id
      WHERE  t.club_id_uuid  = p_club_id
        AND  cag.age_label   = v_age_label
        AND  cag.gender_type = 'Mixed'
    ) INTO v_is_mixed;
  END IF;

  -- ── Cross-pool clash check for mixed age groups ─────────────
  IF v_is_mixed AND p_product_type IN ('mens', 'womens') THEN

    -- Block if already allocated in the OTHER pool
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

    -- Block if currently being reserved in the OTHER pool
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

  -- ── Lock one available inventory row in the requested pool ──
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

  -- ── Allocate ────────────────────────────────────────────────
  UPDATE inventory
  SET    status = 'Allocated', allocation_date = now()
  WHERE  id = v_inv_id;

  INSERT INTO pending_allocations (
    club_id, inventory_id, jersey_number, size,
    season_year, year_of_birth, team_id,
    player_first_name, player_last_name,
    is_new_player, keep_existing_jersey,
    previous_jersey_number, previous_inventory_id,
    product_type, status, expires_at
  ) VALUES (
    p_club_id, v_inv_id, p_jersey_number, p_size,
    p_season_year, p_year_of_birth, p_team_id,
    p_player_first_name, p_player_last_name,
    p_is_new_player, p_keep_existing_jersey,
    p_previous_jersey_number, p_previous_inventory_id,
    p_product_type, 'reserved',
    now() + make_interval(mins => GREATEST(1, p_expires_minutes))
  )
  RETURNING id INTO v_pending_id;

  INSERT INTO allocations (club_id, jersey_number, size, allocation_type, product_type, note)
  VALUES (p_club_id, p_jersey_number, p_size, 'new', p_product_type,
          'Reserved via widget (pending allocation)');

  RETURN QUERY SELECT v_pending_id, v_inv_id;
END;
$$;
