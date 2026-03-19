-- =====================================================================
-- Runtime Usage Gating schema (v1.1)
-- Self-contained schema for a fresh installation. No ALTERs, no history.
-- Conventions:
-- - Integer XUSD units for all consumptions and costs
-- - timestamptz; now() defaults; jsonb metadata
-- - RLS scoped by current_setting('app.realm_id') and current_setting('app.billing_account_id')
-- =====================================================================

CREATE EXTENSION IF NOT EXISTS btree_gist;

-- Utility: updated_at trigger
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END$$;

CREATE OR REPLACE FUNCTION is_valid_uuid(str text)
RETURNS boolean LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE AS $$
BEGIN
  IF str IS NULL THEN
    RETURN false;
  END IF;
  RETURN str ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';
END;
$$;

CREATE OR REPLACE FUNCTION get_current_billing_account_id()
RETURNS uuid LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE AS $$
DECLARE
  billing_account_id_str text := current_setting('app.billing_account_id', true);
BEGIN
  IF is_valid_uuid(billing_account_id_str) THEN
    RETURN billing_account_id_str::uuid;
  ELSE
    RETURN NULL;
  END IF;
END;
$$;

-- =====================================================================
-- Policy Bundles: group of policies per tier/account
-- =====================================================================
CREATE TABLE gate_policy_bundles (
  bundle_id     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  realm_id      text        NOT NULL REFERENCES realms(realm_id) ON DELETE RESTRICT,
  bundle_key    text        NOT NULL,
  name          text        NULL,
  status        text        NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
  metadata      jsonb       NOT NULL DEFAULT '{}'::jsonb,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (realm_id, bundle_key)
);

CREATE TRIGGER trg_policy_bundles_updated BEFORE UPDATE ON gate_policy_bundles
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DO $$
BEGIN
  BEGIN
    ALTER TABLE billing_accounts
      ADD CONSTRAINT fk_billing_accounts_bundle
      FOREIGN KEY (current_bundle_id) REFERENCES gate_policy_bundles(bundle_id) ON DELETE SET NULL;
  EXCEPTION WHEN duplicate_object THEN NULL; END;
END$$;

-- =====================================================================
-- Policies: quantitative rules evaluated by gate engine
-- =====================================================================
-- Gate policies (column-first; no JSON required for core semantics)
CREATE TABLE gate_policies (
  policy_id     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  realm_id      text        NOT NULL REFERENCES realms(realm_id) ON DELETE RESTRICT,
  bundle_id     uuid        NOT NULL REFERENCES gate_policy_bundles(bundle_id) ON DELETE CASCADE,
  name          text        NOT NULL,                          -- human-readable, versioned
  description   text        NULL,
  feature_code  text        NOT NULL,                          -- feature where this applies
  kind          text        NOT NULL,                          -- rate | quota | seats
  unit          text        NOT NULL,                          -- 'request' | 'token' | ...
  window_sec    int         NOT NULL,                          -- 0 means no window
  -- limits (mutually exclusive by kind)
  limit_count   bigint      NULL,                              -- for rate / concurrency
  limit_minor   bigint      NULL,                              -- for quota (minor units)
  status        text        NOT NULL DEFAULT 'assignable'
                             CHECK (status IN ('default','assignable','ceiling','disabled')),
  enforcement_mode text     NOT NULL DEFAULT 'optimistic'
                             CHECK (enforcement_mode IN ('optimistic','reserve')),
  metadata      jsonb       NOT NULL DEFAULT '{}'::jsonb,      -- optional extensions / labels
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  -- per-kind shape validation
  CHECK (
    (kind IN ('rate','concurrency') AND limit_count IS NOT NULL AND limit_minor IS NULL AND window_sec >= 0)
    OR
    (kind = 'quota' AND limit_minor IS NOT NULL AND limit_count IS NULL AND window_sec > 0)
    OR
    (kind = 'seats' AND limit_count IS NOT NULL AND limit_minor IS NULL AND window_sec >= 0 AND limit_count >= -1)
  ),
  CHECK (kind <> 'seats' OR unit = 'seat'),
  UNIQUE (realm_id, name)
);

