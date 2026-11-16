-- 006: let a trainer also train as an athlete, on the same email.
--
-- members.email is the primary key and a person has one role, so a trainer can't have a
-- second "athlete" row. Instead a trainer can be flagged also_athlete: the console then lists
-- them with the athletes (programs, notes, finishes) and the athlete site lets them pick their
-- own log. Row-level security needs no change: trainers can already read and write every
-- athlete's rows, including their own.
--
-- Safe to run more than once. Run it in the Supabase SQL editor after 004.

alter table public.members add column if not exists also_athlete boolean not null default false;

comment on column public.members.also_athlete is
  'Trainer who also trains: listed as an athlete in the console and the athlete picker.';

-- Example: make yourself an athlete too (fill in your trainer email).
-- update public.members set also_athlete = true where email = 'TRAINER_EMAIL_HERE' and role = 'trainer';
