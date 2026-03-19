-- Minimal schema fixture for cadence=billing_period grant issuance tests.
-- Intentionally does not enable RLS to keep the test focused on issuance correctness.

drop table if exists ledger_grants cascade;
drop table if exists grant_assignments cascade;
drop table if exists grant_programs cascade;
drop table if exists billing_periods cascade;
drop table if exists subscriptions cascade;
drop table if exists billing_plan_assignments cascade;
drop table if exists billing_plans cascade;
drop table if exists billing_accounts cascade;
drop table if exists realms cascade;

create extension if not exists pgcrypto;

create table if not exists realms (
  realm_id text primary key,
  name text not null,
  status text not null default 'active',
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists billing_accounts (
  billing_account_id uuid primary key default gen_random_uuid(),
  realm_id text not null references realms(realm_id) on delete restrict,
  billing_principal_id text not null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (realm_id, billing_principal_id)
);

create table if not exists billing_plans (
  plan_id bigserial primary key,
  realm_id text not null references realms(realm_id) on delete restrict,
  plan_code text not null,
  name text not null,
  kind text not null check (kind in ('base','addon','promo')),
  priority integer not null default 0,
  active boolean not null default true,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint ux_billing_plans_plan_code unique (realm_id, plan_code)
);

create table if not exists billing_plan_assignments (
  assignment_id bigserial primary key,
  billing_account_id uuid not null references billing_accounts(billing_account_id) on delete cascade,
  plan_id bigint not null references billing_plans(plan_id) on delete restrict,
  subscription_item_id bigint null,
  source_kind text not null check (source_kind in (
    'signup.default','provider.subscription_item','provider.subscription','ops.manual','ops.campaign'
  )),
  source_ref text not null,
  window_start timestamptz not null default now(),
  window_end timestamptz null,
  valid_range tstzrange generated always as (tstzrange(window_start, coalesce(window_end, 'infinity'::timestamptz))) stored,
  status text not null default 'active' check (status in ('active','paused','canceled','expired')),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint ux_bpa_account_plan_source unique (billing_account_id, plan_id, source_kind, source_ref)
);

create table if not exists subscriptions (
  subscription_id text primary key,
  billing_account_id uuid not null references billing_accounts(billing_account_id) on delete cascade,
  status text not null,
  current_period_start timestamptz not null,
  current_period_end timestamptz not null
);

create table if not exists billing_periods (
  billing_period_id bigserial primary key,
  realm_id text not null references realms(realm_id) on delete restrict,
  billing_account_id uuid not null references billing_accounts(billing_account_id) on delete cascade,
  period_start timestamptz not null,
  period_end timestamptz not null,
  grace_window_seconds integer not null default 86400,
  source text not null,
  source_ref text null,
  source_subscription_id bigint null,
  source_period_start timestamptz null,
  source_period_end timestamptz null,
  status text not null default 'open' check (status in ('open','frozen','closed')),
  frozen_at timestamptz null,
  closed_at timestamptz null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (billing_account_id, period_start, period_end)
);

create table if not exists grant_programs (
  program_id bigserial primary key,
  realm_id text not null references realms(realm_id) on delete restrict,
  program_code text not null,
  name text,
  active boolean not null default true,
  cadence text not null check (cadence in ('once','daily','weekly','monthly','quarterly','yearly','billing_period')),
  issue_anchor text not null check (issue_anchor in ('calendar_start','binding_start','first_use')),
  amount_xusd bigint not null check (amount_xusd >= 0),
  window_kind text not null check (window_kind in ('period','fixed','forever','relative_duration')),
  window_default_seconds integer null check (window_default_seconds is null or window_default_seconds > 0),
  priority integer not null default 0,
  on_ledger boolean not null default false,
  issuance_mode text not null check (issuance_mode in ('eager','lazy','hybrid')),
  periodic_accounting boolean not null default false,
  accrual_mode text null check (accrual_mode in ('full_at_period_start','earn_daily')),
  eligibility_kind text not null default 'manual',
  eligibility_payload jsonb not null default '{}'::jsonb,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint ux_grant_programs_program_code unique (realm_id, program_code)
);

create table if not exists grant_assignments (
  assignment_id bigserial primary key,
  billing_account_id uuid not null references billing_accounts(billing_account_id) on delete cascade,
  program_id bigint not null references grant_programs(program_id) on delete restrict,
  billing_plan_assignment_id bigint null references billing_plan_assignments(assignment_id) on delete set null,
  campaign_id bigint null,
  source_kind text not null check (source_kind in (
    'provider.subscription','provider.subscription_item','provider.one_time','wallet.cash','ops.manual','internal.catalog','ops.campaign','billing_plan_assignment'
  )),
  source_ref text not null,
  window_start timestamptz not null default now(),
  window_end timestamptz null,
  valid_range tstzrange generated always as (tstzrange(window_start, coalesce(window_end, 'infinity'::timestamptz))) stored,
  status text not null default 'active' check (status in ('active','paused','canceled','expired')),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint ux_ga_account_program_source unique (billing_account_id, program_id, source_kind, source_ref)
);

create table if not exists ledger_grants (
  grant_id bigserial primary key,
  billing_account_id uuid not null references billing_accounts(billing_account_id) on delete cascade,
  ledger_id text null,
  source_entry_id text null,
  assignment_id bigint not null references grant_assignments(assignment_id) on delete cascade,
  program_id bigint null references grant_programs(program_id) on delete set null,
  period_start timestamptz null,
  period_end timestamptz null,
  alloc_seq integer not null default 0,
  idempotency_key text null,
  source_kind text null,
  source_ref text null,
  on_ledger boolean not null default false,
  issuance_status text not null default 'ready',
  kind text not null default 'grant',
  window_start timestamptz null,
  window_end timestamptz null,
  priority integer not null default 0,
  amount_xusd bigint not null default 0,
  cost_xusd bigint not null default 0,
  posted_consumed_xusd bigint not null default 0,
  pending_reserved_xusd bigint not null default 0,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (assignment_id, period_start, period_end, alloc_seq)
);
