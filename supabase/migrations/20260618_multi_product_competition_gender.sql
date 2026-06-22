-- ============================================================
-- Migration: multi-product support + competition gender settings
-- ============================================================
-- Adds:
--   1. competitions table (recreated with UUID pk)
--   2. competition_age_groups table (gender type per age label per competition)
--   3. competition_id FK on teams
--   4. product_type column on inventory, allocations, pending_allocations,
--      club_sizes, shopify_product_club_map
--   5. Updated reserve_jersey RPC with product_type + mixed gender clash logic
-- ============================================================


-- ── 1. competitions ──────────────────────────────────────────
-- Drop and recreate (table is currently empty, text id)
DROP TABLE IF EXISTS competitions CASCADE;

CREATE TABLE competitions (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text        NOT NULL UNIQUE,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE competitions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "competitions_admin_all" ON competitions
  FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM admin_users WHERE user_id = auth.uid()));

CREATE POLICY "competitions_service_role" ON competitions
  FOR ALL TO service_role USING (true);


-- ── 2. competition_age_groups ─────────────────────────────────
-- Stores the admin-configured gender type per age label per competition.
-- gender_type: 'Male' | 'Female' | 'Mixed'
-- age_label:   'U8' | 'U10' | 'U12' | 'U14' | 'U16' | 'U18' | 'Open'
CREATE TABLE IF NOT EXISTS competition_age_groups (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  competition_id  uuid        NOT NULL REFERENCES competitions(id) ON DELETE CASCADE,
  age_label       text        NOT NULL,
  gender_type     text        NOT NULL CHECK (gender_type IN ('Male', 'Female', 'Mixed')),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (competition_id, age_label)
);

ALTER TABLE competition_age_groups ENABLE ROW LEVEL SECURITY;

CREATE POLICY "cag_admin_all" ON competition_age_groups
  FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM admin_users WHERE user_id = auth.uid()));

CREATE POLICY "cag_service_role" ON competition_age_groups
  FOR ALL TO service_role USING (true);


-- ── 3. teams — add competition_id ────────────────────────────
ALTER TABLE teams
  ADD COLUMN IF NOT EXISTS competition_id uuid REFERENCES competitions(id) ON DELETE SET NULL;


-- ── 4. product_type on core tables ───────────────────────────
-- Values: 'default' (single-product clubs), 'mens', 'womens'
-- Existing rows default to 'default' — no behaviour change for single-product clubs.

ALTER TABLE inventory
  ADD COLUMN IF NOT EXISTS product_type text NOT NULL DEFAULT 'default'
  CHECK (product_type IN ('default', 'mens', 'womens'));

ALTER TABLE allocations
  ADD COLUMN IF NOT EXISTS product_type text NOT NULL DEFAULT 'default'
  CHECK (product_type IN ('default', 'mens', 'womens'));

ALTER TABLE pending_allocations
  ADD COLUMN IF NOT EXISTS product_type text NOT NULL DEFAULT 'default'
  CHECK (product_type IN ('default', 'mens', 'womens'));

ALTER TABLE club_sizes
  ADD COLUMN IF NOT EXISTS product_type text NOT NULL DEFAULT 'default'
  CHECK (product_type IN ('default', 'mens', 'womens'));

-- shopify_product_club_map: existing unique constraint is on shopify_product_id (fine —
-- each Shopify product still maps to exactly one club+product_type). A club can now have
-- multiple rows (one per product_type). Add unique constraint on (club_id, product_type).
ALTER TABLE shopify_product_club_map
  ADD COLUMN IF NOT EXISTS product_type text NOT NULL DEFAULT 'default'
  CHECK (product_type IN ('default', 'mens', 'womens'));

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'shopify_product_club_map_club_product_type_key'
  ) THEN
    ALTER TABLE shopify_product_club_map
      ADD CONSTRAINT shopify_product_club_map_club_product_type_key
      UNIQUE (club_id, product_type);
  END IF;
END$$;


-- ── 5. reserve_jersey RPC ────────────────────────────────────
-- Drop existing overloads before replacing with the new signature.
DROP FUNCTION IF EXISTS public.reserve_jersey(
  uuid, integer, text, integer, integer,
  text, integer
);
DROP FUNCTION IF EXISTS public.reserve_jersey(
  uuid, integer, text, integer, integer,
  text, integer, text, text, boolean, boolean, integer, uuid
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
BEGIN
  -- Widget runs as anon: only allow clubs wired to a Shopify product
  IF NOT EXISTS (
    SELECT 1 FROM shopify_product_club_map m WHERE m.club_id = p_club_id
  ) THEN
    RAISE EXCEPTION 'Club is not enabled for online reservations';
  END IF;

  -- ── Mixed gender detection ──────────────────────────────────
  -- Derive age label from player YOB and check competition_age_groups.
  v_player_age := EXTRACT(YEAR FROM now())::int - p_year_of_birth;
  v_age_label  := CASE
    WHEN v_player_age >= 18 THEN 'Open'
    ELSE 'U' || v_player_age::text
  END;

  -- A division is Mixed if any competition linked to this club's teams
  -- defines this age label as Mixed.
  SELECT EXISTS (
    SELECT 1
    FROM   teams t
    JOIN   competition_age_groups cag ON cag.competition_id = t.competition_id
    WHERE  t.club_id_uuid = p_club_id
      AND  cag.age_label  = v_age_label
      AND  cag.gender_type = 'Mixed'
  ) INTO v_is_mixed;

  -- ── Cross-pool clash check for mixed age groups ─────────────
  -- For mixed divisions: jersey #N in mens pool and jersey #N in womens pool
  -- are the SAME number on the same team — prevent duplicates across pools.
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
      RETURN; -- jersey number taken in the other pool on a mixed team
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
      RETURN; -- jersey number mid-reservation in the other pool
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
    RETURN; -- no stock (or all rows locked by concurrent shoppers)
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

  -- Audit trail
  INSERT INTO allocations (club_id, jersey_number, size, allocation_type, product_type, note)
  VALUES (p_club_id, p_jersey_number, p_size, 'new', p_product_type,
          'Reserved via widget (pending allocation)');

  RETURN QUERY SELECT v_pending_id, v_inv_id;
END;
$$;
