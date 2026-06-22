-- BC's "Player Id" column (captured as bc_player_id) is NOT reliably stable across a
-- player's separate team registrations -- confirmed by direct analysis of real CSV data
-- (e.g. Annabel Ashton: same person, same "User ID", but different "Player Id" per team).
-- "User ID" IS the stable cross-team identifier. Capture it separately for linking a
-- multi-team player's rows together (admin/display purposes) without disturbing the
-- existing one-row-per-team-registration model (which the widget purchase flow relies on).
ALTER TABLE public.players ADD COLUMN IF NOT EXISTS bc_user_id text;
CREATE INDEX IF NOT EXISTS idx_players_bc_user_id ON public.players (bc_user_id);
