-- Training Log, update 5: a phone notification when an athlete starts a workout.
-- Run once in Supabase → SQL Editor → New query, after 004_trainer_console.sql. Safe to run again.
-- It runs as one transaction: if anything fails, nothing is changed.
--
-- "Starts a workout" = the athlete's first tick (or skip) in a session. You get one notification
-- per athlete per session, however many sets they tick afterwards, and none when a trainer
-- ticks on an athlete's behalf. Sessions already started before this update don't notify.
--
-- Notifications go through ntfy (https://ntfy.sh), a free push-notification app:
-- install "ntfy" on your phone, tap +, and subscribe to your topic name.
-- Anyone who knows the topic name can read it, so keep it long and random.
--
-- 0. Fill this in: replace NTFY_TOPIC_HERE (in step 1 below) with your topic name,
--    e.g. training-log-6f2c91d0a8b34e17. The topic is stored in the database, not in this repo.
--    If update 002 already set a topic, you can leave the placeholder and that topic is kept.

begin;

do $$
begin
  if to_regclass('public.members') is null then
    raise exception 'Run 004_trainer_console.sql first (this update needs the members table). Nothing was changed.';
  end if;
end $$;

-- ─── 1. Where notifications go (same table as update 002; not readable from the website) ──
create table if not exists public.notify_settings (
  id int primary key default 1 check (id = 1),
  ntfy_topic text,
  admin_email text
);
alter table public.notify_settings enable row level security;
insert into public.notify_settings (id) values (1) on conflict (id) do nothing;

do $$
declare
  topic text := trim('NTFY_TOPIC_HERE');
  current_topic text;
begin
  if topic <> 'NTFY_TOPIC_HERE' and topic <> '' then
    update public.notify_settings set ntfy_topic = topic where id = 1;
  end if;
  select ntfy_topic into current_topic from public.notify_settings where id = 1;
  if current_topic is null or current_topic = '' or current_topic = 'NTFY_TOPIC_HERE' then
    raise exception 'Replace NTFY_TOPIC_HERE near the top of this script with your ntfy topic name, then run it again. Nothing was changed.';
  end if;
end $$;

create extension if not exists pg_net with schema extensions;

create or replace function public.notify_admin(title text, message text, tag text default 'memo')
returns void
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  topic text;
begin
  select ntfy_topic into topic from public.notify_settings where id = 1;
  if topic is null or topic = '' or topic = 'NTFY_TOPIC_HERE' then
    return;
  end if;
  perform net.http_post(
    url := 'https://ntfy.sh',
    body := jsonb_build_object('topic', topic, 'title', title, 'message', left(message, 3500), 'tags', jsonb_build_array(tag)),
    headers := '{"Content-Type": "application/json"}'::jsonb
  );
end;
$$;
revoke execute on function public.notify_admin(text, text, text) from public, anon, authenticated;

-- ─── 2. When each athlete started each session ───────────────────────────────────────────
create table if not exists public.session_starts (
  athlete_email text not null,
  session_id text not null,
  started_at timestamptz not null default now(),
  started_by_email text,
  primary key (athlete_email, session_id)
);
alter table public.session_starts enable row level security;
drop policy if exists "read starts" on public.session_starts;
create policy "read starts" on public.session_starts for select to authenticated
  using (public.is_trainer() or athlete_email = public.my_email());
-- (no write policies: only the trigger below adds rows)

-- Sessions that already have ticks count as started, so they don't notify now.
insert into public.session_starts (athlete_email, session_id, started_at, started_by_email)
select t.athlete_email, t.session_id, min(t.updated_at), null
from public.ticks t
where t.athlete_email is not null
group by t.athlete_email, t.session_id
on conflict do nothing;

-- ─── 3. First tick in a session → notification ───────────────────────────────────────────
create or replace function public.on_tick_saved()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  added int;
  who text;
  what text;
begin
  if new.athlete_email is null then
    return new;
  end if;
  -- Only a real tick or skip counts (not an empty or cleared row).
  if not coalesce(new.skipped, false)
     and not exists (select 1 from jsonb_each(coalesce(new.sets, '{}'::jsonb)) s
                     where s.value not in ('null'::jsonb, 'false'::jsonb)) then
    return new;
  end if;

  insert into public.session_starts (athlete_email, session_id, started_by_email)
  values (new.athlete_email, new.session_id, lower(new.updated_by_email))
  on conflict do nothing;
  get diagnostics added = row_count;
  if added = 0 then
    return new;  -- already started
  end if;

  -- A trainer ticking for an athlete isn't the athlete starting on their own.
  if exists (select 1 from public.members where email = lower(coalesce(new.updated_by_email, '')) and role = 'trainer') then
    return new;
  end if;

  select coalesce(display_name, split_part(email, '@', 1)) into who from public.members where email = lower(new.athlete_email);
  select title into what from public.programs where id = new.session_id;
  perform public.notify_admin(
    coalesce(who, split_part(new.athlete_email, '@', 1)) || ' started a workout',
    coalesce(what, new.session_id),
    'muscle');
  return new;
exception when others then
  -- Never let a notification problem stop a tick from saving.
  raise warning 'workout start notification failed: %', sqlerrm;
  return new;
end $$;

drop trigger if exists tick_saved_start_notify on public.ticks;
create trigger tick_saved_start_notify after insert or update on public.ticks
  for each row execute function public.on_tick_saved();

commit;

notify pgrst, 'reload schema';

-- 4. Send yourself a test notification.
select public.notify_admin('Training Log', 'Workout start notifications are on.', 'tada');
