-- Trae's Training Log, update 3: known 1RMs entered by hand.
-- Run once in Supabase → SQL Editor → New query. Safe to run again.

create table if not exists public.lift_maxes (
  lift_key text primary key,          -- the lift's name, lower-case, e.g. "trap bar deadlift"
  lift_name text,
  kg numeric not null check (kg > 0 and kg < 1000),
  tested_on date,
  updated_by_email text,
  updated_at timestamptz not null default now()
);
alter table public.lift_maxes enable row level security;
drop policy if exists "allowed maxes" on public.lift_maxes;
create policy "allowed maxes" on public.lift_maxes for all to authenticated
  using (public.am_i_allowed()) with check (public.am_i_allowed());
do $$
begin
  begin alter publication supabase_realtime add table public.lift_maxes; exception when duplicate_object then null; end;
end $$;

notify pgrst, 'reload schema';
