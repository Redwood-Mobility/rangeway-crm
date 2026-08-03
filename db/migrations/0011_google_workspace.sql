-- Atlas Google Workspace intelligence.
-- Additive. Migrations 0001 through 0010 are unchanged.
--
-- Everything indexed here belongs to the user whose mailbox, Drive or calendar
-- it came from. `owner_user_id` is NOT NULL on every content table, and nothing
-- in this migration is project-visible on its own. Only an explicit row in
-- `workspace_shares` makes one selected item visible inside a project.

CREATE TYPE google_connection_status AS ENUM ('connected', 'expired', 'revoked', 'error');
CREATE TYPE google_source_kind AS ENUM ('gmail_thread', 'gmail_message', 'drive_item', 'calendar_event');
CREATE TYPE suggestion_kind AS ENUM ('commitment', 'decision', 'action', 'project_match', 'person_match');
CREATE TYPE suggestion_review_state AS ENUM ('pending', 'accepted', 'rejected', 'superseded');

CREATE TABLE google_connections (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  owner_user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  google_email CITEXT NOT NULL,
  scopes TEXT[] NOT NULL DEFAULT '{}',
  status google_connection_status NOT NULL DEFAULT 'connected',
  -- Only an opaque reference to the secret store. Tokens never enter Postgres.
  credential_reference TEXT NOT NULL,
  gmail_history_id TEXT NOT NULL DEFAULT '',
  drive_page_token TEXT NOT NULL DEFAULT '',
  calendar_sync_token TEXT NOT NULL DEFAULT '',
  last_synced_at TIMESTAMPTZ,
  last_error TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  disconnected_at TIMESTAMPTZ,
  CONSTRAINT google_connections_organization_id_id_unique UNIQUE (organization_id, id),
  CONSTRAINT google_connections_owner_email_unique UNIQUE (organization_id, owner_user_id, google_email),
  CONSTRAINT google_connections_credential_reference_check CHECK (credential_reference <> ''),
  CONSTRAINT google_connections_owner_membership_fk
    FOREIGN KEY (organization_id, owner_user_id)
    REFERENCES organization_memberships (organization_id, user_id) ON DELETE RESTRICT
);

CREATE INDEX google_connections_owner_idx
  ON google_connections (organization_id, owner_user_id) WHERE disconnected_at IS NULL;

CREATE TABLE gmail_threads (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  connection_id UUID NOT NULL,
  owner_user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  provider_thread_id TEXT NOT NULL,
  subject TEXT NOT NULL DEFAULT '',
  snippet TEXT NOT NULL DEFAULT '',
  participant_emails TEXT[] NOT NULL DEFAULT '{}',
  label_ids TEXT[] NOT NULL DEFAULT '{}',
  message_count INTEGER NOT NULL DEFAULT 0,
  last_message_at TIMESTAMPTZ,
  indexed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT gmail_threads_organization_id_id_unique UNIQUE (organization_id, id),
  CONSTRAINT gmail_threads_provider_unique UNIQUE (organization_id, connection_id, provider_thread_id),
  CONSTRAINT gmail_threads_connection_fk FOREIGN KEY (organization_id, connection_id)
    REFERENCES google_connections (organization_id, id) ON DELETE RESTRICT
);

CREATE INDEX gmail_threads_owner_recent_idx
  ON gmail_threads (organization_id, owner_user_id, last_message_at DESC);

CREATE TABLE gmail_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  thread_id UUID NOT NULL,
  owner_user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  provider_message_id TEXT NOT NULL,
  from_email CITEXT NOT NULL DEFAULT '',
  to_emails TEXT[] NOT NULL DEFAULT '{}',
  cc_emails TEXT[] NOT NULL DEFAULT '{}',
  subject TEXT NOT NULL DEFAULT '',
  body_text TEXT NOT NULL DEFAULT '',
  sent_at TIMESTAMPTZ,
  attachments JSONB NOT NULL DEFAULT '[]'::jsonb,
  CONSTRAINT gmail_messages_organization_id_id_unique UNIQUE (organization_id, id),
  CONSTRAINT gmail_messages_provider_unique UNIQUE (organization_id, thread_id, provider_message_id),
  CONSTRAINT gmail_messages_thread_fk FOREIGN KEY (organization_id, thread_id)
    REFERENCES gmail_threads (organization_id, id) ON DELETE RESTRICT
);

