-- 008: benchmarks. Lets someone log a benchmark WOD (the Girls, an Open workout, …) from the
-- iPhone app's Benchmarks tab even when the trainer hasn't opened a leaderboard for it yet:
-- the first score opens one (status 'open', linked by wods.library_id, like the console does).
-- Run after 004 and 007. Safe to run more than once. No table changes.
--
-- Rules: you log for yourself; a trainer can log for any active member. Scores use the same
-- numbers as wod.js (seconds, reps, kg, or rounds * 1000 + reps).

create or replace function public.log_benchmark(
  p_library_id text,
  p_name text,
  p_score_type text,
  p_score numeric,
  p_rx boolean default true,
  p_performed_on date default null,
  p_note text default null,
  p_description text default null,
  p_athlete text default null
) returns uuid language plpgsql security definer set search_path = public as $$
declare
  me text := public.my_email();
  who text := lower(coalesce(nullif(trim(p_athlete), ''), public.my_email()));
  board uuid;
  result uuid;
begin
  if not public.am_i_allowed() then raise exception 'Not allowed'; end if;
  if who <> me and not public.is_trainer() then raise exception 'Only a trainer can log a score for someone else'; end if;
  if not exists (select 1 from public.members where email = who and active) then raise exception 'Unknown athlete'; end if;
  if coalesce(trim(p_library_id), '') = '' or coalesce(trim(p_name), '') = '' then raise exception 'Missing benchmark'; end if;
  if p_score_type not in ('time', 'reps', 'load', 'rounds_reps') then raise exception 'Unknown score type'; end if;
  if p_score is null or p_score <= 0 then raise exception 'Score must be above zero'; end if;

  -- The benchmark's open leaderboard, or a new one.
  select id into board from public.wods
    where library_id = p_library_id and status = 'open'
    order by created_at limit 1;
  if board is null then
    insert into public.wods (name, description, score_type, status, library_id, created_by_email)
      values (left(trim(p_name), 120), p_description, p_score_type, 'open', p_library_id, me)
      returning id into board;
  end if;

  -- 007's trigger then adds the athlete to the board and notifies everyone else on it.
  insert into public.wod_results (wod_id, athlete_email, score, rx, performed_on, note, entered_by_email)
    values (board, who, p_score, coalesce(p_rx, true), coalesce(p_performed_on, current_date), left(p_note, 500), me)
    returning id into result;
  return result;
end $$;

revoke all on function public.log_benchmark(text, text, text, numeric, boolean, date, text, text, text) from public, anon;
grant execute on function public.log_benchmark(text, text, text, numeric, boolean, date, text, text, text) to authenticated;

notify pgrst, 'reload schema';
