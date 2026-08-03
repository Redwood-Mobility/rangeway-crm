DO $permissions$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'atlas_worker') THEN
    REVOKE UPDATE ON outbox_events FROM atlas_worker;
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