CREATE INDEX gmail_messages_owner_idx ON gmail_messages (organization_id, owner_user_id);

CREATE TABLE drive_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  connection_id UUID NOT NULL,
  owner_user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  provider_file_id TEXT NOT NULL,
  name TEXT NOT NULL DEFAULT '',
  mime_type TEXT NOT NULL DEFAULT '',
  web_view_link TEXT NOT NULL DEFAULT '',
  modified_at TIMESTAMPTZ,
  -- Reflects the source permissions so a later change can revoke Atlas visibility.
  permissions JSONB NOT NULL DEFAULT '[]'::jsonb,
  indexed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT drive_items_organization_id_id_unique UNIQUE (organization_id, id),
  CONSTRAINT drive_items_provider_unique UNIQUE (organization_id, connection_id, provider_file_id),
  CONSTRAINT drive_items_connection_fk FOREIGN KEY (organization_id, connection_id)
    REFERENCES google_connections (organization_id, id) ON DELETE RESTRICT
);

CREATE INDEX drive_items_owner_idx ON drive_items (organization_id, owner_user_id);

CREATE TABLE calendar_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  connection_id UUID NOT NULL,
  owner_user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  provider_event_id TEXT NOT NULL,
  calendar_id TEXT NOT NULL DEFAULT '',
  summary TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  location TEXT NOT NULL DEFAULT '',
  starts_at TIMESTAMPTZ,
  ends_at TIMESTAMPTZ,
  -- Retained verbatim so a Hawaiʻi event renders in its own zone, not the viewer's.
  time_zone TEXT NOT NULL DEFAULT 'UTC',
  attendees JSONB NOT NULL DEFAULT '[]'::jsonb,
  -- Set when Atlas created the event, so synchronization never loops.
  atlas_origin BOOLEAN NOT NULL DEFAULT false,
  milestone_id UUID,
  indexed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT calendar_events_organization_id_id_unique UNIQUE (organization_id, id),
  CONSTRAINT calendar_events_provider_unique UNIQUE (organization_id, connection_id, provider_event_id),
  CONSTRAINT calendar_events_connection_fk FOREIGN KEY (organization_id, connection_id)
    REFERENCES google_connections (organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT calendar_events_milestone_fk FOREIGN KEY (organization_id, milestone_id)
    REFERENCES milestones (organization_id, id) ON DELETE RESTRICT
);

CREATE INDEX calendar_events_owner_window_idx
  ON calendar_events (organization_id, owner_user_id, starts_at);

