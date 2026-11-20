-- 007: leaderboards that athletes join from their programs, and in-app notifications.
-- Run after 004 (it uses members, wods, wod_results, my_email(), is_trainer(), am_i_allowed()).
-- Safe to run more than once. Doesn't need 002, 003 or 005.
--
--   1. wods.library_id: which wods.json WOD a leaderboard is (e.g. "fran", "open-24-1"), so a
--      program's WOD block can find its boards and an athlete's earlier scores.
--   2. wod_board_members: who is on a leaderboard. The console adds athletes when a WOD goes
--      into their program; logging a score adds you too.
--   3. notifications: an in-app inbox per person. A database trigger writes one to everyone on a
--      board (except the scorer) when a score is added; the console writes "you've done this WOD
--      before" ones when it saves a program.

-- ─── 1. Library link ─────────────────────────────────────────────────────────────────────
alter table public.wods add column if not exists library_id text;
create index if not exists wods_library on public.wods (library_id);

-- ─── 2. Board members ────────────────────────────────────────────────────────────────────
create table if not exists public.wod_board_members (
  wod_id uuid not null references public.wods(id) on delete cascade,
  athlete_email text not null references public.members(email) on update cascade on delete cascade,
  added_by_email text,
  added_at timestamptz not null default now(),
  primary key (wod_id, athlete_email)
);
alter table public.wod_board_members enable row level security;
drop policy if exists "trainers manage board members" on public.wod_board_members;
drop policy if exists "athletes see own boards" on public.wod_board_members;
create policy "trainers manage board members" on public.wod_board_members for all to authenticated
  using (public.is_trainer()) with check (public.is_trainer());
create policy "athletes see own boards" on public.wod_board_members for select to authenticated
  using (public.am_i_allowed() and athlete_email = public.my_email());

-- ─── 3. Notifications ────────────────────────────────────────────────────────────────────
create table if not exists public.notifications (
  id uuid primary key default gen_random_uuid(),
  recipient_email text not null references public.members(email) on update cascade on delete cascade,
  kind text not null check (kind in ('score', 'board_added', 'wod_again')),
  title text not null check (char_length(title) <= 200),
  body text check (char_length(body) <= 1000),
  wod_id uuid references public.wods(id) on delete cascade,
  session_id text,          -- program id, for "wod_again"
  ref text,                 -- library WOD id, for "wod_again"
  read_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists notifications_recipient on public.notifications (recipient_email, created_at desc);
-- One "you've done this before" per athlete, program and WOD, however often the program is saved.
-- (Rows without a session_id or ref, like score notifications, never clash: nulls are distinct.)
drop index if exists public.notifications_wod_again_once;
create unique index if not exists notifications_once on public.notifications (recipient_email, kind, session_id, ref);
alter table public.notifications enable row level security;
drop policy if exists "read own notifications" on public.notifications;
drop policy if exists "mark own notifications" on public.notifications;
drop policy if exists "delete own notifications" on public.notifications;
drop policy if exists "trainers manage notifications" on public.notifications;
create policy "read own notifications" on public.notifications for select to authenticated
  using (recipient_email = public.my_email());
create policy "mark own notifications" on public.notifications for update to authenticated
  using (recipient_email = public.my_email()) with check (recipient_email = public.my_email());
create policy "delete own notifications" on public.notifications for delete to authenticated
  using (recipient_email = public.my_email());
create policy "trainers manage notifications" on public.notifications for all to authenticated
  using (public.is_trainer()) with check (public.is_trainer());

-- Score as people read it; matches wod.js format().
create or replace function public.format_wod_score(score_type text, score numeric)
returns text language sql immutable as $$
  select case score_type
    when 'time' then case when score >= 3600 then floor(score / 3600)::int || ':' || lpad(((floor(score)::int % 3600) / 60)::text, 2, '0')
                          else (floor(score)::int / 60)::text end
                     || ':' || lpad((floor(score)::int % 60)::text, 2, '0')
    when 'rounds_reps' then case when (score::int % 1000) = 0 then (floor(score / 1000))::int || ' rds'
                                 else (floor(score / 1000))::int || ' + ' || (score::int % 1000) end
    when 'load' then rtrim(rtrim(round(score, 2)::text, '0'), '.') || ' kg'
    else round(score)::text || ' reps'
  end
$$;

-- A new score: the scorer joins the board, and everyone else on it gets a notification.
create or replace function public.on_wod_result_added()
returns trigger language plpgsql security definer set search_path = public as $$
declare w record; who text;
begin
  select * into w from public.wods where id = new.wod_id;
  insert into public.wod_board_members (wod_id, athlete_email, added_by_email)
    values (new.wod_id, new.athlete_email, coalesce(new.entered_by_email, new.athlete_email))
    on conflict do nothing;
  if new.hidden or w.status = 'draft' then return new; end if;
  select coalesce(display_name, split_part(email, '@', 1)) into who from public.members where email = new.athlete_email;
  insert into public.notifications (recipient_email, kind, title, body, wod_id)
    select bm.athlete_email, 'score',
           'New score on ' || w.name,
           coalesce(who, 'Someone') || ': ' || public.format_wod_score(w.score_type, new.score) || case when new.rx then ' Rx' else ' scaled' end,
           new.wod_id
    from public.wod_board_members bm
    join public.members m on m.email = bm.athlete_email and m.active
    where bm.wod_id = new.wod_id and bm.athlete_email <> new.athlete_email;
  return new;
end $$;
drop trigger if exists wod_result_added on public.wod_results;
create trigger wod_result_added after insert on public.wod_results
  for each row execute function public.on_wod_result_added();

-- A trainer puts an athlete on a board: tell the athlete (not when they joined by scoring).
create or replace function public.on_board_member_added()
returns trigger language plpgsql security definer set search_path = public as $$
declare w record;
begin
  if lower(coalesce(new.added_by_email, '')) = new.athlete_email then return new; end if;
  select * into w from public.wods where id = new.wod_id;
  if w.status = 'draft' then return new; end if;
  insert into public.notifications (recipient_email, kind, title, body, wod_id)
    values (new.athlete_email, 'board_added', 'You''re on the ' || w.name || ' leaderboard',
            'Log your score after the workout. Everyone on the board sees new scores.', new.wod_id);
  return new;
end $$;
drop trigger if exists board_member_added on public.wod_board_members;
create trigger board_member_added after insert on public.wod_board_members
  for each row execute function public.on_board_member_added();

-- Everyone already on a board by scoring joins it now.
insert into public.wod_board_members (wod_id, athlete_email, added_by_email)
  select distinct wod_id, athlete_email, athlete_email from public.wod_results
  on conflict do nothing;

-- ─── 4. Live updates ─────────────────────────────────────────────────────────────────────
do $$
begin
  begin alter publication supabase_realtime add table public.notifications; exception when duplicate_object then null; end;
  begin alter publication supabase_realtime add table public.wod_board_members; exception when duplicate_object then null; end;
end $$;

notify pgrst, 'reload schema';
