-- 015: rehab gym bookings, and "coach" logins (trainers without full admin rights).
-- Run after 004 in Supabase → SQL Editor → New query. Safe to run more than once.
-- Doesn't need 005–013 (it adds members.groups itself if 012 hasn't been run).
-- Best run after 014_privacy_hardening.sql: then bookings and sessions are added to its audit log.
-- Run before 014, it still works; run this file again after 014 to switch the audit on.
--
--   1. A new role, coach: signs in to the console and the iPhone app, sees the Bookings
--      calendar and every person's name and colour, books people in (members or walk-ins) and
--      marks who turned up. A coach can't see or change programs, feedback, notes, leaderboards
--      or members, and can't create or change gym sessions. Trainers keep full rights.
--   2. gym_slots: the bookable sessions. A time, a type (rehab = supervised rehab, open_gym),
--      a person limit (capacity) and an optional supervising trainer/coach.
--   3. bookings: one row per person per session. A member (member_email) or a walk-in who isn't
--      a member (guest_name). Status booked → attended / no_show, or cancelled.
--      Athletes book and cancel themselves; the database refuses a booking when the session is
--      full, cancelled or has started. Trainers and coaches can book anyone, even over the limit.
--   4. group_colours: a colour per group (members.groups, e.g. "Knee rehab", "Morning crew").
--      A person's colour on the calendar is the colour of their first group that has one.
--   5. gym_slot_list(): sessions with spots left and your own booking, for athletes, who can't
--      see who else is booked.
--
-- Health data: bookings hold only who, when and whether they came. No clinical notes here.

-- ─── 1. Coach role ───────────────────────────────────────────────────────────────────────
do $$
declare c text;
begin
  for c in select con.conname from pg_constraint con
           join pg_class t on t.oid = con.conrelid join pg_namespace n on n.oid = t.relnamespace
           where n.nspname = 'public' and t.relname = 'members' and con.contype = 'c'
             and pg_get_constraintdef(con.oid) ilike '%role%'
  loop
    execute format('alter table public.members drop constraint %I', c);
  end loop;
end $$;
alter table public.members add constraint members_role_check check (role in ('trainer', 'coach', 'athlete'));
alter table public.members add column if not exists groups text[] not null default '{}';

-- Trainers and coaches: the people who run the gym floor.
create or replace function public.is_staff()
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce(public.my_role() in ('trainer', 'coach'), false)
$$;
grant execute on function public.is_staff() to authenticated;

-- Coaches can read the member list (names, groups) to book people in; only trainers change it.
drop policy if exists "staff read members" on public.members;
create policy "staff read members" on public.members for select to authenticated
  using (public.is_staff());

-- ─── 2. Gym sessions ─────────────────────────────────────────────────────────────────────
create table if not exists public.gym_slots (
  id uuid primary key default gen_random_uuid(),
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  kind text not null default 'rehab' check (kind in ('rehab', 'open_gym')),
  title text check (char_length(title) <= 120),
  capacity int not null default 8 check (capacity between 1 and 200),
  coach_email text references public.members(email) on update cascade on delete set null,
  notes text check (char_length(notes) <= 500),
  cancelled boolean not null default false,
  series_id uuid,                                -- sessions made together with "repeat weekly"
  created_by_email text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (ends_at > starts_at)
);
create index if not exists gym_slots_starts on public.gym_slots (starts_at);
alter table public.gym_slots enable row level security;
drop policy if exists "members read slots" on public.gym_slots;
drop policy if exists "trainers manage slots" on public.gym_slots;
create policy "members read slots" on public.gym_slots for select to authenticated
  using (public.am_i_allowed());
create policy "trainers manage slots" on public.gym_slots for all to authenticated
  using (public.is_trainer()) with check (public.is_trainer());