-- updated_at trigger (uses set_updated_at() defined earlier in this file)
CREATE TRIGGER trg_policies_updated BEFORE UPDATE ON gate_policies
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Uniqueness for default/ceiling per (realm, feature, kind, unit, window)
CREATE UNIQUE INDEX gate_policies_default_uniq
  ON gate_policies (realm_id, feature_code, kind, unit, window_sec)
  WHERE status = 'default';

CREATE UNIQUE INDEX gate_policies_ceiling_uniq
  ON gate_policies (realm_id, feature_code, kind, unit, window_sec)
  WHERE status = 'ceiling';

-- Fast lookup for authorize/commit
CREATE INDEX gate_policies_lookup
  ON gate_policies (realm_id, feature_code, kind, unit, window_sec)
  WHERE status <> 'disabled';

-- =====================================================================
-- Leases
-- =====================================================================
CREATE TABLE gate_leases (
  lease_id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  billing_account_id uuid NOT NULL REFERENCES billing_accounts(billing_account_id) ON DELETE CASCADE,
  policy_id          uuid    NOT NULL REFERENCES gate_policies(policy_id) ON DELETE RESTRICT,
  feature_code       text    NOT NULL,
  cap_minor          bigint  NOT NULL CHECK (cap_minor >= 0),
  state              text    NOT NULL CHECK (state IN ('active','closed','expired','canceled')),
  expires_at         timestamptz NOT NULL,
  idempotency_key    text    NOT NULL,
  request_hash       text    NULL,
  budget_id          uuid    NULL REFERENCES budgets(budget_id) ON DELETE SET NULL,
  reservation_minor  bigint  NOT NULL DEFAULT 0 CHECK (reservation_minor >= 0),
  metadata           jsonb   NOT NULL DEFAULT '{}'::jsonb,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (billing_account_id, idempotency_key)
);

CREATE INDEX idx_gl_ba ON gate_leases(billing_account_id);
CREATE INDEX idx_gl_feature_code ON gate_leases(feature_code);
CREATE INDEX idx_gl_budget ON gate_leases(budget_id);

CREATE TRIGGER trg_leases_updated BEFORE UPDATE ON gate_leases
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- =====================================================================
-- Counters
-- =====================================================================
CREATE TABLE gate_quota_counters (
  counter_id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  billing_account_id  uuid   NOT NULL REFERENCES billing_accounts(billing_account_id) ON DELETE CASCADE,
  feature_code        text   NOT NULL,
  key                 text   NOT NULL,
  window_start        timestamptz NOT NULL,
  window_end          timestamptz NOT NULL,
  limit_minor         bigint NOT NULL CHECK (limit_minor >= -1),
  used_minor          bigint NOT NULL DEFAULT 0 CHECK (used_minor >= 0),
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (billing_account_id, feature_code, key, window_start, window_end)
);

CREATE INDEX idx_gqc_ba ON gate_quota_counters(billing_account_id);
CREATE INDEX idx_gqc_window ON gate_quota_counters(window_start, window_end);

CREATE TRIGGER trg_gqc_updated BEFORE UPDATE ON gate_quota_counters
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- =====================================================================
-- Seats (account-scoped seat state for enforcement)
-- =====================================================================
CREATE TABLE gate_seats (
  seat_row_id       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  billing_account_id uuid NOT NULL REFERENCES billing_accounts(billing_account_id) ON DELETE CASCADE,
  feature_code      text NOT NULL,
  seat_id           text NOT NULL,
  state             text NOT NULL CHECK (state IN ('active','revoked')),
  assigned_at       timestamptz NOT NULL DEFAULT now(),
  last_seen_at      timestamptz NOT NULL DEFAULT now(),
  revoked_at        timestamptz NULL,
  metadata          jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (billing_account_id, feature_code, seat_id)
);

CREATE INDEX idx_gate_seats_ba_feature_state ON gate_seats(billing_account_id, feature_code, state);
CREATE INDEX idx_gate_seats_ba_feature_last_seen ON gate_seats(billing_account_id, feature_code, last_seen_at);

