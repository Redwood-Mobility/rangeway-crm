# Atlas V2 Product and Architecture Design

**Status:** Approved for implementation planning
**Date:** 2026-08-02
**Product:** Atlas, Rangeway's internal operating office
**Initial user:** Zak-first, team-capable

## 1. Product Constitution

Atlas is Rangeway's internal operating office. It organizes projects, work, relationships, decisions, evidence, communications, and agent activity in one system.

Atlas is not a generic CRM, a document editor, a Notion clone, or an immediate Linear replacement. It should organically replace disconnected work trackers over time by becoming the fastest and most context-rich place to understand and advance Rangeway work.

The first usable release combines:

1. A shared operating core for all Rangeway projects.
2. A deep Location Pursuit project template.
3. An API-first, agent-native architecture.
4. Full Google Workspace integration.

### Operating principles

- Every active project has an owner, current health, current focus, blocker, next decision, and next action.
- Work is captured once and appears through board, list, calendar, Today, and portfolio views.
- Important claims and development gates can point to evidence.
- Meetings and communications should resolve into context, decisions, risks, milestones, or actions.
- Humans, agents, and automations use the same domain model and API.
- Agent actions are attributable and auditable.
- Private communications remain private unless explicitly shared into a project.
- Atlas should reduce manual reporting by producing useful briefings from operating data.

## 2. Scope and Success Criteria

### First-release scope

- Today briefing and personal work surface
- Project directory and project rooms
- Workstreams and universal work items
- Kanban and list views
- People, organizations, and project relationships
- Decisions, risks, blockers, milestones, and project health
- Hybrid artifacts and evidence
- Location Pursuit template with development gates
- Full Gmail, Drive, and Calendar indexing
- Versioned API, MCP tools, event outbox, and audit history
- Branded, audience-aware PDF reports with provenance and native archival
- Zak-first experience with team-ready ownership and permissions

### Acceptance projects

The Location Pursuit template must work naturally for:

- Mojave
- Hawaiʻi
- St. Louis — The Landing

Current facts about these projects must be reopened from maintained sources before import. Historical notes or prior application state are routing context, not verified project truth.

### First-release success

The release is successful when Zak can:

1. Open Atlas and understand what needs attention without assembling a report.
2. Create or open a project room and see its objective, health, workstreams, people, evidence, decisions, and next actions.
3. Manage work through Kanban and list views without duplicating records.
4. Understand a Location Pursuit's readiness across independent development areas.
5. Search authorized Gmail, Drive, Calendar, projects, people, work, and evidence from one interface.
6. Assign Codex or Hermes an authorized task through API or MCP and see the resulting attributed activity.
7. Generate a polished stakeholder PDF whose claims, evidence, and visibility are appropriate for its selected audience role.
8. Add teammates later without redesigning ownership, membership, or privacy boundaries.

## 3. Non-Goals

The first release will not include:

- Full Linear feature parity, cycles, or Linear migration
- A native rich-text document editor competing with Google Docs
- Multi-tenant SaaS administration
- Microservices or independently deployed domain services
- Arbitrary custom database objects or a generic no-code builder
- Unrestricted agent administration
- Automated external communication without explicit task authority
- Native mobile applications

## 4. Architecture

Atlas V2 is a single-tenant modular monolith with organization boundaries in the schema.

### Runtime components

- **Web/API:** Authenticated human interface and versioned JSON API.
- **Worker:** Google synchronization, indexing, scheduled briefings, webhook processing, and automation jobs.
- **Report renderer:** Deterministic HTML-to-PDF rendering executed by the worker from versioned report snapshots.
- **PostgreSQL:** Relational records, permissions, communications index, audit history, and full-text search.
- **Artifact storage:** Protected native uploads and timestamped evidence snapshots with independent backups.
- **MCP server:** Agent-oriented tools implemented over the versioned API.
- **Event outbox:** Transactional events consumed by the worker without adding distributed infrastructure.

All user interfaces, workers, MCP tools, and integrations call domain services through stable interfaces. They do not query or mutate persistence tables directly.

### Domain modules

- Identity and permissions
- Project rooms and templates
- Work items and Kanban
- People, organizations, and relationships
- Decisions, risks, milestones, and health
- Artifacts and evidence
- Gmail, Drive, and Calendar intelligence
- Search and briefings
- Reports and external publishing
- Automation, MCP, and audit history

### Deployment

Atlas remains one repository and one VPS deployment containing:

- Caddy
- Web/API container
- Worker container
- PostgreSQL container
- Persistent artifact storage
- Encrypted off-server backups

## 5. Identity, Membership, and Privacy

### Human identity