-- The only bridge from private Workspace content into a project. Creating one is
-- an explicit act by the owner and exposes exactly the referenced item.
CREATE TABLE workspace_shares (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  project_id UUID NOT NULL,
  source_kind google_source_kind NOT NULL,
  source_id UUID NOT NULL,
  owner_user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  title TEXT NOT NULL DEFAULT '',
  summary TEXT NOT NULL DEFAULT '',
  occurred_at TIMESTAMPTZ,
  snapshot_artifact_id UUID,
  shared_by_actor_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at TIMESTAMPTZ,
  CONSTRAINT workspace_shares_organization_id_id_unique UNIQUE (organization_id, id),
  CONSTRAINT workspace_shares_unique UNIQUE (organization_id, project_id, source_kind, source_id),
  CONSTRAINT workspace_shares_project_fk FOREIGN KEY (organization_id, project_id)
    REFERENCES project_rooms (organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT workspace_shares_actor_fk FOREIGN KEY (organization_id, shared_by_actor_id)
    REFERENCES actors (organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT workspace_shares_snapshot_fk FOREIGN KEY (organization_id, snapshot_artifact_id)
    REFERENCES artifacts (organization_id, id) ON DELETE RESTRICT
);

CREATE INDEX workspace_shares_project_idx
  ON workspace_shares (organization_id, project_id) WHERE revoked_at IS NULL;

-- Extraction output. Suggestions never mutate authoritative project facts; they
-- wait for review and always carry their confidence and extractor version.
CREATE TABLE workspace_suggestions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  owner_user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  source_kind google_source_kind NOT NULL,
  source_id UUID NOT NULL,
  kind suggestion_kind NOT NULL,
  summary TEXT NOT NULL,
  confidence NUMERIC(4, 3) NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
  extractor_version TEXT NOT NULL,
  suggested_project_id UUID,
  review_state suggestion_review_state NOT NULL DEFAULT 'pending',
  reviewed_by_actor_id UUID,
  reviewed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT workspace_suggestions_organization_id_id_unique UNIQUE (organization_id, id),
  CONSTRAINT workspace_suggestions_source_unique
    UNIQUE (organization_id, source_kind, source_id, kind, summary),
  CONSTRAINT workspace_suggestions_project_fk FOREIGN KEY (organization_id, suggested_project_id)
    REFERENCES project_rooms (organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT workspace_suggestions_reviewer_fk FOREIGN KEY (organization_id, reviewed_by_actor_id)
    REFERENCES actors (organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT workspace_suggestions_review_check CHECK (
    (review_state = 'pending' AND reviewed_by_actor_id IS NULL AND reviewed_at IS NULL)
    OR (review_state <> 'pending' AND reviewed_by_actor_id IS NOT NULL AND reviewed_at IS NOT NULL)
  )
);

CREATE INDEX workspace_suggestions_owner_pending_idx
  ON workspace_suggestions (organization_id, owner_user_id, created_at DESC)
  WHERE review_state = 'pending';

DO $permissions$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'atlas_web')
     AND EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'atlas_worker') THEN
    GRANT SELECT, INSERT ON
      google_connections, gmail_threads, gmail_messages, drive_items,
      calendar_events, workspace_shares, workspace_suggestions
    TO atlas_web;
    GRANT UPDATE (
      scopes, status, credential_reference, gmail_history_id, drive_page_token,
      calendar_sync_token, last_synced_at, last_error, updated_at, disconnected_at
    ) ON google_connections TO atlas_web;
    GRANT UPDATE (
      subject, snippet, participant_emails, label_ids, message_count,
      last_message_at, indexed_at
    ) ON gmail_threads TO atlas_web;
    GRANT UPDATE (
      from_email, to_emails, cc_emails, subject, body_text, sent_at, attachments
    ) ON gmail_messages TO atlas_web;
    GRANT UPDATE (name, mime_type, web_view_link, modified_at, permissions, indexed_at)
      ON drive_items TO atlas_web;
    GRANT UPDATE (
      calendar_id, summary, description, location, starts_at, ends_at, time_zone,
      attendees, milestone_id, indexed_at
    ) ON calendar_events TO atlas_web;
    GRANT UPDATE (revoked_at) ON workspace_shares TO atlas_web;
    GRANT UPDATE (review_state, reviewed_by_actor_id, reviewed_at, suggested_project_id)
      ON workspace_suggestions TO atlas_web;
    GRANT DELETE ON workspace_shares TO atlas_web;

    REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM atlas_worker;
    GRANT SELECT ON outbox_events TO atlas_worker;
    GRANT UPDATE (
      attempt_count, available_at, processing_started_at, processing_token,
      published_at, terminal_at, last_error, updated_at
    ) ON outbox_events TO atlas_worker;
  END IF;
END
$permissions$;
