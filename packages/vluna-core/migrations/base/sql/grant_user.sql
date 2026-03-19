BEGIN;

-- Serialize role/grant changes to avoid concurrent updates when multiple test suites
-- (or dev processes) attempt to provision the same role at the same time.
SELECT pg_advisory_xact_lock(hashtext('vluna.grant_user.sql'));

DO $grant_user$
DECLARE
  role_password text := current_setting('app.vluna_password', true);
  role_name text := coalesce(current_setting('app.vluna_role', true), 'vluna');
  dbname text := current_database();
BEGIN
  IF role_password IS NULL OR btrim(role_password) = '' THEN
    RAISE EXCEPTION
      'app.vluna_password is not set. Set it via set_config before running grant_user.sql.';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = role_name) THEN
    EXECUTE format(
      'CREATE ROLE %I WITH LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS',
      role_name, role_password
    );
  ELSE
    EXECUTE format(
      'ALTER ROLE %I WITH LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS',
      role_name, role_password
    );
  END IF;
END;
$grant_user$;

-- Grant on the current database to keep this script portable (avoids hard-coded DB name).
DO $grant_db$
DECLARE
  dbname text := current_database();
  role_name text := coalesce(current_setting('app.vluna_role', true), 'vluna');
BEGIN
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO %I', dbname, role_name);
END;
$grant_db$;

DO $grant_schema$
DECLARE
  role_name text := coalesce(current_setting('app.vluna_role', true), 'vluna');
  schema_name text := nullif(current_setting('app.vluna_schema', true), '');
BEGIN
  IF schema_name IS NULL THEN
    RAISE EXCEPTION
      'app.vluna_schema is not set. Set it via set_config or connection options before running grant_user.sql.';
  END IF;
  EXECUTE format('GRANT USAGE ON SCHEMA %I TO %I', schema_name, role_name);
  EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA %I TO %I', schema_name, role_name);
  EXECUTE format('GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA %I TO %I', schema_name, role_name);
END;
$grant_schema$;

DO $default_privs$
DECLARE
  role_name text := coalesce(current_setting('app.vluna_role', true), 'vluna');
  schema_name text := nullif(current_setting('app.vluna_schema', true), '');
BEGIN
  IF schema_name IS NULL THEN
    RAISE EXCEPTION
      'app.vluna_schema is not set. Set it via set_config or connection options before running grant_user.sql.';
  END IF;
  -- Ensure tables/sequences created after this script remain accessible to the app role.
  EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA %I GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO %I', schema_name, role_name);
  EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA %I GRANT USAGE, SELECT ON SEQUENCES TO %I', schema_name, role_name);
END;
$default_privs$;

COMMIT;