- Google Workspace is the primary sign-in method.
- Users belong to the Rangeway organization.
- The schema supports project membership, ownership, and role-based permissions from the first migration.
- The initial interface is optimized for Zak while remaining correct for future teammates.

### Agent identity

- Codex, Hermes, and automations receive distinct service identities.
- Agent credentials use explicit scopes and cannot impersonate an unrecorded human.
- Every agent mutation records the agent, delegating user or automation, task source, timestamp, and changed records.

### Private-by-default communications

- Each connected mailbox remains private to its owner and authorized agents acting on that owner's behalf.
- Other team members and organization administrators cannot search private mailbox content by default.
- Sharing an email into a project creates a project-visible record or snapshot without exposing the rest of the mailbox.
- Private calendar events and Drive items follow the same visibility rule.
- Permission checks apply before search ranking, briefing generation, API serialization, and MCP responses.

## 6. Core Domain Model

### Organization

The top-level Rangeway boundary. All durable records carry an organization identifier even though V2 launches as a single-tenant product.

### Project Room

Every Rangeway project is a Project Room with:

- Name and objective
- Template type
- Owner and members
- Status, health, priority, and strategic area
- Current focus, blocker, next decision, and next action
- Workstreams, milestones, activity, and briefing history
- Linked people, organizations, artifacts, evidence, and communications

### Workstream

A stable division of work within a project. Workstreams contain work items, milestones, risks, and optional template-specific requirements.

### Work Item

One universal record supports these types:

- Action
- Deliverable
- Follow-up
- Approval
- Research item

Fields include identifier, title, description, owner, status, priority, due date, parent, dependencies, labels, project, workstream, and completion metadata.

Default statuses are:

- Inbox
- Next
- In Progress
- Waiting
- Done
- Canceled

Kanban, list, calendar, Today, and portfolio views present these same work items.

### Person and Organization

People and organizations are separate records. People may belong to organizations, and either may participate in multiple projects. Project relationships carry role, influence, sentiment, relevance, and notes.

### Decision

A durable record containing the question, outcome, rationale, owner, date, affected projects, and supporting evidence. Proposals and final decisions remain distinguishable.

### Risk and Blocker

A risk records likelihood, impact, owner, mitigation, and state. A blocker records the concrete condition preventing progress and may block a project, workstream, requirement, or work item.

### Milestone

A dated outcome associated with a project or workstream. Calendar synchronization must preserve Atlas ownership and source attribution.

### Activity and Audit Event

Activity is the human-readable project history. Audit events are immutable machine-readable records of material changes. Soft deletion and reversal events preserve recoverability.

## 7. Location Pursuit Template

The Location Pursuit template extends a Project Room without replacing the universal work model.

### Profile

- Site and geographic context
- Corridor context
- Rangeway format hypothesis
- Development phase
- Target dates
- Strategic thesis
- Project economics summary

### Development areas

- Site and land control
- Utility and power
- Permitting and entitlement
- Commercial structure
- Hospitality program
- Capital and economics
- Design and construction
- Partner alignment

Each development area contains gates and requirements. Requirement states are:

- Unknown
- Investigating
- In Progress
- Evidenced
- Blocked
- Waived
- Not Applicable

Phase changes are derived from or explicitly reconciled with gate state. A board drag may initiate a phase change, but cannot silently bypass unmet requirements.

### Evidence

Evidence is a relationship between a requirement or claim and one or more supporting sources. Sources may include artifacts, emails, calendar events, notes, decisions, or structured external references.

## 8. Artifacts and Evidence

Every Atlas Artifact uses one of three source modes:

1. **Native:** Uploaded and stored by Atlas.
2. **Linked:** Google Drive remains canonical while Atlas stores metadata and context.
3. **Evidence snapshot:** A timestamped native copy preserves what supported a decision, claim, or gate at that moment.

Artifacts record source ownership, visibility, canonical URL, storage key when applicable, mime type, checksum, version, timestamps, and project relationships.

Native and linked artifacts appear consistently in project rooms, search, evidence views, API responses, and agent tools.

Generated reports are stored as native artifacts. Each report artifact records its template version, audience-role profile, generating actor, creation timestamp, included source records, source-data cutoff, visibility policy, and cryptographic checksum.

## 9. Reports and External Publishing

Atlas generates polished Rangeway-branded PDF reports from structured project data and approved narrative content. PDF generation is a governed publishing workflow, not a browser-print shortcut.

### Initial report templates

- Project development update
- Location Pursuit snapshot
- Partner or counterparty briefing
- Investor portfolio update
- Diligence and evidence summary
- Milestone or decision memo
- Weekly or monthly operating report

### Audience-role profiles

Report templates define document structure. Separate audience-role profiles define eligible content, disclosure rules, terminology, and emphasis. Initial profiles are:

