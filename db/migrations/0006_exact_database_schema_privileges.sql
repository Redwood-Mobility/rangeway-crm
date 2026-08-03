DO $permissions$
DECLARE
  database_name text := current_database();
BEGIN
  EXECUTE format('REVOKE ALL PRIVILEGES ON DATABASE %I FROM PUBLIC', database_name);

  REVOKE ALL PRIVILEGES ON SCHEMA public FROM PUBLIC;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'atlas_web')
     AND EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'atlas_worker') THEN
    EXECUTE format(
      'REVOKE ALL PRIVILEGES ON DATABASE %I FROM atlas_web, atlas_worker',
      database_name
    );
    EXECUTE format(
      'GRANT CONNECT ON DATABASE %I TO atlas_web, atlas_worker',
      database_name
    );

    REVOKE ALL PRIVILEGES ON SCHEMA public FROM atlas_web, atlas_worker;
    GRANT USAGE ON SCHEMA public TO atlas_web, atlas_worker;

    REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM atlas_web;
    GRANT SELECT ON
      organizations,
      users,
      actors,
      organization_memberships,
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
    GRANT UPDATE (name, updated_at) ON organizations TO atlas_web;
    GRANT UPDATE (email, display_name, google_subject, updated_at) ON users TO atlas_web;
    GRANT UPDATE (display_name, updated_at, disabled_at) ON actors TO atlas_web;
    GRANT UPDATE (response_body, completed_at) ON api_idempotency_keys TO atlas_web;

    REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM atlas_worker;
    GRANT SELECT ON outbox_events TO atlas_worker;
    GRANT UPDATE (
      attempt_count,
      available_at,
      processing_started_at,
      processing_token,
      published_at,
      terminal_at,
      last_error,
      updated_at
    ) ON outbox_events TO atlas_worker;
  END IF;
END
$permissions$;
