-- Atlas agent platform: scopes, delegations, guarded execution and approvals.
-- Additive. Migrations 0001 through 0011 are unchanged.
--
-- Service actors already exist in `actors`. This migration adds what turns a
-- credential into bounded authority: the scopes a credential carries, the task
-- delegation that authorizes a particular run, and the approval gate for
-- anything outside that authority.

CREATE TYPE agent_scope AS ENUM (
  'read',
  'work.write',
  'project.write',
  'evidence.write',
  'report.prepare',
  'report.deliver',
  'admin'
);

CREATE TYPE approval_state AS ENUM ('pending', 'approved', 'rejected', 'expired');
CREATE TYPE invocation_outcome AS ENUM ('succeeded', 'rejected', 'failed', 'awaiting_approval');

-- A credential is rotatable without changing the actor it belongs to, so
-- attribution survives rotation.
CREATE TABLE agent_credentials (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  actor_id UUID NOT NULL,
  service_key_prefix TEXT NOT NULL UNIQUE,
  service_key_hash TEXT NOT NULL,
  scopes agent_scope[] NOT NULL DEFAULT '{}',
  -- External delivery is never implied by a scope; it is a separate grant.
  external_delivery_authorized BOOLEAN NOT NULL DEFAULT false,
  created_by_actor_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ,
  rotated_at TIMESTAMPTZ,
  disabled_at TIMESTAMPTZ,
  CONSTRAINT agent_credentials_organization_id_id_unique UNIQUE (organization_id, id),
  CONSTRAINT agent_credentials_actor_fk FOREIGN KEY (organization_id, actor_id)
    REFERENCES actors (organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT agent_credentials_creator_fk FOREIGN KEY (organization_id, created_by_actor_id)
    REFERENCES actors (organization_id, id) ON DELETE RESTRICT
);

CREATE INDEX agent_credentials_actor_idx
  ON agent_credentials (organization_id, actor_id) WHERE disabled_at IS NULL;

-- A delegation is the task authority for one run: who asked, what for, and
-- which operations that task may use.
CREATE TABLE agent_delegations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  actor_id UUID NOT NULL,
  delegated_by_actor_id UUID NOT NULL,
  task_source TEXT NOT NULL CHECK (char_length(task_source) BETWEEN 1 AND 500),
  purpose TEXT NOT NULL DEFAULT '',
  permitted_scopes agent_scope[] NOT NULL DEFAULT '{}',
  project_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  CONSTRAINT agent_delegations_organization_id_id_unique UNIQUE (organization_id, id),
  CONSTRAINT agent_delegations_actor_fk FOREIGN KEY (organization_id, actor_id)
    REFERENCES actors (organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT agent_delegations_delegator_fk FOREIGN KEY (organization_id, delegated_by_actor_id)
    REFERENCES actors (organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT agent_delegations_project_fk FOREIGN KEY (organization_id, project_id)
    REFERENCES project_rooms (organization_id, id) ON DELETE RESTRICT
);

CREATE INDEX agent_delegations_active_idx
  ON agent_delegations (organization_id, actor_id, expires_at DESC) WHERE revoked_at IS NULL;

CREATE TABLE approval_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  requested_by_actor_id UUID NOT NULL,
  delegation_id UUID,
  operation TEXT NOT NULL,
  reason TEXT NOT NULL,
  request_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  state approval_state NOT NULL DEFAULT 'pending',
  decided_by_actor_id UUID,
  decided_at TIMESTAMPTZ,
  decision_rationale TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT approval_requests_organization_id_id_unique UNIQUE (organization_id, id),
  CONSTRAINT approval_requests_requester_fk FOREIGN KEY (organization_id, requested_by_actor_id)
    REFERENCES actors (organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT approval_requests_decider_fk FOREIGN KEY (organization_id, decided_by_actor_id)
    REFERENCES actors (organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT approval_requests_delegation_fk FOREIGN KEY (organization_id, delegation_id)
    REFERENCES agent_delegations (organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT approval_requests_decision_check CHECK (
    (state = 'pending' AND decided_by_actor_id IS NULL AND decided_at IS NULL)
    OR (state <> 'pending' AND decided_by_actor_id IS NOT NULL AND decided_at IS NOT NULL)
  )
);

CREATE INDEX approval_requests_pending_idx
  ON approval_requests (organization_id, created_at DESC) WHERE state = 'pending';

-- Append-only record of what an agent attempted, whether it was allowed, and
-- under whose delegation.
CREATE TABLE agent_invocations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  actor_id UUID NOT NULL,
  delegation_id UUID,
  request_id UUID NOT NULL,
  operation TEXT NOT NULL,
  outcome invocation_outcome NOT NULL,
  detail TEXT NOT NULL DEFAULT '',
  approval_request_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT agent_invocations_organization_id_id_unique UNIQUE (organization_id, id),
  CONSTRAINT agent_invocations_actor_fk FOREIGN KEY (organization_id, actor_id)
    REFERENCES actors (organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT agent_invocations_delegation_fk FOREIGN KEY (organization_id, delegation_id)
    REFERENCES agent_delegations (organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT agent_invocations_approval_fk FOREIGN KEY (organization_id, approval_request_id)
    REFERENCES approval_requests (organization_id, id) ON DELETE RESTRICT
);

CREATE INDEX agent_invocations_actor_idx
  ON agent_invocations (organization_id, actor_id, created_at DESC);

DO $permissions$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'atlas_web')
     AND EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'atlas_worker') THEN
    GRANT SELECT, INSERT ON
      agent_credentials, agent_delegations, approval_requests, agent_invocations
    TO atlas_web;
    GRANT UPDATE (scopes, external_delivery_authorized, service_key_prefix,
                  service_key_hash, expires_at, rotated_at, disabled_at)
      ON agent_credentials TO atlas_web;
    GRANT UPDATE (revoked_at) ON agent_delegations TO atlas_web;
    GRANT UPDATE (state, decided_by_actor_id, decided_at, decision_rationale)
      ON approval_requests TO atlas_web;
    -- Invocations are evidence; they are never rewritten.
    REVOKE UPDATE, DELETE ON agent_invocations FROM atlas_web;

    REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM atlas_worker;
    GRANT SELECT ON outbox_events TO atlas_worker;
    GRANT UPDATE (
      attempt_count, available_at, processing_started_at, processing_token,
      published_at, terminal_at, last_error, updated_at
    ) ON outbox_events TO atlas_worker;
  END IF;
END
$permissions$;