- Internal executive
- Development partner
- Capital or investor
- Landowner or host partner
- Utility or infrastructure partner
- Public agency or permitting authority
- Community or public audience

Profiles are reusable and never named for a specific person. A recipient's name may appear in delivery metadata or an optional cover field, but it does not determine the template or disclosure policy.

### Generation workflow

1. The user or authorized agent selects the project or portfolio, audience-role profile, report template, and source-data cutoff.
2. Atlas creates an immutable report snapshot containing eligible facts, milestones, decisions, risks, evidence, and approved economics.
3. Audience and visibility rules exclude private communications, internal notes, sensitive fields, and unsupported claims unless explicitly included by an authorized user.
4. Atlas generates a reviewable narrative and structured preview from the snapshot.
5. The renderer produces a deterministic, branded PDF from the approved preview.
6. Atlas stores the PDF and its snapshot as native artifacts linked to the relevant projects, people, and organizations.
7. Delivery is logged with recipient, channel, sender, timestamp, and exact artifact version.

### Guarded delivery

Codex, Hermes, and automations may generate and revise report drafts as routine internal work. They may send or publish a report when the assigned task explicitly authorizes external delivery. Without that authority, Atlas produces a ready-to-send draft.

Report generation must never grant access to otherwise private source material. Rendering and delivery re-check authorization against the immutable snapshot, and any inclusion override is recorded in the audit history.

## 10. Google Workspace Integration

### Gmail

Atlas maintains a complete synchronized index for each authorized mailbox:

- Messages and threads
- Participants
- Full content
- Labels and timestamps
- Attachment metadata
- Project and relationship matches
- Extracted commitments, decisions, and action candidates

Gmail remains canonical. Synchronization uses incremental history tokens and handles invalidated tokens through bounded resynchronization.

### Drive

Atlas indexes authorized Drive content and supports project linking, metadata search, canonical links, and evidence snapshots. Drive permissions continue to control access unless an authorized snapshot is explicitly shared into Atlas.

### Calendar

Atlas indexes authorized events and supports linking meetings to projects, people, work items, and milestones. Private event visibility remains private by default.

### Matching and extraction

Automated project, person, action, decision, and commitment suggestions are stored with confidence and provenance. Low-confidence suggestions do not silently become authoritative project facts.

## 11. Agent and Automation Model

### API-first contract

- The Atlas interface uses the same versioned API offered to authorized clients.
- An OpenAPI document defines request, response, error, pagination, filtering, and idempotency behavior.
- Service tokens are scoped, rotatable, and attributable.
- Agents never receive direct database access.

### MCP capabilities

Initial MCP tools include:

- Search Atlas
- Retrieve Today briefing
- Retrieve a complete project context bundle
- List blocked or overdue work
- Create and update work items
- Move work items
- Add activity
- Add or propose decisions
- Link artifacts and evidence
- Update project health
- Prepare project and portfolio reports
- Generate, revise, render, and retrieve audience-aware report artifacts

### Guarded execution

Agents may autonomously perform routine internal Atlas work. An explicit instruction authorizing an external action permits that action without a redundant confirmation.

Approval remains required for:

- Unrequested external communication
- Permission or credential changes
- Permanent deletion or unrecoverable operations
- Unusually large bulk mutations outside the assigned task's clear scope

Project-state changes and decisions may execute when clearly included in the assigned task. Soft deletion, version history, idempotency keys, and audit events reduce confirmation prompts while preserving control.

### Events and automations

The transactional event outbox emits events such as:

- Work assigned, blocked, overdue, or completed
- Evidence added
- Decision requested or recorded
- Project health changed
- Milestone changed
- Workspace content shared
- Google synchronization completed or failed

The worker consumes these events for scheduled briefings, notifications, extraction, and Hermes workflows.

## 12. User Experience

### Today

Today is Zak's default surface and combines:

- Personal next actions
- Waiting and overdue work
- Decisions needed
- Project-health changes
- Recent evidence and communications
- Agent activity
- Upcoming meetings and milestones
- Quick capture

### Projects

The project directory supports search, filters, saved views, health, owner, template, strategic area, and recent activity.

### Project Room

Every room presents:

- Objective, health, owner, current focus, blocker, next decision, and next action
- Workstreams and work board
- Milestones and calendar
- People and organizations
- Decisions, risks, artifacts, evidence, and activity
- Template-specific panels

### Work views

- Kanban is a view of universal work items, not a separate task system.
- Default lanes are Inbox, Next, In Progress, Waiting, and Done.
- List and calendar views use the same records.
- Office-wide views support owner, project, workstream, priority, label, due date, and blocker filters.

### Global navigation

