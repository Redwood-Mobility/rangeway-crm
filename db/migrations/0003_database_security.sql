CREATE OR REPLACE FUNCTION atlas_reject_audit_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  RAISE EXCEPTION 'audit_events is append-only'
    USING ERRCODE = 'P0001';
END
$function$;

CREATE TRIGGER audit_events_reject_mutation
BEFORE UPDATE OR DELETE OR TRUNCATE ON audit_events
FOR EACH STATEMENT
EXECUTE FUNCTION atlas_reject_audit_mutation();

REVOKE CREATE ON SCHEMA public FROM PUBLIC;
REVOKE ALL PRIVILEGES ON schema_migrations FROM PUBLIC;
REVOKE UPDATE, DELETE, TRUNCATE ON audit_events FROM PUBLIC;

DO $permissions$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'atlas_web') THEN
    REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM atlas_web;
    GRANT USAGE ON SCHEMA public TO atlas_web;
    GRANT SELECT ON
      organizations,
      users,
      actors,
      organization_memberships,
      audit_events,
      outbox_events,
      api_idempotency_keys
    TO atlas_web;
    GRANT INSERT ON
      users,
      actors,
      organization_memberships,
      audit_events,
      outbox_events,
      api_idempotency_keys
    TO atlas_web;
    GRANT UPDATE ON organizations, users, actors, api_idempotency_keys TO atlas_web;
    REVOKE ALL PRIVILEGES ON schema_migrations FROM atlas_web;
    REVOKE UPDATE, DELETE, TRUNCATE ON audit_events FROM atlas_web;
  END IF;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'atlas_worker') THEN
    REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM atlas_worker;
    GRANT USAGE ON SCHEMA public TO atlas_worker;
    GRANT SELECT, UPDATE ON outbox_events TO atlas_worker;
    REVOKE ALL PRIVILEGES ON schema_migrations FROM atlas_worker;
    REVOKE ALL PRIVILEGES ON audit_events FROM atlas_worker;
  END IF;
END
$permissions$;
