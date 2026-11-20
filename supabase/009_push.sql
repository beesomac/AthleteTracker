-- 009: Apple push notifications for the iPhone app.
-- Run after 007. Safe to run more than once.
--
--   1. device_tokens: one row per iPhone that allowed notifications, owned by whoever is signed
--      in on it. The app saves it with register_device_token() and removes it on sign-out.
--   2. notifications.pushed_at: set by the "push" edge function when it sends a row, so a row is
--      never pushed twice.
--   3. A trigger on notifications: every new row for someone with a phone calls the "push" edge
--      function (supabase/functions/push) through pg_net. The web bell keeps working as before.
--
-- The edge function only needs the notification id: it reads the row itself with the service
-- key and claims it by setting pushed_at, so a stray call can't send anything new.

create extension if not exists pg_net with schema extensions;

create table if not exists public.device_tokens (
  token text primary key check (token ~ '^[0-9a-f]{32,200}$'),
  email text not null references public.members(email) on update cascade on delete cascade,
  environment text not null default 'production' check (environment in ('sandbox', 'production')),
  updated_at timestamptz not null default now()
);
create index if not exists device_tokens_email on public.device_tokens (email);
alter table public.device_tokens enable row level security;
drop policy if exists "read own device tokens" on public.device_tokens;
create policy "read own device tokens" on public.device_tokens for select to authenticated
  using (email = public.my_email());
-- No insert/update/delete policies: the functions below do the writing.

-- Save this phone's token for the signed-in member. A phone that changes hands moves to the new person.
create or replace function public.register_device_token(p_token text, p_environment text default 'production')
returns void language plpgsql security definer set search_path = public as $$
declare me text := public.my_email();
begin
  if not public.am_i_allowed() then raise exception 'Not allowed'; end if;
  if p_environment not in ('sandbox', 'production') then raise exception 'Unknown environment'; end if;
  insert into public.device_tokens (token, email, environment, updated_at)
  values (lower(p_token), me, p_environment, now())
  on conflict (token) do update set email = excluded.email, environment = excluded.environment, updated_at = now();
end $$;

create or replace function public.unregister_device_token(p_token text)
returns void language sql security definer set search_path = public as $$
  delete from public.device_tokens where token = lower(p_token) and email = public.my_email();
$$;

revoke all on function public.register_device_token(text, text), public.unregister_device_token(text) from public, anon;
grant execute on function public.register_device_token(text, text), public.unregister_device_token(text) to authenticated;

alter table public.notifications add column if not exists pushed_at timestamptz;

create or replace function public.push_notification()
returns trigger language plpgsql security definer set search_path = public, extensions as $$
begin
  if exists (select 1 from public.device_tokens where email = new.recipient_email) then
    perform net.http_post(
      url := 'https://zaftplbijgkhnbmwegwt.supabase.co/functions/v1/push',
      body := jsonb_build_object('id', new.id),
      headers := '{"Content-Type": "application/json"}'::jsonb,
      timeout_milliseconds := 10000
    );
  end if;
  return new;
end $$;
revoke all on function public.push_notification() from public, anon, authenticated;

drop trigger if exists notifications_push on public.notifications;
create trigger notifications_push after insert on public.notifications
  for each row execute function public.push_notification();
