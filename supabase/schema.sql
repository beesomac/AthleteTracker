-- Trae's Training Log: run this once in Supabase → SQL Editor → New query.
-- It creates the two tables, locks them to the emails in allowed_emails,
-- and turns on live updates so ticks show up on the other phone straight away.

-- 1. Who may use the log. Edit these two emails before running.
create table if not exists public.allowed_emails (
  email text primary key
);
insert into public.allowed_emails (email) values
  ('JOHN_EMAIL_HERE'),
  ('TRAE_EMAIL_HERE')
on conflict do nothing;
alter table public.allowed_emails enable row level security;
-- (no policies: nobody can read or change this list from the website)

create or replace function public.am_i_allowed()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.allowed_emails
    where lower(email) = lower(coalesce(auth.jwt() ->> 'email', ''))
  );
$$;
grant execute on function public.am_i_allowed() to authenticated;

-- 2. One row per exercise per session: which sets are ticked.
create table if not exists public.ticks (
  session_id text not null,
  exercise_id text not null,
  sets jsonb not null default '{}'::jsonb,
  updated_by_email text,
  updated_at timestamptz not null default now(),
  primary key (session_id, exercise_id)
);

-- 3. Feedback notes, on an exercise or on the whole session (exercise_id null).
create table if not exists public.notes (
  id uuid primary key default gen_random_uuid(),
  session_id text not null,
  exercise_id text,
  exercise_name text,
  body text not null check (char_length(body) between 1 and 5000),
  author_email text,
  created_at timestamptz not null default now(),
  reviewed boolean not null default false,
  reviewed_by_email text
);

-- 4. Only allowed emails can read or write.
alter table public.ticks enable row level security;
alter table public.notes enable row level security;

drop policy if exists "allowed read ticks" on public.ticks;
drop policy if exists "allowed write ticks" on public.ticks;
create policy "allowed read ticks" on public.ticks for select to authenticated using (public.am_i_allowed());
create policy "allowed write ticks" on public.ticks for all to authenticated using (public.am_i_allowed()) with check (public.am_i_allowed());

drop policy if exists "allowed read notes" on public.notes;
drop policy if exists "allowed add notes" on public.notes;
drop policy if exists "allowed review notes" on public.notes;
drop policy if exists "authors delete notes" on public.notes;
create policy "allowed read notes" on public.notes for select to authenticated using (public.am_i_allowed());
create policy "allowed add notes" on public.notes for insert to authenticated
  with check (public.am_i_allowed() and lower(author_email) = lower(auth.jwt() ->> 'email'));
create policy "allowed review notes" on public.notes for update to authenticated using (public.am_i_allowed()) with check (public.am_i_allowed());
create policy "authors delete notes" on public.notes for delete to authenticated
  using (public.am_i_allowed() and lower(author_email) = lower(auth.jwt() ->> 'email'));

-- 5. Live updates between phones.
do $$
begin
  begin alter publication supabase_realtime add table public.ticks; exception when duplicate_object then null; end;
  begin alter publication supabase_realtime add table public.notes; exception when duplicate_object then null; end;
end $$;
