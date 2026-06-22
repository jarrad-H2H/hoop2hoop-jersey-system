-- Discovered during Task #32/#35 testing: players and competition_age_groups had
-- NO anon-readable RLS policy at all (only admin_full_access for authenticated).
-- The public widget runs unauthenticated, so smartCheckNumber / suggestNumbersForClubRanked
-- / lookupPlayerByName (all same-team + cross-pool clash detection, plus Plan B
-- returning-player lookup) and the manual cross-pool override path were silently
-- seeing zero rows for every live customer. Scoped the same way as the existing
-- widget_read_teams_for_mapped_clubs / widget_read_available_inventory policies.

CREATE POLICY widget_read_players_for_mapped_clubs
ON public.players
FOR SELECT
TO anon
USING (
  EXISTS (
    SELECT 1 FROM shopify_product_club_map m
    WHERE m.club_id::text = players.club_id::text
  )
);

CREATE POLICY widget_read_cag_for_mapped_clubs
ON public.competition_age_groups
FOR SELECT
TO anon
USING (
  EXISTS (
    SELECT 1
    FROM teams t
    JOIN shopify_product_club_map m ON m.club_id::text = t.club_id
    WHERE t.competition_id = competition_age_groups.competition_id
  )
);
