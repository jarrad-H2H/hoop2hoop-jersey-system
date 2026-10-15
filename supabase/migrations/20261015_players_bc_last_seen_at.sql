-- Release rule moves from calendar years to "two seasons" (~12 months): store the date of the
-- last BC report game each player appeared in (ALLOCATION_LOGIC.md 5).
alter table players add column if not exists bc_last_seen_at date;
-- Every BC player on record was imported mid-2026; count them as last seen 30 June of that year.
update players set bc_last_seen_at = make_date(bc_last_seen_season, 6, 30)
  where bc_last_seen_season is not null and bc_last_seen_at is null;
create index if not exists players_club_last_seen_idx on players (club_id, bc_last_seen_at);
