-- 013: program plans (start date + length) and program templates, for the console's Calendar.
-- Run after 004. Safe to run more than once. Doesn't need 006-012.
--
--   athlete_plans       a block of training for one athlete: a name, a start date and a length in weeks
--                       (e.g. "Jr program", 5 Jan, 9 weeks). Sessions belong to it through programs.plan_id.
--   program_templates   a reusable program, e.g. the standard 9-week Jr program.
--   template_sessions   the sessions in a template. `day` counts from the template's first day
--                       (0 = day 1 of week 1, 7 = day 1 of week 2), so a template can start on any date.
--
-- Using a template copies each of its sessions as a NEW programs row for the athlete (so every
-- athlete keeps their own history), dated from the start date you pick, and adds an athlete_plans row.
-- Templates and template sessions are trainer-only; athletes never see them.
-- Before this runs, the Calendar still shows every session; plans and templates ask for this file.

create table if not exists public.program_templates (
  id text primary key default gen_random_uuid()::text,
  name text not null,
  weeks int not null default 1 check (weeks between 1 and 52),
  description text,
  sequence boolean not null default false,       -- copies run in session order (like the muscle-up program)
  created_by_email text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.template_sessions (
  id text primary key default gen_random_uuid()::text,
  template_id text not null references public.program_templates(id) on delete cascade,
  day int not null check (day between 0 and 400),
  title text not null,
  body jsonb not null,                            -- same session JSON as programs.body
  updated_at timestamptz not null default now()
);
create index if not exists template_sessions_template on public.template_sessions (template_id, day);

create table if not exists public.athlete_plans (
  id text primary key default gen_random_uuid()::text,
  athlete_email text not null references public.members(email) on update cascade on delete cascade,
  name text not null,
  start_date date not null,
  weeks int not null default 1 check (weeks between 1 and 52),
  template_id text references public.program_templates(id) on delete set null,
  created_by_email text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists athlete_plans_athlete on public.athlete_plans (athlete_email, start_date);

alter table public.programs add column if not exists plan_id text references public.athlete_plans(id) on delete set null;

alter table public.program_templates enable row level security;
alter table public.template_sessions enable row level security;
alter table public.athlete_plans enable row level security;

drop policy if exists "trainers manage templates" on public.program_templates;
create policy "trainers manage templates" on public.program_templates for all to authenticated
  using (public.is_trainer()) with check (public.is_trainer());

drop policy if exists "trainers manage template sessions" on public.template_sessions;
create policy "trainers manage template sessions" on public.template_sessions for all to authenticated
  using (public.is_trainer()) with check (public.is_trainer());

drop policy if exists "trainers manage plans" on public.athlete_plans;
drop policy if exists "athletes read own plans" on public.athlete_plans;
create policy "trainers manage plans" on public.athlete_plans for all to authenticated
  using (public.is_trainer()) with check (public.is_trainer());
-- So the athlete app can later show "Week 3 of 9".
create policy "athletes read own plans" on public.athlete_plans for select to authenticated
  using (athlete_email = public.my_email());

do $$ begin
  begin alter publication supabase_realtime add table public.program_templates; exception when duplicate_object then null; end;
  begin alter publication supabase_realtime add table public.template_sessions; exception when duplicate_object then null; end;
  begin alter publication supabase_realtime add table public.athlete_plans; exception when duplicate_object then null; end;
end $$;