- Today
- Projects
- Portfolio
- People
- Files
- Calendar
- Search and command palette

Global pages are indexes across project-owned context. Project Rooms remain the primary place where work is understood and advanced.

### Reports

Project Rooms and Portfolio provide a report builder with report template, audience-role profile, cutoff date, included sections, and visibility controls. The preview identifies omitted private material, unsupported claims, and sources requiring review. Published reports remain accessible through Files and the relevant project activity history.

## 13. Data Flow and Consistency

- API commands validate permissions and business rules in domain services.
- Database changes and outbox events commit in one transaction.
- Workers process events idempotently and record retry state.
- Google synchronization records source identifiers, history cursors, and last successful synchronization.
- Extracted suggestions preserve source provenance and confidence.
- Search indexes update asynchronously but direct record reads remain immediately consistent.
- Briefings record their generation timestamp and source window.
- Report snapshots freeze source identifiers, values, visibility decisions, template version, and cutoff time before rendering.

## 14. Error Handling and Recovery

- API errors use stable machine-readable codes with user-safe messages.
- Invalid input returns field-level validation errors.
- Permission failures do not reveal the existence of private content.
- External integration failures use exponential backoff, bounded retries, and a visible synchronization status.
- Expired Google authorization pauses affected sync jobs and prompts only the owning user to reconnect.
- Failed background jobs enter an operator-visible queue with provenance and retry controls.
- Failed report renders preserve the approved snapshot and expose a retryable rendering job without creating a publishable artifact.
- Delivery failures never mark a report sent unless the external provider confirms acceptance; retries use the same artifact version and idempotency key.
- Soft-deleted records remain recoverable according to retention policy.
- PostgreSQL and artifact storage are backed up independently and restoration is tested before production cutover.

## 15. Testing and Verification

### Automated tests

- Domain-unit tests for work transitions, permissions, privacy, gates, and guarded execution
- API-contract tests generated against the OpenAPI specification
- PostgreSQL integration tests for transactions, outbox delivery, search, and audit history
- Google adapter tests with recorded fixtures and no live-account dependency in CI
- MCP-tool tests verifying scopes, serialization, and idempotency
- End-to-end browser tests for Today, project rooms, Kanban, privacy, artifacts, and Location Pursuit gates
- Golden-file and visual tests for report templates, pagination, branding, privacy filtering, and deterministic rendering
- Backup and restoration verification

### Acceptance scenarios

The test fixtures must demonstrate:

1. A private Gmail thread remains invisible to another user and their agent.
2. Sharing a thread into a project exposes only the shared record.
3. A work item moved on Kanban updates every other work view.
4. A Location Pursuit cannot silently advance past unmet gates.
5. Evidence retains source, timestamp, visibility, and checksum.
6. An agent can complete authorized routine work with full attribution.
7. A destructive or out-of-scope agent action is rejected or routed to approval.
8. Mojave, Hawaiʻi, and The Landing can use the same Location Pursuit template without custom database columns for each project.
9. Two reports generated from the same approved snapshot and template version are byte-identical or normalized-equivalent according to the renderer contract.
10. Each audience-role profile consistently excludes private mailbox content and disallowed internal fields while preserving citations to eligible evidence.
11. An explicitly authorized delivery records the exact report artifact, recipient, sender, channel, and provider response.

## 16. V1 Preservation and V2 Cutover

- Preserve V1 in Git before application replacement begins.
- Do not delete existing SQLite data, uploads, or deployment volumes.
- V2 uses a fresh PostgreSQL schema and independent development environment.
- Build an explicit importer after the V2 domain model stabilizes.
- Run V1 and V2 independently during validation.
- Switch `atlas.rangeway.app` only after production backup, restoration test, authentication verification, and acceptance-project review.
- Retain V1 backups through the post-cutover validation period.

## 17. Delivery Sequence

The design decomposes into independently testable implementation plans:

1. Platform foundation: repository structure, identity, PostgreSQL, audit, API conventions, and deployment.
2. Operating core: Project Rooms, workstreams, work items, Today, Kanban, and activity.
3. Relationships and artifacts: people, organizations, hybrid storage, and evidence.
4. Location Pursuit template: development areas, gates, requirements, and acceptance fixtures.
5. Google Workspace intelligence: Gmail, Drive, Calendar, privacy, indexing, and extraction.
6. Reports and publishing: snapshot model, templates, privacy filtering, PDF rendering, native archival, and guarded delivery.
7. Agent platform: scoped service identities, MCP server, guarded execution, events, and Hermes workflows.
8. Production cutover: importer, backups, restoration test, observability, and DNS transition.

Each sequence item must produce working software with its own test and review gate. Linear parity remains an organic future outcome, not a release-one milestone.
