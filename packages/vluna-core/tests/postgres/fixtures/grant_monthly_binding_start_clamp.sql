-- Regression fixture: month-based grant issuance anchored to binding_start must not drift/overflow
-- (e.g. Jan 31 should clamp to Feb 28, then March 31; never produce Feb 03, etc.).

drop table if exists ledger_grants cascade;
drop table if exists grant_assignments cascade;
drop table if exists grant_programs cascade;
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
  billing_plan_assignment_id bigint null,
  campaign_id bigint null,
  source_kind text not null,
  source_ref text not null,
  window_start timestamptz not null default now(),
  window_end timestamptz null,
  valid_range tstzrange generated always as (tstzrange(window_start, coalesce(window_end, 'infinity'::timestamptz))) stored,
  status text not null default 'active',
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
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
