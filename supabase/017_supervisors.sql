-- 017: a list of supervisors to pick from on gym sessions (up to ten names, edited in the console).
-- Run after 016_bookings.sql. Safe to run more than once.
--
--   supervisors              the names in the console's "Supervised by" list. They don't need a login.
--                            Filled from trainers and coaches the first time; edit in Bookings → Supervisors.
--   gym_slots.supervisor_name  who supervises a session, by name. (coach_email from 016 still works
--                            for sessions saved before this.)
--   gym_slot_list()          now shows supervisor_name, falling back to the coach's member name.

create table if not exists public.supervisors (
  name text primary key check (char_length(name) between 1 and 80),
  sort int not null default 0
);
alter table public.supervisors enable row level security;
drop policy if exists "staff read supervisors" on public.supervisors;
drop policy if exists "trainers manage supervisors" on public.supervisors;
create policy "staff read supervisors" on public.supervisors for select to authenticated
  using (public.is_staff());
create policy "trainers manage supervisors" on public.supervisors for all to authenticated
  using (public.is_trainer()) with check (public.is_trainer());
revoke all on public.supervisors from anon;
grant select, insert, update, delete on public.supervisors to authenticated;

-- Start the list with the trainers and coaches (only when it's empty).
insert into public.supervisors (name, sort)
select coalesce(m.display_name, split_part(m.email, '@', 1)), row_number() over (order by m.role desc, m.display_name)
from public.members m
where m.role in ('trainer', 'coach') and m.active
  and not exists (select 1 from public.supervisors)
on conflict (name) do nothing;

alter table public.gym_slots add column if not exists supervisor_name text check (char_length(supervisor_name) <= 80);

drop function if exists public.gym_slot_list(timestamptz, timestamptz);
create or replace function public.gym_slot_list(p_from timestamptz, p_to timestamptz)
returns table (id uuid, starts_at timestamptz, ends_at timestamptz, kind text, title text, capacity int,
               coach_name text, notes text, cancelled boolean, booked int, my_booking_id uuid, my_status text)
language sql stable security definer set search_path = public as $$
  select s.id, s.starts_at, s.ends_at, s.kind, s.title, s.capacity,
         coalesce(s.supervisor_name,
                  (select coalesce(m.display_name, split_part(m.email, '@', 1)) from public.members m where m.email = s.coach_email)),
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
revoke execute on function public.gym_slot_list(timestamptz, timestamptz) from public, anon;
grant execute on function public.gym_slot_list(timestamptz, timestamptz) to authenticated;

do $$
begin
  begin alter publication supabase_realtime add table public.supervisors; exception when duplicate_object then null; end;
end $$;

notify pgrst, 'reload schema';
