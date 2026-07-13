-- 2026-07-06: Pre-order system
-- Adds a per-club pre-order mode toggle and the preorder_requests table for
-- collecting player jersey number preferences before stock is produced.

-- 1. Add preorder_mode to clubs
ALTER TABLE clubs
  ADD COLUMN IF NOT EXISTS preorder_mode TEXT NOT NULL DEFAULT 'off';

ALTER TABLE clubs
  DROP CONSTRAINT IF EXISTS clubs_preorder_mode_check;
ALTER TABLE clubs
  ADD CONSTRAINT clubs_preorder_mode_check
  CHECK (preorder_mode IN ('off', 'open', 'closed', 'locked'));

-- 2. Allow anon role to read clubs (needed so the widget can detect preorder_mode
--    via the shopify_product_club_map → clubs join; clubs is public-facing info).
DROP POLICY IF EXISTS clubs_anon_read ON clubs;
CREATE POLICY clubs_anon_read
  ON clubs FOR SELECT
  TO anon
  USING (TRUE);

-- 3. Create preorder_requests table
CREATE TABLE IF NOT EXISTS preorder_requests (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  club_id         UUID        NOT NULL REFERENCES clubs(id),
  player_id       UUID        REFERENCES players(id),
  season          INT         NOT NULL DEFAULT EXTRACT(YEAR FROM NOW())::INT,
  first_name      TEXT        NOT NULL,
  last_name       TEXT        NOT NULL,
  year_of_birth   INT         NOT NULL,
  size            TEXT        NOT NULL,
  age_group       TEXT,
  pref_1          INT         CHECK (pref_1 IS NULL OR (pref_1 >= 0 AND pref_1 <= 99 AND pref_1 <> 69)),
  pref_2          INT         CHECK (pref_2 IS NULL OR (pref_2 >= 0 AND pref_2 <= 99 AND pref_2 <> 69)),
  pref_3          INT         CHECK (pref_3 IS NULL OR (pref_3 >= 0 AND pref_3 <= 99 AND pref_3 <> 69)),
  any_number      BOOLEAN     NOT NULL DEFAULT FALSE,
  claimed_current INT         CHECK (claimed_current IS NULL OR (claimed_current >= 0 AND claimed_current <= 99 AND claimed_current <> 69)),
  assigned_number INT         CHECK (assigned_number IS NULL OR (assigned_number >= 0 AND assigned_number <= 99 AND assigned_number <> 69)),
  shopify_order_id TEXT,
  order_number    TEXT,
  paid_at         TIMESTAMPTZ,
  status          TEXT        NOT NULL DEFAULT 'pending',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT preorder_requests_status_check
    CHECK (status IN ('pending', 'allocated', 'overflow', 'locked'))
);

CREATE INDEX IF NOT EXISTS preorder_requests_club_season_idx
  ON preorder_requests (club_id, season);
CREATE INDEX IF NOT EXISTS preorder_requests_status_idx
  ON preorder_requests (status);
CREATE INDEX IF NOT EXISTS preorder_requests_paid_at_idx
  ON preorder_requests (paid_at);

-- 4. RLS
ALTER TABLE preorder_requests ENABLE ROW LEVEL SECURITY;

-- Authenticated (admin) has full access
DROP POLICY IF EXISTS preorder_requests_admin_full ON preorder_requests;
CREATE POLICY preorder_requests_admin_full
  ON preorder_requests FOR ALL
  TO authenticated
  USING (TRUE)
  WITH CHECK (TRUE);

-- Anon has no access — pre-order requests are written only by the webhook
-- using the service role key (which bypasses RLS entirely).
