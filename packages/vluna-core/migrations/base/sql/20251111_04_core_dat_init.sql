CREATE TABLE IF NOT EXISTS dat_bootstrap_tokens (
  token_id text PRIMARY KEY,
  token_hash text NOT NULL UNIQUE,
  token_value text NOT NULL UNIQUE,
  subject_type text NOT NULL DEFAULT 'operator',
  subject_id text NOT NULL,
  organization_id text NULL,
  allowed_realms text[] DEFAULT NULL,
  granted_scopes text[] NOT NULL DEFAULT '{}',
  issued_by text NULL,
  status text NOT NULL DEFAULT 'active',
  expires_at timestamptz NULL,
  last_used_at timestamptz NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chk_dat_bootstrap_subject_type CHECK (subject_type IN ('operator')),
  CONSTRAINT chk_dat_bootstrap_status CHECK (status IN ('active', 'revoked', 'expired'))
);

CREATE INDEX IF NOT EXISTS idx_dat_bootstrap_subject_status
  ON dat_bootstrap_tokens(subject_type, subject_id, status);

CREATE INDEX IF NOT EXISTS idx_dat_bootstrap_org_status
  ON dat_bootstrap_tokens(organization_id, status);

CREATE INDEX IF NOT EXISTS idx_dat_bootstrap_expires_at
  ON dat_bootstrap_tokens(expires_at);

CREATE TABLE IF NOT EXISTS dat_revoked_jtis (
  jti text PRIMARY KEY,
  token_use text NOT NULL,
  subject_type text NULL,
  subject_id text NULL,
  organization_id text NULL,
  reason text NULL,
  revoked_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NULL
);

CREATE INDEX IF NOT EXISTS idx_dat_revoked_expires_at
  ON dat_revoked_jtis(expires_at);

CREATE INDEX IF NOT EXISTS idx_dat_revoked_subject
  ON dat_revoked_jtis(subject_type, subject_id);

CREATE INDEX IF NOT EXISTS idx_dat_revoked_org
  ON dat_revoked_jtis(organization_id);
