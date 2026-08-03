DO $permissions$
DECLARE
  database_name text := current_database();
BEGIN
  EXECUTE format('REVOKE ALL PRIVILEGES ON DATABASE %I FROM PUBLIC', database_name);
  REVOKE ALL PRIVILEGES ON SCHEMA public FROM PUBLIC;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'atlas_web')
     AND EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'atlas_worker') THEN
    EXECUTE format('REVOKE ALL PRIVILEGES ON DATABASE %I FROM atlas_web, atlas_worker', database_name);
    EXECUTE format('GRANT CONNECT ON DATABASE %I TO atlas_web, atlas_worker', database_name);

    REVOKE ALL PRIVILEGES ON SCHEMA public FROM atlas_web, atlas_worker;
    GRANT USAGE ON SCHEMA public TO atlas_web, atlas_worker;

    REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM atlas_web;
    GRANT SELECT ON
      organizations, users, actors, organization_memberships, api_idempotency_keys,
      project_rooms, project_memberships, project_health_updates, workstreams,
      work_items, work_item_dependencies, labels, work_item_labels, decisions,
      decision_projects, risks, blockers, milestones, activities, people,
      counterparty_organizations, person_organization_affiliations, project_people,
      project_counterparties, saved_views
    TO atlas_web;
    GRANT INSERT ON
      users, actors, organization_memberships, audit_events, outbox_events,
      api_idempotency_keys, project_rooms, project_memberships,
      project_health_updates, workstreams, work_items, work_item_dependencies,
      labels, work_item_labels, decisions, decision_projects, risks, blockers,
      milestones, activities, people, counterparty_organizations,
      person_organization_affiliations, project_people, project_counterparties,
      saved_views
    TO atlas_web;
    GRANT UPDATE (name, updated_at) ON organizations TO atlas_web;
    GRANT UPDATE (email, display_name, google_subject, updated_at) ON users TO atlas_web;
    GRANT UPDATE (display_name, updated_at, disabled_at) ON actors TO atlas_web;
    GRANT UPDATE (response_body, completed_at) ON api_idempotency_keys TO atlas_web;
    GRANT UPDATE (
      name, objective, template_type, status, health, priority, strategic_area,
      owner_user_id, current_focus, blocker_summary, next_decision, next_action,
      updated_by_actor_id, updated_at, archived_at, archived_by_actor_id
    ) ON project_rooms TO atlas_web;
    GRANT UPDATE (role, updated_at) ON project_memberships TO atlas_web;
    GRANT UPDATE (
      name, description, owner_user_id, status, position, updated_by_actor_id,
      updated_at, archived_at, archived_by_actor_id
    ) ON workstreams TO atlas_web;
    GRANT UPDATE (
      workstream_id, parent_id, type, title, description, owner_user_id, status,
      priority, due_at, position, completed_at, completed_by_actor_id,
      updated_by_actor_id, updated_at, archived_at, archived_by_actor_id
    ) ON work_items TO atlas_web;
    GRANT UPDATE (
      question, state, outcome, rationale, owner_user_id, decision_at,
      updated_by_actor_id, updated_at, archived_at, merged_into_id
    ) ON decisions TO atlas_web;
    GRANT UPDATE (
      workstream_id, title, description, likelihood, impact, owner_user_id,
      mitigation, state, updated_by_actor_id, updated_at, archived_at
    ) ON risks TO atlas_web;
    GRANT UPDATE (
      condition, target_type, target_id, owner_user_id, resolved_at,
      updated_by_actor_id, updated_at, archived_at
    ) ON blockers TO atlas_web;
    GRANT UPDATE (
      workstream_id, outcome, owner_user_id, target_at, state, completed_at,
      calendar_event_id, updated_by_actor_id, updated_at, archived_at
    ) ON milestones TO atlas_web;
    GRANT UPDATE (
      display_name, given_name, family_name, email, phone, title, notes,
      provenance, updated_by_actor_id, updated_at, archived_at, merged_into_id,
      merged_at
    ) ON people TO atlas_web;
    GRANT UPDATE (
      name, kind, website, notes, provenance, updated_by_actor_id, updated_at,
      archived_at, merged_into_id, merged_at
    ) ON counterparty_organizations TO atlas_web;
    GRANT UPDATE (person_id, counterparty_id, archived_at)
      ON person_organization_affiliations TO atlas_web;
    GRANT UPDATE (
      person_id, role, influence, sentiment, relevance, notes, visibility,
      updated_by_actor_id, updated_at, archived_at
    ) ON project_people TO atlas_web;
    GRANT UPDATE (
      counterparty_id, role, influence, sentiment, relevance, notes, visibility,
      updated_by_actor_id, updated_at, archived_at
    ) ON project_counterparties TO atlas_web;
    GRANT UPDATE (
      name, surface, filters, is_default, updated_by_actor_id, updated_at, archived_at
    ) ON saved_views TO atlas_web;
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
