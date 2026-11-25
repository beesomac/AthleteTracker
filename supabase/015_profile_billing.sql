-- 015: Profile, membership plans and Stripe billing.
-- Run after 004 (members) and 014 (privacy hardening). Safe to run more than once.
--
--   1. members gets contact details each person can edit for themselves: phone and an
--      emergency contact. No health information lives here (rehab notes stay in notes/programs).
--   2. plans: the memberships people can buy (name, price in cents, AUD, billed every N weeks,
--      months or years). Trainers create and change them in the console, which goes through the
--      "billing" edge function so the matching Stripe product and price are kept in step.
--   3. billing_customers and subscriptions: a copy of what Stripe says, written only by the
--      edge functions with the service key. Everyone can read their own; trainers read all.
--      Card details never touch this database: Stripe Checkout and the Stripe customer portal
--      collect and keep them. Stripe only ever gets the member's email, the plan and the payment,
--      never health details (so keep plan names free of conditions, e.g. "Supervised rehab", not
--      "ACL rehab"). Stripe is a US company: list it as an overseas recipient in the privacy policy.
--   4. my_profile() and update_my_profile() for the Profile screens (web and iPhone).

-- ─── 1. Contact details on members ─────────────────────────────────────────────────────
alter table public.members add column if not exists phone text;
alter table public.members add column if not exists emergency_name text;
alter table public.members add column if not exists emergency_phone text;

-- ─── 2. Plans ──────────────────────────────────────────────────────────────────────────
create table if not exists public.plans (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(trim(name)) > 0),
  description text,
  -- e.g. "rehab", "open_gym": lets the booking system match a plan to a session type later.
  category text,
  amount_cents integer not null check (amount_cents > 0),
  currency text not null default 'aud' check (currency = lower(currency)),
  billing_interval text not null default 'week' check (billing_interval in ('week', 'month', 'year')),
  interval_count integer not null default 1 check (interval_count between 1 and 52),
  -- null = unlimited; for the booking system to check against.
  sessions_per_week integer check (sessions_per_week is null or sessions_per_week > 0),
  active boolean not null default true,
  sort integer not null default 0,
  stripe_product_id text unique,
  stripe_price_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.plans enable row level security;
drop policy if exists "members read plans" on public.plans;
create policy "members read plans" on public.plans for select to authenticated
  using (public.is_trainer() or (active and public.am_i_allowed()));
-- No write policies: the billing edge function saves plans (it creates the Stripe price too).

-- ─── 3. Stripe customers and subscriptions ─────────────────────────────────────────────
create table if not exists public.billing_customers (
  email text primary key references public.members(email) on update cascade on delete cascade,
  stripe_customer_id text not null unique,
  created_at timestamptz not null default now()
);
alter table public.billing_customers enable row level security;
drop policy if exists "read own billing customer" on public.billing_customers;
create policy "read own billing customer" on public.billing_customers for select to authenticated
  using (public.is_trainer() or email = public.my_email());

create table if not exists public.subscriptions (
  stripe_subscription_id text primary key,
  email text not null references public.members(email) on update cascade on delete cascade,
  stripe_customer_id text not null,
  plan_id uuid references public.plans(id) on delete set null,
  -- Stripe's status: trialing, active, past_due, unpaid, canceled, incomplete, incomplete_expired, paused
  status text not null,
  current_period_end timestamptz,
  cancel_at_period_end boolean not null default false,
  canceled_at timestamptz,
  updated_at timestamptz not null default now()
);
create index if not exists subscriptions_email on public.subscriptions (email);
alter table public.subscriptions enable row level security;
drop policy if exists "read own subscriptions" on public.subscriptions;
create policy "read own subscriptions" on public.subscriptions for select to authenticated
  using (public.is_trainer() or email = public.my_email());

-- ─── 4. Profile functions ──────────────────────────────────────────────────────────────
-- The signed-in person's details and their current membership (the newest subscription that
-- isn't finished, else the newest one), in one call.
drop function if exists public.my_profile();
create or replace function public.my_profile()
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'email', m.email,
    'display_name', m.display_name,
    'role', m.role,
    'phone', m.phone,
    'emergency_name', m.emergency_name,
    'emergency_phone', m.emergency_phone,
    'has_billing', exists (select 1 from public.billing_customers c where c.email = m.email),
    'subscription', (
      select jsonb_build_object(
        'status', s.status,
        'current_period_end', s.current_period_end,
        'cancel_at_period_end', s.cancel_at_period_end,
        'plan_id', s.plan_id,
        'plan_name', p.name,
        'amount_cents', p.amount_cents,
        'currency', p.currency,
        'billing_interval', p.billing_interval,
        'interval_count', p.interval_count)
      from public.subscriptions s left join public.plans p on p.id = s.plan_id
      where s.email = m.email
      order by (s.status in ('active', 'trialing', 'past_due', 'unpaid', 'paused')) desc, s.updated_at desc
      limit 1)
  )
  from public.members m where m.email = public.my_email() and m.active
$$;

create or replace function public.update_my_profile(
  p_display_name text, p_phone text, p_emergency_name text, p_emergency_phone text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if public.my_role() is null then raise exception 'Not allowed'; end if;
  update public.members set
    display_name = coalesce(nullif(trim(p_display_name), ''), display_name),
    phone = nullif(trim(p_phone), ''),
    emergency_name = nullif(trim(p_emergency_name), ''),
    emergency_phone = nullif(trim(p_emergency_phone), '')
  where email = public.my_email();
end $$;

revoke all on function public.my_profile(), public.update_my_profile(text, text, text, text) from public, anon;
grant execute on function public.my_profile(), public.update_my_profile(text, text, text, text) to authenticated;

-- Signed-out visitors get nothing (matches 014_privacy_hardening.sql).
revoke all on public.plans, public.billing_customers, public.subscriptions from anon;
