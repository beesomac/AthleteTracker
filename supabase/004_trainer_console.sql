-- Training Log, update 4: trainer console, multiple athletes, programs and WOD leaderboards.
-- Run once in Supabase → SQL Editor → New query, after 001–003. Safe to run again.
--
-- Before running: merge/deploy the matching website first. The new site works with or
-- without this update; the old site keeps working afterwards for the existing athlete too.
--
-- What it does
--   1. members: who can sign in, their name and role (trainer or athlete). Filled from
--      allowed_emails; the notify admin email becomes the trainer, everyone else an athlete.
--      Rename people and add athletes from the console afterwards.
--   2. programs: the session plans (same JSON shape as sessions/*.json), per athlete or for everyone.
--   3. ticks, notes, session_finishes, lift_maxes get an athlete_email column. Existing rows are
--      given to the existing athlete, so nothing is lost.
--   4. wods + wod_results: workouts with a leaderboard.
--   5. Row-level security: trainers see and change everything; athletes only their own data,
--      their published programs, and leaderboards (names only, never other athletes' emails).

-- ─── 1. Members and roles ────────────────────────────────────────────────────────────────
create table if not exists public.members (
  email text primary key check (email = lower(email)),
  display_name text,
  role text not null default 'athlete' check (role in ('trainer', 'athlete')),
  active boolean not null default true,
  -- Sees the sessions/*.json files until the console publishes programs for them (the original athlete).
  legacy_files boolean not null default false,
  created_at timestamptz not null default now()
);
alter table public.members add column if not exists legacy_files boolean not null default false;
alter table public.members enable row level security;

insert into public.members (email, display_name, role, legacy_files)
select lower(a.email),
       initcap(split_part(a.email, '@', 1)),
       case when lower(a.email) = lower(coalesce((select admin_email from public.notify_settings where id = 1), '')) then 'trainer' else 'athlete' end,
       true
from public.allowed_emails a
where a.email not like '%\_EMAIL\_HERE'
on conflict (email) do nothing;

-- If no trainer could be worked out (no notify settings), make the first email the trainer.
update public.members set role = 'trainer'
where not exists (select 1 from public.members where role = 'trainer')
  and email = (select email from public.members order by created_at, email limit 1);

create or replace function public.my_email()
returns text language sql stable as $$ select lower(coalesce(auth.jwt() ->> 'email', '')) $$;

create or replace function public.my_role()
returns text language sql stable security definer set search_path = public as $$
  select role from public.members where email = public.my_email() and active
$$;

create or replace function public.is_trainer()
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce(public.my_role() = 'trainer', false)
$$;

-- Now backed by members. allowed_emails is still read so nobody is locked out mid-change.
create or replace function public.am_i_allowed()
returns boolean language sql stable security definer set search_path = public as $$
  select public.my_role() is not null
      or exists (select 1 from public.allowed_emails where lower(email) = public.my_email())
$$;

-- Who the site should act for when a row arrives without athlete_email (e.g. the old site).
-- Athletes: themselves. Trainers: the only/oldest athlete.
create or replace function public.default_athlete()
returns text language sql stable security definer set search_path = public as $$
  select case when public.my_role() = 'athlete' then public.my_email()
    else (select email from public.members where role = 'athlete' and active order by created_at, email limit 1) end
$$;

grant execute on function public.my_email(), public.my_role(), public.is_trainer(), public.am_i_allowed(), public.default_athlete() to authenticated;

drop policy if exists "members read" on public.members;
drop policy if exists "trainers manage members" on public.members;
create policy "members read" on public.members for select to authenticated
  using (public.is_trainer() or email = public.my_email());
create policy "trainers manage members" on public.members for all to authenticated
  using (public.is_trainer()) with check (public.is_trainer());

-- Names for "ticked by" labels. Athletes get trainers' and their own emails, never other athletes'.
drop function if exists public.member_names();
create or replace function public.member_names()
returns table (email text, name text, is_me boolean, role text)
language sql stable security definer set search_path = public as $$
  select case when public.is_trainer() or role = 'trainer' or email = public.my_email() then email end,
         coalesce(display_name, split_part(email, '@', 1)), email = public.my_email(), role
  from public.members where public.am_i_allowed() and active
$$;
grant execute on function public.member_names() to authenticated;

-- Who am I: role and name, in one call.
drop function if exists public.whoami();
create or replace function public.whoami()
returns table (email text, display_name text, role text, legacy_files boolean)
language sql stable security definer set search_path = public as $$
  select m.email, m.display_name, m.role, m.legacy_files from public.members m where m.email = public.my_email() and m.active
$$;
grant execute on function public.whoami() to authenticated;

-- ─── 2. Programs ─────────────────────────────────────────────────────────────────────────
create table if not exists public.programs (
  id text primary key default gen_random_uuid()::text,  -- also the session id ticks are saved under
  athlete_email text references public.members(email) on update cascade on delete cascade,  -- null = every athlete
  date date not null,
  title text not null,
  body jsonb not null,                                     -- the whole session, same fields as sessions/*.json
  published boolean not null default false,
  created_by_email text,
  updated_at timestamptz not null default now()
);
create index if not exists programs_athlete_date on public.programs (athlete_email, date);
alter table public.programs enable row level security;
drop policy if exists "trainers manage programs" on public.programs;
drop policy if exists "athletes read programs" on public.programs;
create policy "trainers manage programs" on public.programs for all to authenticated
  using (public.is_trainer()) with check (public.is_trainer());
create policy "athletes read programs" on public.programs for select to authenticated
  using (published and public.my_role() = 'athlete' and (athlete_email is null or athlete_email = public.my_email()));

-- ─── 3. Per-athlete feedback ─────────────────────────────────────────────────────────────
alter table public.ticks add column if not exists athlete_email text;
alter table public.notes add column if not exists athlete_email text;
alter table public.session_finishes add column if not exists athlete_email text;
alter table public.lift_maxes add column if not exists athlete_email text;

-- Existing rows belong to the existing athlete.
do $$
declare a text;
begin
  select email into a from public.members where role = 'athlete' order by created_at, email limit 1;
  if a is not null then
    update public.ticks set athlete_email = a where athlete_email is null;
    update public.notes set athlete_email = a where athlete_email is null;
    update public.session_finishes set athlete_email = a where athlete_email is null;
    update public.lift_maxes set athlete_email = a where athlete_email is null;
  end if;
end $$;

alter table public.ticks alter column athlete_email set default public.default_athlete();
alter table public.notes alter column athlete_email set default public.default_athlete();
alter table public.session_finishes alter column athlete_email set default public.default_athlete();
alter table public.lift_maxes alter column athlete_email set default public.default_athlete();

-- New primary keys include the athlete (only if not already changed).
do $$
begin
  if not exists (select 1 from information_schema.key_column_usage
                 where table_schema = 'public' and table_name = 'ticks' and constraint_name = 'ticks_pkey' and column_name = 'athlete_email') then
    delete from public.ticks where athlete_email is null;
    alter table public.ticks alter column athlete_email set not null;
    alter table public.ticks drop constraint ticks_pkey;
    alter table public.ticks add constraint ticks_pkey primary key (athlete_email, session_id, exercise_id);
  end if;
  if not exists (select 1 from information_schema.key_column_usage
                 where table_schema = 'public' and table_name = 'session_finishes' and constraint_name = 'session_finishes_pkey' and column_name = 'athlete_email') then
    delete from public.session_finishes where athlete_email is null;
    alter table public.session_finishes alter column athlete_email set not null;
    alter table public.session_finishes drop constraint session_finishes_pkey;
    alter table public.session_finishes add constraint session_finishes_pkey primary key (athlete_email, session_id);
  end if;
  if not exists (select 1 from information_schema.key_column_usage
                 where table_schema = 'public' and table_name = 'lift_maxes' and constraint_name = 'lift_maxes_pkey' and column_name = 'athlete_email') then
    delete from public.lift_maxes where athlete_email is null;
    alter table public.lift_maxes alter column athlete_email set not null;
    alter table public.lift_maxes drop constraint lift_maxes_pkey;
    alter table public.lift_maxes add constraint lift_maxes_pkey primary key (athlete_email, lift_key);
  end if;
end $$;
create index if not exists notes_athlete on public.notes (athlete_email, created_at);

-- Trainers: everything. Athletes: only rows for themselves.
drop policy if exists "allowed read ticks" on public.ticks;
drop policy if exists "allowed write ticks" on public.ticks;
drop policy if exists "own ticks" on public.ticks;
create policy "own ticks" on public.ticks for all to authenticated
  using (public.is_trainer() or (public.am_i_allowed() and athlete_email = public.my_email()))
  with check (public.is_trainer() or (public.am_i_allowed() and athlete_email = public.my_email()));

drop policy if exists "allowed finishes" on public.session_finishes;
drop policy if exists "own finishes" on public.session_finishes;
create policy "own finishes" on public.session_finishes for all to authenticated
  using (public.is_trainer() or (public.am_i_allowed() and athlete_email = public.my_email()))
  with check (public.is_trainer() or (public.am_i_allowed() and athlete_email = public.my_email()));

drop policy if exists "allowed maxes" on public.lift_maxes;
drop policy if exists "own maxes" on public.lift_maxes;
create policy "own maxes" on public.lift_maxes for all to authenticated
  using (public.is_trainer() or (public.am_i_allowed() and athlete_email = public.my_email()))
  with check (public.is_trainer() or (public.am_i_allowed() and athlete_email = public.my_email()));

drop policy if exists "allowed read notes" on public.notes;
drop policy if exists "allowed add notes" on public.notes;
drop policy if exists "allowed review notes" on public.notes;
drop policy if exists "authors delete notes" on public.notes;
create policy "allowed read notes" on public.notes for select to authenticated
  using (public.is_trainer() or (public.am_i_allowed() and athlete_email = public.my_email()));
create policy "allowed add notes" on public.notes for insert to authenticated
  with check (lower(author_email) = public.my_email()
    and (public.is_trainer() or (public.am_i_allowed() and athlete_email = public.my_email())));
create policy "allowed review notes" on public.notes for update to authenticated
  using (public.is_trainer() or (public.am_i_allowed() and athlete_email = public.my_email()))
  with check (public.is_trainer() or (public.am_i_allowed() and athlete_email = public.my_email()));
create policy "authors delete notes" on public.notes for delete to authenticated
  using (public.am_i_allowed() and lower(author_email) = public.my_email());

-- ─── 4. WODs and leaderboards ────────────────────────────────────────────────────────────
create table if not exists public.wods (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(name) between 1 and 120),
  description text,
  score_type text not null default 'time' check (score_type in ('time', 'reps', 'load', 'rounds_reps')),
  time_cap_seconds int,
  wod_date date,
  status text not null default 'open' check (status in ('draft', 'open', 'closed')),  -- draft: hidden; closed: no new scores
  created_by_email text,
  created_at timestamptz not null default now()
);
alter table public.wods enable row level security;
drop policy if exists "trainers manage wods" on public.wods;
drop policy if exists "members read wods" on public.wods;
create policy "trainers manage wods" on public.wods for all to authenticated
  using (public.is_trainer()) with check (public.is_trainer());
create policy "members read wods" on public.wods for select to authenticated
  using (public.am_i_allowed() and status <> 'draft');

-- score: one number per type, so sorting is simple.
--   time → seconds (lower wins); reps → reps; load → kg; rounds_reps → rounds * 1000 + reps.
create table if not exists public.wod_results (
  id uuid primary key default gen_random_uuid(),
  wod_id uuid not null references public.wods(id) on delete cascade,
  athlete_email text not null references public.members(email) on update cascade on delete cascade,
  score numeric not null check (score >= 0),
  rx boolean not null default true,
  performed_on date not null default current_date,
  note text check (char_length(note) <= 500),
  hidden boolean not null default false,             -- trainer can hide a score from the board
  entered_by_email text,
  created_at timestamptz not null default now()
);
create index if not exists wod_results_wod on public.wod_results (wod_id);
alter table public.wod_results enable row level security;
drop policy if exists "trainers manage results" on public.wod_results;
drop policy if exists "athletes own results" on public.wod_results;
drop policy if exists "athletes add results" on public.wod_results;
drop policy if exists "athletes change results" on public.wod_results;
drop policy if exists "athletes delete results" on public.wod_results;
create policy "trainers manage results" on public.wod_results for all to authenticated
  using (public.is_trainer()) with check (public.is_trainer());
create policy "athletes own results" on public.wod_results for select to authenticated
  using (public.am_i_allowed() and athlete_email = public.my_email());
create policy "athletes add results" on public.wod_results for insert to authenticated
  with check (athlete_email = public.my_email() and public.am_i_allowed() and not hidden
    and exists (select 1 from public.wods w where w.id = wod_id and w.status = 'open'));
create policy "athletes change results" on public.wod_results for update to authenticated
  using (athlete_email = public.my_email() and not hidden
    and exists (select 1 from public.wods w where w.id = wod_id and w.status = 'open'))
  with check (athlete_email = public.my_email() and not hidden);
create policy "athletes delete results" on public.wod_results for delete to authenticated
  using (athlete_email = public.my_email()
    and exists (select 1 from public.wods w where w.id = wod_id and w.status = 'open'));

-- The board everyone sees: each athlete's best visible score per WOD, Rx ahead of scaled,
-- with names but no emails. Ranks are worked out by the site from score_type.
create or replace function public.wod_board()
returns table (result_id uuid, wod_id uuid, athlete_name text, is_me boolean, score numeric, rx boolean, performed_on date, note text)
language sql stable security definer set search_path = public as $$
  select distinct on (r.wod_id, r.athlete_email)
         r.id, r.wod_id, coalesce(m.display_name, split_part(r.athlete_email, '@', 1)), r.athlete_email = public.my_email(),
         r.score, r.rx, r.performed_on, r.note
  from public.wod_results r
  join public.wods w on w.id = r.wod_id
  left join public.members m on m.email = r.athlete_email
  where public.am_i_allowed() and not r.hidden and (w.status <> 'draft' or public.is_trainer())
  order by r.wod_id, r.athlete_email, r.rx desc,
           case when w.score_type = 'time' then r.score else -r.score end, r.created_at
$$;
grant execute on function public.wod_board() to authenticated;

-- ─── 5. Notifications: skip trainers' own notes, say which athlete ───────────────────────
create or replace function public.on_note_added()
returns trigger language plpgsql security definer set search_path = public as $$
declare admin text;
begin
  select admin_email into admin from public.notify_settings where id = 1;
  if lower(coalesce(new.author_email, '')) = lower(coalesce(admin, ''))
     or exists (select 1 from public.members where email = lower(coalesce(new.author_email, '')) and role = 'trainer') then
    return new;
  end if;
  perform public.notify_admin(
    'New note from ' || coalesce((select display_name from public.members where email = lower(new.author_email)), split_part(coalesce(new.author_email, 'someone'), '@', 1)),
    coalesce(new.exercise_name, 'Whole session') || ' (' || new.session_id || '): ' || new.body,
    'memo');
  return new;
end $$;

create or replace function public.on_session_finished()
returns trigger language plpgsql security definer set search_path = public as $$
declare admin text;
begin
  select admin_email into admin from public.notify_settings where id = 1;
  if lower(coalesce(new.finished_by_email, '')) = lower(coalesce(admin, ''))
     or exists (select 1 from public.members where email = lower(coalesce(new.finished_by_email, '')) and role = 'trainer') then
    return new;
  end if;
  perform public.notify_admin('Session finished', coalesce(new.summary, new.session_id), 'white_check_mark');
  return new;
end $$;

-- ─── 6. Live updates ─────────────────────────────────────────────────────────────────────
do $$
begin
  begin alter publication supabase_realtime add table public.members; exception when duplicate_object then null; end;
  begin alter publication supabase_realtime add table public.programs; exception when duplicate_object then null; end;
  begin alter publication supabase_realtime add table public.wods; exception when duplicate_object then null; end;
  begin alter publication supabase_realtime add table public.wod_results; exception when duplicate_object then null; end;
end $$;

notify pgrst, 'reload schema';

-- Check: who is who. Rename people or add athletes from the console (console.html).
select email, display_name, role from public.members order by role desc, email;
