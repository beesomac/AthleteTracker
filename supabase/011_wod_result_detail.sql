-- 011: round-by-round detail on a WOD score.
-- Run after 004. Safe to run more than once. Doesn't need 007-010.
--
-- wod_results.detail (jsonb, optional) holds what the athlete actually did, round by round,
-- and the splits from the WOD timer. The score column still ranks the board; detail is only shown.
--
--   {
--     "rounds": [
--       { "time": 41.3,                       -- seconds for this round (optional)
--         "sets": [ { "name": "Wall Walk", "target": "1 rep", "actual": "1", "time": 12.0 }, ... ] },
--       ...
--     ],
--     "splits": [41.3, 118.0, ...],            -- timer splits, seconds from the start (optional)
--     "split_by": "round" | "set",             -- what each split meant
--     "timer": "15:00 countdown"               -- how the timer was set (optional)
--   }
--
-- Without this column the apps still save scores; round times then go into the note instead.

alter table public.wod_results add column if not exists detail jsonb;

alter table public.wod_results drop constraint if exists wod_results_detail_size;
alter table public.wod_results add constraint wod_results_detail_size
  check (detail is null or (jsonb_typeof(detail) = 'object' and pg_column_size(detail) <= 32000));

notify pgrst, 'reload schema';
