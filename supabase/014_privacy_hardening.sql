-- 014: privacy and security hardening for health information.
-- Run after 012 (and after 013 if that has been run; it doesn't depend on it). Safe to run more than once.
--
-- What it does:
--   1. Signed-out visitors (the "anon" role) lose all access to tables and functions. Nothing in the
--      web site or iOS app talks to the database before sign-in, and no row-level policy ever allowed
--      anon, so nothing changes for anyone; it just removes the door entirely.
--   2. Trigger-only functions can no longer be called directly through the API.
--   3. Fixes the two "function search path mutable" warnings from the Supabase security advisor.
--   4. Adds an append-only audit_log: who added, changed or deleted which health record, and when.
--      It stores keys and changed column names only, never the note text or the values, so it doesn't
--      become a second copy of anyone's health information. Only trainers can read it, and nobody can
--      edit or delete it through the API.
--
-- To undo part 4:  drop table public.audit_log cascade;  drop function public.audit_row();

-- 1. No signed-out access ---------------------------------------------------------------------------
revoke all on all tables in schema public from anon;
revoke all on all sequences in schema public from anon;
revoke execute on all functions in schema public from anon;
alter default privileges in schema public revoke all on tables from anon;
alter default privileges in schema public revoke all on sequences from anon;
alter default privileges in schema public revoke execute on functions from anon;
-- New functions are executable by PUBLIC by default, which includes anon.
alter default privileges in schema public revoke execute on functions from public;
-- ...so give signed-in users back the functions the apps call (they had them through PUBLIC).
do $$
declare f text;
begin
  foreach f in array array[
    'public.whoami()', 'public.member_names()', 'public.wod_board()', 'public.am_i_allowed()',
    'public.is_trainer()', 'public.my_role()', 'public.my_email()', 'public.default_athlete()',
    'public.format_wod_score(text, numeric)'
  ] loop
    if to_regprocedure(f) is not null then
      execute format('revoke execute on function %s from public', f);
      execute format('grant execute on function %s to authenticated, service_role', f);
    end if;
  end loop;
end $$;
do $$
declare p regprocedure;
begin
  -- Any function with arguments the apps call (log_benchmark, register/unregister_device_token, ...):
  for p in select oid::regprocedure from pg_proc
           where pronamespace = 'public'::regnamespace and prorettype <> 'trigger'::regtype loop
    execute format('revoke execute on function %s from public', p);
    execute format('grant execute on function %s to authenticated, service_role', p);
  end loop;
end $$;

-- 2. Trigger functions are not API endpoints ----------------------------------------------------------
do $$
declare p regprocedure;
begin
  for p in select oid::regprocedure from pg_proc
           where pronamespace = 'public'::regnamespace and prorettype = 'trigger'::regtype loop
    execute format('revoke execute on function %s from public, anon, authenticated', p);
  end loop;
end $$;

-- 3. Fixed search paths -----------------------------------------------------------------------------
alter function public.my_email() set search_path = '';
do $$ begin
  if to_regprocedure('public.format_wod_score(text, numeric)') is not null then
    alter function public.format_wod_score(text, numeric) set search_path = '';
  end if;
end $$;

-- 4. Audit log --------------------------------------------------------------------------------------
create table if not exists public.audit_log (
  id bigserial primary key,
  at timestamptz not null default now(),
  actor_email text,               -- who did it (from the sign-in), null for the system
  actor_role text,                -- trainer / athlete / null
  action text not null,           -- INSERT / UPDATE / DELETE
  table_name text not null,
  athlete_email text,             -- whose record it is, when the table has one
  row_key jsonb,                  -- ids only (id, session_id, exercise_id, ...), never note text or values
  changed_columns text[]          -- for UPDATE: which columns changed
);
create index if not exists audit_log_athlete_idx on public.audit_log (athlete_email, at desc);
create index if not exists audit_log_at_idx on public.audit_log (at desc);

alter table public.audit_log enable row level security;
drop policy if exists "trainers read audit log" on public.audit_log;
create policy "trainers read audit log" on public.audit_log
  for select to authenticated using (public.is_trainer());
revoke all on public.audit_log from anon, authenticated;
grant select on public.audit_log to authenticated;
revoke all on sequence public.audit_log_id_seq from anon, authenticated;

create or replace function public.audit_row()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  r jsonb := to_jsonb(case when tg_op = 'DELETE' then old else new end);
  o jsonb := case when tg_op = 'UPDATE' then to_jsonb(old) else null end;
  who text := nullif(lower(coalesce(auth.jwt() ->> 'email', '')), '');
  cols text[];
  keys jsonb;
begin
  select coalesce(jsonb_object_agg(k, v), '{}'::jsonb) into keys
    from jsonb_each(r) as e(k, v)
    where k in ('id', 'session_id', 'exercise_id', 'set_index', 'wod_id', 'program_id', 'lift_key', 'date', 'email');
  if tg_op = 'UPDATE' then
    select array_agg(k order by k) into cols
      from jsonb_each(r) as e(k, v)
      where v is distinct from o -> k and k not in ('updated_at');
    if cols is null then return new; end if;  -- nothing actually changed
  end if;
  insert into public.audit_log (actor_email, actor_role, action, table_name, athlete_email, row_key, changed_columns)
  values (who,
          (select m.role from public.members m where m.email = who and m.active),
          tg_op, tg_table_name,
          coalesce(r ->> 'athlete_email', case when tg_table_name = 'members' then r ->> 'email' end),
          keys, cols);
  return null;  -- AFTER trigger
end $$;
revoke execute on function public.audit_row() from public, anon, authenticated;

do $$
declare t text;
begin
  foreach t in array array['notes', 'ticks', 'lift_maxes', 'session_finishes', 'members', 'programs', 'wod_results'] loop
    if to_regclass('public.' || t) is not null then
      execute format('drop trigger if exists audit_%1$s on public.%1$I', t);
      execute format('create trigger audit_%1$s after insert or update or delete on public.%1$I
                      for each row execute function public.audit_row()', t);
    end if;
  end loop;
end $$;

notify pgrst, 'reload schema';