CREATE TRIGGER trg_gate_seats_updated BEFORE UPDATE ON gate_seats
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- =====================================================================
-- Residual buckets (optional): ensure long-run equivalence to merge-then-round
-- Bucket key: (billing_account_id, meter_code, pricing_fingerprint)
-- =====================================================================
CREATE TABLE IF NOT EXISTS gate_residual_buckets (
  billing_account_id  uuid        NOT NULL REFERENCES billing_accounts(billing_account_id) ON DELETE CASCADE,
  meter_code          text        NOT NULL,
  pricing_fingerprint text        NOT NULL,
  denom               bigint      NOT NULL CHECK (denom >= 1),  -- equals unit_quantity_minor
  rounding            text        NOT NULL CHECK (rounding IN ('floor','nearest','ceil')),
  remainder_numer     bigint      NOT NULL CHECK (remainder_numer >= 0),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (billing_account_id, meter_code, pricing_fingerprint)
);
CREATE INDEX IF NOT EXISTS idx_grb_ba_res ON gate_residual_buckets(billing_account_id, meter_code);

-- =====================================================================
-- RLS enablement (loop-based)
-- =====================================================================
DO $$
DECLARE
  t text;
BEGIN
  -- Enable RLS on all gate_* tables in one pass
  FOREACH t IN ARRAY ARRAY[
    'gate_policy_bundles',
    'gate_policies',
    'gate_leases',
    'gate_quota_counters',
    'gate_residual_buckets',
    'gate_seats'
  ]
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
  END LOOP;
END$$;

-- =====================================================================

-- RLS policies (loop-based)
-- This file runs AFTER sql_migrations_v1.sql, so realms & billing_accounts exist.
DO $$
DECLARE
  t text;
  expr text;
BEGIN
  -- 1) Realm-only tables (have realm_id column)
  FOR t IN SELECT unnest(ARRAY['gate_policy_bundles','gate_policies'])
  LOOP
    expr := 'realm_id = current_setting(''app.realm_id'', true)';
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY %I ON %I FOR SELECT USING (%s)', t || '_realm_read', t, expr);
    EXECUTE format('CREATE POLICY %I ON %I FOR INSERT WITH CHECK (%s)', t || '_realm_insert', t, expr);
    EXECUTE format('CREATE POLICY %I ON %I FOR UPDATE USING (%s) WITH CHECK (%s)', t || '_realm_update', t, expr, expr);
    EXECUTE format('CREATE POLICY %I ON %I FOR DELETE USING (%s)', t || '_realm_delete', t, expr);
  END LOOP;

  -- 2) Account-scoped tables (NO realm_id column). Scope by current billing_account_id and ensure that account belongs to current realm.
  FOR t IN SELECT unnest(ARRAY['gate_leases','gate_quota_counters','gate_residual_buckets'])
  LOOP
    expr := 'billing_account_id = get_current_billing_account_id() AND EXISTS (SELECT 1 FROM billing_accounts ba WHERE ba.billing_account_id = ' || t || '.billing_account_id AND ba.realm_id = current_setting(''app.realm_id'', true))';
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY %I ON %I FOR SELECT USING (%s)', t || '_acct_read', t, expr);
    EXECUTE format('CREATE POLICY %I ON %I FOR INSERT WITH CHECK (%s)', t || '_acct_insert', t, expr);
    EXECUTE format('CREATE POLICY %I ON %I FOR UPDATE USING (%s) WITH CHECK (%s)', t || '_acct_update', t, expr, expr);
    EXECUTE format('CREATE POLICY %I ON %I FOR DELETE USING (%s)', t || '_acct_delete', t, expr);
  END LOOP;

  expr := 'billing_account_id = get_current_billing_account_id() AND EXISTS (SELECT 1 FROM billing_accounts ba WHERE ba.billing_account_id = gate_seats.billing_account_id AND ba.realm_id = current_setting(''app.realm_id'', true))';
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', 'gate_seats');
  EXECUTE format('CREATE POLICY %I ON %I FOR SELECT USING (%s)', 'gate_seats_acct_read', 'gate_seats', expr);
  EXECUTE format('CREATE POLICY %I ON %I FOR INSERT WITH CHECK (%s)', 'gate_seats_acct_insert', 'gate_seats', expr);
  EXECUTE format('CREATE POLICY %I ON %I FOR UPDATE USING (%s) WITH CHECK (%s)', 'gate_seats_acct_update', 'gate_seats', expr, expr);
  EXECUTE format('CREATE POLICY %I ON %I FOR DELETE USING (%s)', 'gate_seats_acct_delete', 'gate_seats', expr);

END$$;
