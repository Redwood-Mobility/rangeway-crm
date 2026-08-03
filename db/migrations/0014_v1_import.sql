-- Atlas V1 import provenance.
-- Additive. Migrations 0001 through 0013 are unchanged.
--
-- Every record brought across from the preserved SQLite application keeps a row
-- here. It makes the import idempotent, and it means an imported fact can always
-- be traced back to the exact V1 row it came from rather than being presented as
-- independently verified truth.

CREATE TABLE v1_import_records (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  source_table TEXT NOT NULL,
  source_id TEXT NOT NULL,
  target_table TEXT NOT NULL,
  target_id UUID NOT NULL,
  source_digest TEXT NOT NULL,
  imported_by_actor_id UUID NOT NULL,
  imported_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT v1_import_records_organization_id_id_unique UNIQUE (organization_id, id),
  CONSTRAINT v1_import_records_source_unique UNIQUE (organization_id, source_table, source_id),
  CONSTRAINT v1_import_records_actor_fk FOREIGN KEY (organization_id, imported_by_actor_id)
    REFERENCES actors (organization_id, id) ON DELETE RESTRICT
);

CREATE INDEX v1_import_records_target_idx
  ON v1_import_records (organization_id, target_table, target_id);

DO $permissions$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'atlas_web')
     AND EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'atlas_worker') THEN
    GRANT SELECT, INSERT ON v1_import_records TO atlas_web;
    -- Import provenance is evidence; it is never rewritten.
    REVOKE UPDATE, DELETE ON v1_import_records FROM atlas_web;

    REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM atlas_worker;
    GRANT SELECT ON outbox_events TO atlas_worker;
    GRANT UPDATE (
      attempt_count, available_at, processing_started_at, processing_token,
      published_at, terminal_at, last_error, updated_at
    ) ON outbox_events TO atlas_worker;
  END IF;
END
$permissions$;
