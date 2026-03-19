-- Minimal schema for idempotency_envelopes used in tests
create table if not exists idempotency_envelopes (
  idempotency_id serial primary key,
  realm_id text not null,
  service text not null,
  operation text not null,
  scope_type text not null,
  scope_id text,
  billing_account_id text,
  key text not null,
  request_hash text not null,
  status text not null,
  request_snapshot jsonb,
  response_snapshot jsonb,
  result_ref jsonb,
  metadata jsonb default '{}'::jsonb,
  created_at timestamptz default now(),
  finalized_at timestamptz
);

create unique index if not exists idx_idem_unique
  on idempotency_envelopes (realm_id, service, operation, scope_type, coalesce(scope_id, ''), key);

-- RLS: bind to app.billing_account_id for write/read
alter table idempotency_envelopes enable row level security;
create policy p_idem_rw on idempotency_envelopes
  using (coalesce(billing_account_id, '') = coalesce(current_setting('app.billing_account_id', true), ''))
  with check (coalesce(billing_account_id, '') = coalesce(current_setting('app.billing_account_id', true), ''));

grant select, insert, update, delete on idempotency_envelopes to vluna;
