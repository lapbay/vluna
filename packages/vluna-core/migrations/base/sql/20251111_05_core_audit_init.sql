CREATE TABLE IF NOT EXISTS audit_logs (
  audit_id uuid PRIMARY KEY,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  scope_type text NOT NULL,
  realm_id text NULL,
  actor_type text NOT NULL,
  actor_id text NULL,
  actor_display text NULL,
  auth_scheme text NULL,
  action text NOT NULL,
  target_type text NULL,
  target_id text NULL,
  operation_id text NULL,
  method text NOT NULL,
  path text NOT NULL,
  route_template text NULL,
  status text NOT NULL,
  http_status integer NOT NULL,
  error_code text NULL,
  trace_id text NULL,
  params_json jsonb NULL,
  query_json jsonb NULL,
  body_json_redacted jsonb NULL,
  response_json_redacted jsonb NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chk_audit_scope_type CHECK (scope_type IN ('realm', 'platform')),
  CONSTRAINT chk_audit_status CHECK (status IN ('success', 'failure'))
);

CREATE INDEX IF NOT EXISTS idx_audit_logs_occurred_at
  ON audit_logs(occurred_at DESC);

CREATE INDEX IF NOT EXISTS idx_audit_logs_scope_realm_occurred_at
  ON audit_logs(scope_type, realm_id, occurred_at DESC);

CREATE INDEX IF NOT EXISTS idx_audit_logs_action_occurred_at
  ON audit_logs(action, occurred_at DESC);

CREATE INDEX IF NOT EXISTS idx_audit_logs_actor_occurred_at
  ON audit_logs(actor_type, actor_id, occurred_at DESC);

CREATE INDEX IF NOT EXISTS idx_audit_logs_target_occurred_at
  ON audit_logs(target_type, target_id, occurred_at DESC);

CREATE INDEX IF NOT EXISTS idx_audit_logs_trace_id
  ON audit_logs(trace_id);
