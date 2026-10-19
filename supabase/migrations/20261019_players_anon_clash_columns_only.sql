-- The public (anon) key, which is in the widget page, could read every column of players at mapped
-- clubs: names, teams, numbers, BC IDs and the birth years of website buyers. The widget's clash
-- checks only need the columns below (no names), and its name lookup now runs inside
-- widget_lookup_player (20261019_widget_lookup_player.sql). The row policy
-- widget_read_players_for_mapped_clubs still limits anon to mapped clubs; signed-in admins
-- (authenticated) keep every column. A column the widget needs later must be granted here too.
REVOKE SELECT ON public.players FROM anon;
GRANT SELECT (id, club_id, final_shirt, year_of_birth, estimated_yob_min, estimated_yob_max, age_group,
              division_code, team_name, team_id, deleted_at, bc_last_seen_at)
  ON public.players TO anon;
