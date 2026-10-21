-- Team name next to the BC division code, so the widget's team dropdown shows "14BC5 Boston" and
-- "14BC5 Crushers" as separate choices (Celtics fields two teams in that division). Jarrad 2026-10-21.
-- teams.name stays the division code: the clash checks and the widget's picked team match on it,
-- so a whole division is still treated as one team for clashes.
alter table public.teams add column if not exists team_name text;

comment on column public.teams.team_name is
  'BC team name within the division (e.g. Boston in "14BC5 Celtics Boston"); null when the code alone names the team (Seahawks)';
