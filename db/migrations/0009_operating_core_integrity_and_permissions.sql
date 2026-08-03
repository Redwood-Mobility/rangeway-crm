-- Atlas Operating Core: project-bound relational integrity.
--
-- Migration 0007 scopes work-item, workstream, risk and milestone relationships
-- to the organization but not to the project. That permits a work item in one
-- project to reference a workstream, parent or dependency belonging to another
-- project, which would corrupt every board, list, calendar and Project Room
-- projection built from those links. This migration is additive: migrations
-- 0001 through 0008 are unchanged.

-- Project-inclusive unique keys give the composite foreign keys below a target.
ALTER TABLE workstreams
  ADD CONSTRAINT workstreams_organization_id_id_project_id_unique
  UNIQUE (organization_id, id, project_id);

ALTER TABLE work_items
  ADD CONSTRAINT work_items_organization_id_id_project_id_unique
  UNIQUE (organization_id, id, project_id);

-- A dependency edge belongs to exactly one project, so it must carry that
-- project and constrain both endpoints to it.
ALTER TABLE work_item_dependencies
  ADD COLUMN project_id UUID;

UPDATE work_item_dependencies dependency
   SET project_id = blocked.project_id
  FROM work_items blocked
 WHERE blocked.organization_id = dependency.organization_id
   AND blocked.id = dependency.blocked_work_item_id
   AND dependency.project_id IS NULL;

ALTER TABLE work_item_dependencies
  ALTER COLUMN project_id SET NOT NULL;

ALTER TABLE work_item_dependencies
  ADD CONSTRAINT work_item_dependencies_project_fk
  FOREIGN KEY (organization_id, project_id)
  REFERENCES project_rooms (organization_id, id) ON DELETE RESTRICT;

CREATE INDEX work_item_dependencies_organization_id_project_id_idx
  ON work_item_dependencies (organization_id, project_id);

-- Every relationship below now requires both sides to share one project.
ALTER TABLE work_items
  ADD CONSTRAINT work_items_workstream_project_fk
  FOREIGN KEY (organization_id, workstream_id, project_id)
  REFERENCES workstreams (organization_id, id, project_id) ON DELETE RESTRICT;

ALTER TABLE work_items
  ADD CONSTRAINT work_items_parent_project_fk
  FOREIGN KEY (organization_id, parent_id, project_id)
  REFERENCES work_items (organization_id, id, project_id) ON DELETE RESTRICT;

ALTER TABLE work_item_dependencies
  ADD CONSTRAINT work_item_dependencies_blocked_project_fk
  FOREIGN KEY (organization_id, blocked_work_item_id, project_id)
  REFERENCES work_items (organization_id, id, project_id) ON DELETE RESTRICT;

ALTER TABLE work_item_dependencies
  ADD CONSTRAINT work_item_dependencies_dependency_project_fk
  FOREIGN KEY (organization_id, dependency_work_item_id, project_id)
  REFERENCES work_items (organization_id, id, project_id) ON DELETE RESTRICT;

ALTER TABLE risks
  ADD CONSTRAINT risks_workstream_project_fk
  FOREIGN KEY (organization_id, workstream_id, project_id)
  REFERENCES workstreams (organization_id, id, project_id) ON DELETE RESTRICT;

ALTER TABLE milestones
  ADD CONSTRAINT milestones_workstream_project_fk
  FOREIGN KEY (organization_id, workstream_id, project_id)
  REFERENCES workstreams (organization_id, id, project_id) ON DELETE RESTRICT;

-- Re-assert the exact runtime privileges. `work_item_dependencies` gained a
-- column, so its write grants are restated here rather than left to inference.
DO $permissions$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'atlas_web')
     AND EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'atlas_worker') THEN
    GRANT SELECT, INSERT ON work_item_dependencies TO atlas_web;
    GRANT DELETE ON
      project_memberships, work_item_dependencies, work_item_labels,
      decision_projects
    TO atlas_web;

    REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM atlas_worker;
    GRANT SELECT ON outbox_events TO atlas_worker;
    GRANT UPDATE (
      attempt_count, available_at, processing_started_at, processing_token,
      published_at, terminal_at, last_error, updated_at
    ) ON outbox_events TO atlas_worker;
  END IF;
END
$permissions$;
