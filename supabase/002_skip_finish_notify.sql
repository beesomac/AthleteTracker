-- Trae's Training Log, update 2: Skip button, Finish session, and phone notifications.
-- Run once in Supabase → SQL Editor → New query, after schema.sql. Safe to run again.
--
-- Notifications go through ntfy (https://ntfy.sh), a free push-notification app.
-- Install "ntfy" on your phone, tap +, and subscribe to the topic below.
-- Anyone who knows the topic name can read it, so keep it long and random.

-- 0. Fill these in.
--    NTFY_TOPIC_HERE  → a long random topic name, e.g. trae-log-6f2c91d0a8b34e17
--    ADMIN_EMAIL_HERE → your login email (you won't be notified about your own notes)

-- 1. Skip an exercise, with an optional reason.
alter table public.ticks add column if not exists skipped boolean not null default false;
alter table public.ticks add column if not exists skip_reason text;

-- 2. Finished sessions, with a summary of what was skipped or missed.
create table if not exists public.session_finishes (
  session_id text primary key,
  finished_by_email text,
  finished_at timestamptz not null default now(),
  summary text,
  details jsonb not null default '{}'::jsonb
);
alter table public.session_finishes enable row level security;
drop policy if exists "allowed finishes" on public.session_finishes;
create policy "allowed finishes" on public.session_finishes for all to authenticated
  using (public.am_i_allowed()) with check (public.am_i_allowed());
do $$
begin
  begin alter publication supabase_realtime add table public.session_finishes; exception when duplicate_object then null; end;
end $$;

-- 3. Where notifications go. Not readable from the website.
create table if not exists public.notify_settings (
  id int primary key default 1 check (id = 1),
  ntfy_topic text,
  admin_email text
);
alter table public.notify_settings enable row level security;
insert into public.notify_settings (id, ntfy_topic, admin_email)
values (1, 'NTFY_TOPIC_HERE', 'ADMIN_EMAIL_HERE')
on conflict (id) do update set ntfy_topic = excluded.ntfy_topic, admin_email = excluded.admin_email;

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

-- 4. A new note → notification.
create or replace function public.on_note_added()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  admin text;
begin
  select admin_email into admin from public.notify_settings where id = 1;
  if lower(coalesce(new.author_email, '')) = lower(coalesce(admin, '')) then
    return new;
  end if;
  perform public.notify_admin(
    'New note from ' || split_part(coalesce(new.author_email, 'someone'), '@', 1),
    coalesce(new.exercise_name, 'Whole session') || ' (' || new.session_id || '): ' || new.body,
    'memo'
  );
  return new;
end;
$$;
drop trigger if exists note_added_notify on public.notes;
create trigger note_added_notify after insert on public.notes
  for each row execute function public.on_note_added();

-- 5. A finished session → notification with the summary.
create or replace function public.on_session_finished()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  admin text;
begin
  select admin_email into admin from public.notify_settings where id = 1;
  if lower(coalesce(new.finished_by_email, '')) = lower(coalesce(admin, '')) then
    return new;
  end if;
  perform public.notify_admin('Session finished', coalesce(new.summary, new.session_id), 'white_check_mark');
  return new;
end;
$$;
drop trigger if exists session_finished_notify on public.session_finishes;
create trigger session_finished_notify after insert or update on public.session_finishes
  for each row execute function public.on_session_finished();

notify pgrst, 'reload schema';

-- 6. Send yourself a test notification.
select public.notify_admin('Trae''s Training Log', 'Notifications are working.', 'tada');
