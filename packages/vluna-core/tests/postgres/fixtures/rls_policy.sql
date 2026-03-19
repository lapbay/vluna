drop table if exists billing_accounts cascade;

create table billing_accounts (
  billing_account_id text primary key,
  realm_id text not null,
  balance_xusd bigint default 0
);

alter table billing_accounts enable row level security;
alter table billing_accounts force row level security;
create policy p_ba_rw on billing_accounts
  using (billing_account_id = current_setting('app.billing_account_id', true))
  with check (billing_account_id = current_setting('app.billing_account_id', true));

grant select, insert, update, delete on billing_accounts to vluna;
