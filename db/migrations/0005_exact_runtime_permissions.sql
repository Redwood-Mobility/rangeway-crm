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
  END IF;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'atlas_worker') THEN
    REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM atlas_worker;
    GRANT USAGE ON SCHEMA public TO atlas_worker;
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
