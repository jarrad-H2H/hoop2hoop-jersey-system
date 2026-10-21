-- Basketball Queensland counts ages by the season's registration year: Summer 2026/27 players are
-- "2027 BQ Player", so a 2013-born plays U16 (14 in 2027). Ages used to count from the calendar
-- year, which put every odd-year-born player one age group too young all summer (Celtics: Oscar
-- Wen, born 2013, plays U16 but was shown U14 teams). Jarrad 2026-10-21.

-- 1. The year a competition's current season counts ages from. Set by the BC importer from the
--    report ("2027 BQ Player"); it only moves forward.
alter table public.competitions add column if not exists age_year integer;

comment on column public.competitions.age_year is
  'Season year ages count from (BC "2027 BQ Player" = 2027 for Summer 2026/27); set by the BC importer';

-- 2. A club's season year for the widget (the public key can't read competitions): the newest
--    age_year among the competitions its teams play in. Null when it has no BC teams; the widget
--    then uses the calendar year.
create or replace function public.widget_season_year(p_club_id uuid)
returns integer
language sql
stable
security definer
set search_path to 'public', 'pg_temp'
as $$
  select max(c.age_year)
  from teams t
  join competitions c on c.id = t.competition_id
  where t.club_id_uuid = p_club_id;
$$;

revoke all on function public.widget_season_year(uuid) from public;
grant execute on function public.widget_season_year(uuid) to anon, authenticated, service_role;

-- 3. reserve_jersey's mixed-team check counted the buyer's age from the calendar year; it now uses
--    the season year the widget passes (p_season_year). Only that line changes.
do $$
declare
  v_def text;
  v_old constant text := 'v_player_age := EXTRACT(YEAR FROM now())::int - p_year_of_birth;';
  v_new constant text := 'v_player_age := COALESCE(p_season_year, EXTRACT(YEAR FROM now())::int) - p_year_of_birth;';
begin
  select pg_get_functiondef(p.oid) into v_def
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'reserve_jersey';
  if v_def is null or position(v_old in v_def) = 0 then
    raise exception 'reserve_jersey: expected age line not found';
  end if;
  execute replace(v_def, v_old, v_new);
end $$;
