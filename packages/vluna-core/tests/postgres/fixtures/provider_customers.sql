create table if not exists provider_customers (
  billing_account_id text not null,
  provider text not null,
  provider_customer_id text not null,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  primary key (billing_account_id, provider)
);

alter table provider_customers enable row level security;
create policy p_pc_rw on provider_customers
  using (billing_account_id = current_setting('app.billing_account_id', true))
  with check (billing_account_id = current_setting('app.billing_account_id', true));

grant select, insert, update, delete on provider_customers to vluna;
