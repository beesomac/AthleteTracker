-- 012: training groups on athletes, for the console's Week board (filter by group).
-- Run after 004. Safe to run more than once. Doesn't need 006-011.
--
-- members.groups is a list of free-text group names, e.g. {"Rehab", "Morning crew"}.
-- An athlete can be in any number of groups. Set them in the console: Athletes → Edit.
-- Before this runs, the Week board still works; it just has no group filter.

alter table public.members add column if not exists groups text[] not null default '{}';
