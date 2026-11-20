-- 010: capped scores on "for time" WODs. Someone who doesn't finish inside the time cap scores
-- "CAP + reps done". The apps store that as 2,000,000 - reps (see wod.js), which is above every
-- real time, so wod_board() and every leaderboard already rank it below all finishers, then by
-- reps. No table changes. This only teaches the notification text to say "CAP + 45 reps"
-- instead of a silly time. Run after 007. Safe to run more than once.

create or replace function public.format_wod_score(score_type text, score numeric)
returns text language sql immutable as $$
  select case
    when score_type = 'time' and score >= 1000000 then 'CAP + ' || round(2000000 - score)::text || ' reps'
    when score_type = 'time' then case when score >= 3600 then floor(score / 3600)::int || ':' || lpad(((floor(score)::int % 3600) / 60)::text, 2, '0')
                          else (floor(score)::int / 60)::text end
                     || ':' || lpad((floor(score)::int % 60)::text, 2, '0')
    when score_type = 'rounds_reps' then case when (score::int % 1000) = 0 then (floor(score / 1000))::int || ' rds'
                                 else (floor(score / 1000))::int || ' + ' || (score::int % 1000) end
    when score_type = 'load' then rtrim(rtrim(round(score, 2)::text, '0'), '.') || ' kg'
    else round(score)::text || ' reps'
  end
$$;

notify pgrst, 'reload schema';
