-- Allows specific teams to have their gender field locked against BC import overwrites.
-- When the importer builds a team row, it checks this table first. If a matching
-- (club_id, team_name) entry exists, that gender is used instead of what the CSV says.
-- Survives both Merge and Replace import modes because it is a separate table.
--
-- Initial use case: Celtics U10 Mixed teams are boys-only despite competing in the
-- Gold Coast "Mixed" competition category. Marking them Male prevents the cross-pool
-- jersey clash check from firing for U10 boys, since there is no genuine gender overlap.

CREATE TABLE public.team_gender_overrides (
  club_id   uuid NOT NULL REFERENCES public.clubs(id) ON DELETE CASCADE,
  team_name text NOT NULL,
  gender    text NOT NULL CHECK (gender IN ('Male', 'Female', 'Mixed')),
  note      text,
  PRIMARY KEY (club_id, team_name)
);

ALTER TABLE public.team_gender_overrides ENABLE ROW LEVEL SECURITY;

-- Anon has no access — this is admin-only data
CREATE POLICY "anon_no_access" ON public.team_gender_overrides
  FOR ALL TO anon USING (false);

-- Seed: Celtics U10 Mixed teams are boys-only
INSERT INTO public.team_gender_overrides (club_id, team_name, gender, note)
VALUES
  ('1cc438ea-a37e-4cc8-a41b-ab0b596bd475', '10BC1/2', 'Male',
   'Celtics U10 Mixed comp is boys-only for this club — override prevents false cross-pool block'),
  ('1cc438ea-a37e-4cc8-a41b-ab0b596bd475', '10BC3/4', 'Male',
   'Celtics U10 Mixed comp is boys-only for this club — override prevents false cross-pool block'),
  ('1cc438ea-a37e-4cc8-a41b-ab0b596bd475', '10BC5',   'Male',
   'Celtics U10 Mixed comp is boys-only for this club — override prevents false cross-pool block');

-- Also fix the existing team rows right now (the next import will sustain this via the override table)
UPDATE public.teams
SET gender = 'Male'
WHERE club_id_uuid = '1cc438ea-a37e-4cc8-a41b-ab0b596bd475'
  AND name IN ('10BC1/2', '10BC3/4', '10BC5')
  AND gender = 'Mixed';
