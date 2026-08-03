-- Atlas governed reports and deterministic PDF publishing.
-- Additive. Migrations 0001 through 0012 are unchanged.

CREATE TYPE report_state AS ENUM ('draft', 'approved', 'rendered', 'delivered', 'failed');
CREATE TYPE delivery_state AS ENUM ('prepared', 'sent', 'failed');

CREATE TABLE reports (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  project_id UUID,
  template_key TEXT NOT NULL,
  template_version INTEGER NOT NULL,
  audience_role TEXT NOT NULL,
  profile_version INTEGER NOT NULL,
  title TEXT NOT NULL,
  state report_state NOT NULL DEFAULT 'draft',
  -- The exact instant the source data was frozen at.
  source_cutoff TIMESTAMPTZ NOT NULL,
  narrative TEXT NOT NULL DEFAULT '',
  approved_by_actor_id UUID,
  approved_at TIMESTAMPTZ,
  rendered_artifact_id UUID,
  render_error TEXT NOT NULL DEFAULT '',
  created_by_actor_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  archived_at TIMESTAMPTZ,
  CONSTRAINT reports_organization_id_id_unique UNIQUE (organization_id, id),
  CONSTRAINT reports_project_fk FOREIGN KEY (organization_id, project_id)
    REFERENCES project_rooms (organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT reports_creator_fk FOREIGN KEY (organization_id, created_by_actor_id)
    REFERENCES actors (organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT reports_approver_fk FOREIGN KEY (organization_id, approved_by_actor_id)
    REFERENCES actors (organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT reports_artifact_fk FOREIGN KEY (organization_id, rendered_artifact_id)
    REFERENCES artifacts (organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT reports_approval_check CHECK (
    (state = 'draft' AND approved_by_actor_id IS NULL AND approved_at IS NULL)
    OR (state <> 'draft' AND approved_by_actor_id IS NOT NULL AND approved_at IS NOT NULL)
  )
);

CREATE INDEX reports_organization_created_idx
  ON reports (organization_id, created_at DESC);

-- The frozen source. Written once when the report is prepared and never updated,
-- so a render months later reproduces exactly what was approved.
CREATE TABLE report_snapshots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  report_id UUID NOT NULL,
  content JSONB NOT NULL,
  source_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
  section_decisions JSONB NOT NULL DEFAULT '[]'::jsonb,
  visibility_notes JSONB NOT NULL DEFAULT '[]'::jsonb,
  checksum TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT report_snapshots_organization_id_id_unique UNIQUE (organization_id, id),
  CONSTRAINT report_snapshots_report_unique UNIQUE (organization_id, report_id),
  CONSTRAINT report_snapshots_report_fk FOREIGN KEY (organization_id, report_id)
    REFERENCES reports (organization_id, id) ON DELETE RESTRICT
);

CREATE TABLE report_deliveries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  report_id UUID NOT NULL,
  artifact_id UUID NOT NULL,
  channel TEXT NOT NULL,
  sender TEXT NOT NULL,
  recipient TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  state delivery_state NOT NULL DEFAULT 'prepared',
  provider_acceptance TEXT NOT NULL DEFAULT '',
  authorized_by_actor_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  sent_at TIMESTAMPTZ,
  CONSTRAINT report_deliveries_organization_id_id_unique UNIQUE (organization_id, id),
  CONSTRAINT report_deliveries_idempotency_unique UNIQUE (organization_id, idempotency_key),
  CONSTRAINT report_deliveries_report_fk FOREIGN KEY (organization_id, report_id)
    REFERENCES reports (organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT report_deliveries_artifact_fk FOREIGN KEY (organization_id, artifact_id)
    REFERENCES artifacts (organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT report_deliveries_actor_fk FOREIGN KEY (organization_id, authorized_by_actor_id)
    REFERENCES actors (organization_id, id) ON DELETE RESTRICT,
  -- A delivery only counts as sent once the provider accepted it.
  CONSTRAINT report_deliveries_sent_check CHECK (
    (state = 'sent' AND provider_acceptance <> '' AND sent_at IS NOT NULL)
    OR (state <> 'sent')
  )
);

DO $permissions$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'atlas_web')
     AND EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'atlas_worker') THEN
    GRANT SELECT, INSERT ON reports, report_snapshots, report_deliveries TO atlas_web;
    GRANT UPDATE (
      state, narrative, approved_by_actor_id, approved_at, rendered_artifact_id,
      render_error, updated_at, archived_at, title
    ) ON reports TO atlas_web;
    GRANT UPDATE (state, provider_acceptance, sent_at) ON report_deliveries TO atlas_web;
    -- A snapshot is the frozen record; it is never rewritten.
    REVOKE UPDATE, DELETE ON report_snapshots FROM atlas_web;

    REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM atlas_worker;
    GRANT SELECT ON outbox_events TO atlas_worker;
    GRANT UPDATE (
      attempt_count, available_at, processing_started_at, processing_token,
      published_at, terminal_at, last_error, updated_at
    ) ON outbox_events TO atlas_worker;
  END IF;
END
$permissions$;
