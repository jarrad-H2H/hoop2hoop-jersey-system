-- North Gold Coast (Seahawks) clash rules — ALLOCATION_LOGIC.md §2f (agreed with Jarrad 2026-10-14).
-- Rules only apply to clubs that play in a competition with this flag on:
--   1. Super League Girls (SLG) is one number pool per club: no two girls across all of the club's
--      SLG teams share a number.
--   2. Boys' teams never block girls and girls' teams never block boys (Mixed teams block both).
--   3. The importer estimates SLG players as aged 12 or older (not 18+).

alter table public.competitions
  add column if not exists ngc_clash_rules boolean not null default false;

comment on column public.competitions.ngc_clash_rules is
  'North Gold Coast clash rules: SLG number pool per club, boys/girls teams never block each other (unless Mixed), SLG estimated 12+. See ALLOCATION_LOGIC.md 2f.';

update public.competitions
   set ngc_clash_rules = true
 where name = 'North Gold Coast Seahawks Domestic Competition';

-- The widget runs as anon and cannot read competitions, so it asks through this function.
create or replace function public.club_uses_ngc_clash_rules(p_club_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from teams t
    join competitions c on c.id = t.competition_id
    where t.club_id_uuid = p_club_id
      and c.ngc_clash_rules
  );
$$;

revoke all on function public.club_uses_ngc_clash_rules(uuid) from public;
grant execute on function public.club_uses_ngc_clash_rules(uuid) to anon, authenticated, service_role;
