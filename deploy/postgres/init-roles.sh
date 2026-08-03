#!/usr/bin/env bash
set -euo pipefail

: "${POSTGRES_USER:?POSTGRES_USER is required}"
: "${POSTGRES_DB:?POSTGRES_DB is required}"
: "${POSTGRES_BOOTSTRAP_PASSWORD:?POSTGRES_BOOTSTRAP_PASSWORD is required}"
: "${ATLAS_MIGRATOR_PASSWORD:?ATLAS_MIGRATOR_PASSWORD is required}"
: "${ATLAS_WEB_PASSWORD:?ATLAS_WEB_PASSWORD is required}"
: "${ATLAS_WORKER_PASSWORD:?ATLAS_WORKER_PASSWORD is required}"
[[ "${POSTGRES_USER}" == "atlas" ]] \
  || { echo "Atlas bootstrap must run as the atlas database owner." >&2; exit 1; }
password_names=(
  POSTGRES_BOOTSTRAP_PASSWORD \
  ATLAS_MIGRATOR_PASSWORD \
  ATLAS_WEB_PASSWORD \
  ATLAS_WORKER_PASSWORD
)
password_values=()
for password_name in "${password_names[@]}"; do
  password_value="${!password_name}"
  [[ "${password_value}" =~ ^[A-Za-z0-9_-]{24,128}$ ]] \
    || { echo "${password_name} must be a 24-128 character URL-safe credential using only letters, numbers, underscore, or hyphen." >&2; exit 1; }
  password_values+=("${password_value}")
done
for ((password_index = 0; password_index < ${#password_names[@]}; password_index += 1)); do
  for ((other_index = password_index + 1; other_index < ${#password_names[@]}; other_index += 1)); do
    first_password="${password_values[password_index]}"
    second_password="${password_values[other_index]}"
    [[ "${first_password}" != "${second_password}" ]] \
      || { echo "Atlas database role credentials must be pairwise distinct." >&2; exit 1; }
  done
done
unset password_value password_values first_password second_password

psql --variable=ON_ERROR_STOP=1 \
  --username="${POSTGRES_USER}" \
  --dbname="${POSTGRES_DB}" \
  --set=bootstrap_password="${POSTGRES_BOOTSTRAP_PASSWORD}" \
  --set=migrator_password="${ATLAS_MIGRATOR_PASSWORD}" \
  --set=web_password="${ATLAS_WEB_PASSWORD}" \
  --set=worker_password="${ATLAS_WORKER_PASSWORD}" <<'SQL'
BEGIN;

DO $roles$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'atlas_migrator') THEN
    CREATE ROLE atlas_migrator LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'atlas_web') THEN
    CREATE ROLE atlas_web LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'atlas_worker') THEN
    CREATE ROLE atlas_worker LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION;
  END IF;
END
$roles$;

ALTER ROLE atlas_migrator NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION;
ALTER ROLE atlas_web NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION;
ALTER ROLE atlas_worker NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION;

SELECT format('ALTER ROLE atlas PASSWORD %L', :'bootstrap_password') \gexec
SELECT format('ALTER ROLE atlas_migrator PASSWORD %L', :'migrator_password') \gexec
SELECT format('ALTER ROLE atlas_web PASSWORD %L', :'web_password') \gexec
SELECT format('ALTER ROLE atlas_worker PASSWORD %L', :'worker_password') \gexec

-- The first foundation Compose topology ran migrations as atlas. Transfer only
-- the known Atlas schema objects so an existing V2 database can cross into the
-- dedicated migration role without granting that role bootstrap privileges.
DO $ownership$
DECLARE
  relation_name text;
BEGIN
  FOREACH relation_name IN ARRAY ARRAY[
    'schema_migrations',
    'organizations',
    'users',
    'actors',
    'organization_memberships',
    'audit_events',
    'outbox_events',
    'api_idempotency_keys'
  ] LOOP
    IF to_regclass(format('public.%I', relation_name)) IS NOT NULL THEN
      EXECUTE format(
        'ALTER TABLE %I.%I OWNER TO atlas_migrator',
        'public',
        relation_name
      );
    END IF;
  END LOOP;

  IF EXISTS (
    SELECT 1 FROM pg_type t
    JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE n.nspname = 'public' AND t.typname = 'actor_type'
  ) THEN
    ALTER TYPE public.actor_type OWNER TO atlas_migrator;
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_type t
    JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE n.nspname = 'public' AND t.typname = 'organization_role'
  ) THEN
    ALTER TYPE public.organization_role OWNER TO atlas_migrator;
  END IF;
END
$ownership$;

SELECT format('REVOKE CONNECT ON DATABASE %I FROM PUBLIC', current_database()) \gexec
SELECT format('GRANT CONNECT, CREATE ON DATABASE %I TO atlas_migrator', current_database()) \gexec
SELECT format('GRANT CONNECT ON DATABASE %I TO atlas_web, atlas_worker', current_database()) \gexec

REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT USAGE, CREATE ON SCHEMA public TO atlas_migrator;
GRANT USAGE ON SCHEMA public TO atlas_web, atlas_worker;

COMMIT;
SQL