-- ─── 3. Bookings ─────────────────────────────────────────────────────────────────────────
create table if not exists public.bookings (
  id uuid primary key default gen_random_uuid(),
  slot_id uuid not null references public.gym_slots(id) on delete cascade,
  member_email text references public.members(email) on update cascade on delete cascade,
  guest_name text check (char_length(guest_name) between 1 and 80),
  walk_in boolean not null default false,        -- came in without booking ahead
  status text not null default 'booked' check (status in ('booked', 'attended', 'no_show', 'cancelled')),
  booked_by_email text default public.my_email(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (member_email is not null or guest_name is not null)
);
create index if not exists bookings_slot on public.bookings (slot_id);
create index if not exists bookings_member on public.bookings (member_email);
-- One live booking per member per session (a cancelled one can be booked again).
create unique index if not exists bookings_once on public.bookings (slot_id, member_email)
  where member_email is not null and status <> 'cancelled';
alter table public.bookings enable row level security;

drop policy if exists "staff manage bookings" on public.bookings;
drop policy if exists "athletes read own bookings" on public.bookings;
drop policy if exists "athletes book themselves" on public.bookings;
drop policy if exists "athletes cancel own bookings" on public.bookings;
create policy "staff manage bookings" on public.bookings for all to authenticated
  using (public.is_staff()) with check (public.is_staff());
create policy "athletes read own bookings" on public.bookings for select to authenticated
  using (public.am_i_allowed() and member_email = public.my_email());
create policy "athletes book themselves" on public.bookings for insert to authenticated
  with check (public.am_i_allowed() and member_email = public.my_email()
    and guest_name is null and not walk_in and status = 'booked');
create policy "athletes cancel own bookings" on public.bookings for update to authenticated
  using (public.am_i_allowed() and member_email = public.my_email() and status in ('booked', 'cancelled'))
  with check (member_email = public.my_email() and guest_name is null and not walk_in and status in ('booked', 'cancelled'));

-- Spots and timing, checked in the database so two phones can't take the last spot together.
create or replace function public.check_booking()
returns trigger language plpgsql security definer set search_path = public as $$
declare s record; taken int; staff boolean := public.is_staff();
begin
  new.updated_at := now();
  if new.member_email is not null then new.member_email := lower(new.member_email); end if;
  if new.status not in ('booked', 'attended') then return new; end if;
  if tg_op = 'UPDATE' and old.status in ('booked', 'attended') and old.slot_id = new.slot_id then return new; end if;
  select * into s from public.gym_slots where id = new.slot_id for update;
  if not found then raise exception 'That session no longer exists.'; end if;
  if s.cancelled then raise exception 'That session has been cancelled.'; end if;
  if staff then return new; end if;
  if s.starts_at <= now() then raise exception 'That session has already started.'; end if;
  select count(*) into taken from public.bookings
    where slot_id = new.slot_id and status in ('booked', 'attended') and id <> new.id;
  if taken >= s.capacity then raise exception 'That session is full.'; end if;
  return new;
end $$;
revoke all on function public.check_booking() from public, anon, authenticated;
drop trigger if exists bookings_check on public.bookings;
create trigger bookings_check before insert or update on public.bookings
  for each row execute function public.check_booking();

-- ─── 4. Colours ──────────────────────────────────────────────────────────────────────────
create table if not exists public.group_colours (
  name text primary key check (char_length(name) between 1 and 60),
  colour text not null check (colour ~ '^#[0-9a-fA-F]{6}$'),
  sort int not null default 0
);
alter table public.group_colours enable row level security;
drop policy if exists "members read colours" on public.group_colours;
drop policy if exists "trainers manage colours" on public.group_colours;
create policy "members read colours" on public.group_colours for select to authenticated
  using (public.am_i_allowed());
create policy "trainers manage colours" on public.group_colours for all to authenticated
  using (public.is_trainer()) with check (public.is_trainer());

-- ─── 5. Sessions with spots left (what athletes see) ─────────────────────────────────────
drop function if exists public.gym_slot_list(timestamptz, timestamptz);
create or replace function public.gym_slot_list(p_from timestamptz, p_to timestamptz)
returns table (id uuid, starts_at timestamptz, ends_at timestamptz, kind text, title text, capacity int,
               coach_name text, notes text, cancelled boolean, booked int, my_booking_id uuid, my_status text)
language sql stable security definer set search_path = public as $$
  select s.id, s.starts_at, s.ends_at, s.kind, s.title, s.capacity,
         (select coalesce(m.display_name, split_part(m.email, '@', 1)) from public.members m where m.email = s.coach_email),
         s.notes, s.cancelled,
         (select count(*)::int from public.bookings b where b.slot_id = s.id and b.status in ('booked', 'attended')),
         mine.id, mine.status
  from public.gym_slots s
  left join lateral (select b.id, b.status from public.bookings b
                     where b.slot_id = s.id and b.member_email = public.my_email() and b.status <> 'cancelled'
                     order by b.created_at desc limit 1) mine on true
  where public.am_i_allowed() and s.starts_at >= p_from and s.starts_at < p_to
  order by s.starts_at
$$;
grant execute on function public.gym_slot_list(timestamptz, timestamptz) to authenticated;

-- ─── 6. Privacy (see 014_privacy_hardening.sql) ──────────────────────────────────────────
-- Signed-out visitors get nothing; signed-in people only what the policies above allow.
revoke all on public.gym_slots, public.bookings, public.group_colours from anon;
grant select, insert, update, delete on public.gym_slots, public.bookings, public.group_colours to authenticated;
revoke execute on function public.is_staff(), public.gym_slot_list(timestamptz, timestamptz) from public, anon;
grant execute on function public.is_staff(), public.gym_slot_list(timestamptz, timestamptz) to authenticated;
-- Who booked, cancelled or marked whom, and when (ids and changed column names only).
do $$
declare t text;
begin
  if to_regprocedure('public.audit_row()') is not null then
    foreach t in array array['gym_slots', 'bookings'] loop
      execute format('drop trigger if exists audit_%1$s on public.%1$I', t);
      execute format('create trigger audit_%1$s after insert or update or delete on public.%1$I
                      for each row execute function public.audit_row()', t);
    end loop;
  end if;
end $$;

-- ─── 7. Live updates ─────────────────────────────────────────────────────────────────────
do $$
begin
  begin alter publication supabase_realtime add table public.gym_slots; exception when duplicate_object then null; end;
  begin alter publication supabase_realtime add table public.bookings; exception when duplicate_object then null; end;
  begin alter publication supabase_realtime add table public.group_colours; exception when duplicate_object then null; end;
end $$;

notify pgrst, 'reload schema';

-- Make someone a coach (fill in their email; add them in the console first if they're new):
-- update public.members set role = 'coach' where email = 'COACH_EMAIL_HERE';
