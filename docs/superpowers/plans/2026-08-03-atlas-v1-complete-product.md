# Atlas V1 Complete Product Implementation Plan

**Status:** Approved for immediate execution
**Date:** 2026-08-03
**Branch:** `codex/atlas-v2-build`
**Product source:** `docs/superpowers/specs/2026-08-02-atlas-v2-design.md`
**Gap source:** `.superpowers/sdd/atlas-v1-product-gap-map.md`

In this plan, **Atlas V1** means the first complete usable operating-office release described by the approved Atlas V2 design. It does not mean the preserved SQLite application on `codex/atlas-v1-archive`.

## Global constraints

- Build the entire approved first-release scope. Do not substitute infrastructure completion for product completion.
- Preserve the archived SQLite V1 code, data, uploads, and production volumes. The new product uses PostgreSQL and the V2 API exclusively.
- Keep all durable records organization-scoped. Apply authorization before serialization, search ranking, briefing generation, report snapshots, and MCP responses.
- Mutations, audit events, outbox events, and idempotency responses commit atomically.
- Gmail, Drive, and Calendar content is private to its owning user by default. Sharing creates an explicit project-visible record or snapshot; it never widens the source mailbox or file permissions.
- Work is captured once. Today, Project Rooms, Kanban, list, calendar, and portfolio are projections of the same universal work items.
- Agents use the versioned API, never the database. Every mutation records the agent, delegator or automation, task source, request, and affected records.
- Report templates are role-based, never person-specific. Private or unsupported material is excluded unless an authorized override is explicitly audited.
- Mojave, Hawaiʻi, and `St. Louis — The Landing` use one Location Pursuit template. Historical context is not verified truth; unknown facts stay unknown until a maintained source and provenance support them.
- No live deployment or DNS cutover occurs until all product acceptance scenarios and equipped PostgreSQL, Docker, backup/restore, Caddy, TLS, and browser gates pass.
- Each task uses test-driven development, produces a focused report in `.superpowers/sdd/`, commits once clean, and receives independent specification and code-quality review before the next task.

## Task 1: Build the complete Operating Core domain and API

**Goal:** Make PostgreSQL and `/api/v2` capable of operating Rangeway work end to end before any new interface depends on it.

Implement additive migrations, repositories, domain services, routes, OpenAPI contracts, outbox events, and tests for:

- Project Rooms, project memberships, health history, workstreams, and activity.
- Universal work items with the five approved types and six approved statuses, ordering, labels, parents, dependency-cycle prevention, completion metadata, and archive/recovery behavior.
- Decisions, risks, blockers, milestones, people, counterparties, affiliations, and project relationships.
- Today, portfolio health, canonical board/list/calendar projections, saved filters, global search over authorized native Atlas records, and complete project context bundles.
- Cursor pagination, stable filters, field validation, safe `NOT_FOUND`, idempotent mutation replay/conflict behavior, project membership enforcement, atomic audit/outbox records, and least-privilege grants.

The API must expose the complete Operating Core endpoint families listed in Sections 3 and 7 Tasks 1-5 of `.superpowers/sdd/atlas-v1-product-gap-map.md`. Add production outbox handlers for every emitted event. Do not build a UI in this task.

Acceptance:

- One work item moved through the API is immediately consistent in board, list, calendar, Today, portfolio, and project context results.
- Cross-organization and unauthorized project access does not reveal existence.
- Dependency cycles, invalid blocker targets, invalid status transitions, and malformed pagination are rejected deterministically.
- Every material mutation proves business row + audit + outbox + idempotency atomicity in PostgreSQL integration tests.
- OpenAPI lint, typecheck, build, focused unit tests, and equipped PostgreSQL tests are documented distinctly; unavailable infrastructure is never reported as passing.

## Task 2: Replace the inherited CRM shell with the complete Operating Core interface

**Goal:** Deliver the first genuinely usable Atlas office on top of Task 1.

Replace the legacy-screen client with a responsive React application using the declared industrial/utilitarian-with-editorial-warm design direction:

- Global navigation: Today, Projects, Portfolio, Work, People, Files, Calendar, Search, Settings.
- Today: next actions, waiting/overdue work, decisions needed, health changes, agent activity, upcoming meetings/milestones, and quick capture.
- Project directory with search, filters, saved views, health, owner, template, strategic area, and recent activity.
- Project Room with objective/health/focus/blocker/next decision/next action, workstreams, work board, milestones, people, decisions, risks, files, evidence entry points, and activity.
- Office-wide Kanban, list, and calendar views backed by the same work records, with keyboard-accessible movement and optimistic updates that recover safely on error.
- Portfolio health, People and counterparty indexes/details, global search, and a command palette.
- Loading, empty, error, offline/retry, permission-denied-without-disclosure, destructive-action, and mobile states.

Use framework-matched React/CSS diffs. The memorable route-line element connects portfolio health, project gates, and next actions. Typography, palette, focus states, reduced motion, responsive behavior, and contrast follow the declared DirectDesign contract. Remove all production dependence on legacy `/api/*` records.

Acceptance:

- A user can start at Today, understand attention needs, move work on Kanban, open its Project Room, and see the same state in list/calendar without reloading or duplication.
- Desktop and mobile layouts are fully usable; all core flows are keyboard accessible and meet WCAG AA.
- Browser verification captures Today, Projects, a Project Room, Kanban, Portfolio, and mobile navigation in a real browser.
- No placeholder cards or dead controls remain in the core interface.

## Task 3: Build artifacts, evidence, and the Location Pursuit engine

**Goal:** Make Atlas capable of governing real site-development readiness rather than merely tracking tasks.

Implement schema, services, APIs, worker handlers, UI, and tests for:

- Native uploads, linked Drive artifacts, immutable evidence snapshots, artifact versions, checksums, visibility, canonical URLs, protected downloads, project/person/counterparty links, reversible archival, and artifact activity.
- Claims and evidence links spanning requirements, decisions, risks, blockers, and report statements without widening private source permissions.
- Versioned Location Pursuit templates with the approved eight development areas, requirement definitions and instances, exact requirement-state vocabulary, evidence, waivers, readiness calculations, and phase reconciliation.
- Project Room Location Pursuit profile, readiness visualization, development-area panels, evidence inspection, and phase-change workflow that cannot silently bypass unmet gates.
- Evidence-graded representative fixtures for Mojave, Hawaiʻi, and `St. Louis — The Landing`; unverified fields remain `unknown` and fixture provenance identifies the maintained source requirement.

Acceptance:

- All three projects use identical template/schema/component paths and expose all eight development areas.
- An `evidenced` requirement requires eligible evidence; a waiver requires actor and rationale; unmet requirements block or explicitly reconcile phase movement.
- Protected artifact paths never leak, private sources stay private, and snapshot checksums/provenance are immutable.
- Project Room and portfolio readiness remain responsive and accessible on desktop and mobile.

## Task 4: Build private-by-default Google Workspace intelligence

**Goal:** Connect full authorized Gmail, Drive, and Calendar indexes without compromising private communications.

Implement:

- Per-user Google connection lifecycle, encrypted credential-reference boundary, scopes/status/reconnect UI, incremental cursors, retry state, and operator-visible failures.
- Gmail threads/messages/participants/content/labels/timestamps/attachment metadata, history-token incremental sync, and bounded full-resync recovery.
- Drive items/permissions/canonical links/project links and evidence snapshots.
- Calendar events/attendees/project-person-work links and idempotent Atlas milestone synchronization.
- Owner-private visibility rows, explicit project-sharing snapshots, matching/extraction suggestions with confidence/provenance/review state, and permission-first unified search.
- Live-intelligence Today/project/weekly/monthly briefings with immutable source windows and generation timestamps.
- Recorded Google fixtures so automated tests never require a live account.

Acceptance:

- A private Gmail thread, Drive item, or Calendar event is invisible to another user and their agent; sharing exposes only the selected project-visible record/snapshot.
- Expired authorization pauses only the owning user's jobs and prompts only that user.
- Permission filtering occurs before ranking, briefing generation, serialization, and search snippets.
- Low-confidence suggestions never silently mutate authoritative facts.

## Task 5: Build scoped agent access, guarded execution, and MCP

**Goal:** Let Codex, Hermes, and automations operate Atlas safely through the same product contract.

Implement:

- Service-actor scopes, credential rotation without actor-identity changes, expiration, disablement, delegations/task authority, external-delivery authority, and approval requests.
- Guarded policy for credential/permission changes, permanent deletion, unrequested external communication, and out-of-scope bulk operations.
- Agent invocation/activity records and complete attribution in audit/outbox events.
- An MCP server that calls the versioned API and implements every initial tool in Section 6 of `.superpowers/sdd/atlas-v1-product-gap-map.md`.
- Settings/agent console for service identities, delegations, approvals, automation jobs, failure visibility, retry, and revocation.

Acceptance:

- Effective authority is the intersection of credential scope and active task delegation.
- Authorized routine internal work executes without redundant confirmation and is fully attributable.
- Destructive, credential-changing, unrequested external, expired, or out-of-scope operations are rejected or routed to approval.
- MCP receives no database credentials and passes privacy, scope, serialization, and idempotency tests.

## Task 6: Build governed role-based reports and deterministic PDFs

**Goal:** Generate polished stakeholder-ready reports from authorized operating data.

Implement:

- The seven approved report templates and seven reusable audience-role profiles.
- Immutable report snapshots with source IDs/values, cutoff, template/profile versions, visibility decisions, inclusion/omission reasons, unsupported-claim review, and generating actor.
- Project and portfolio report builder, structured preview, narrative revision, visibility review, approval, render, retry, archive, and Files/project-history surfaces.
- Deterministic Rangeway-branded HTML-to-PDF rendering in the worker; normalized-equivalence or byte-identity contract, checksums, and native artifact archival.
- Guarded delivery authority and exact recipient/sender/channel/provider/idempotency history; draft-only behavior without explicit external authority.

Acceptance:

- Templates are role-based and contain no person-specific disclosure logic.
- Private/disallowed content and unsupported claims are excluded unless an authorized override is recorded.
- The same approved snapshot/template renders identically under the declared deterministic contract.
- A failed render preserves the snapshot and produces no publishable artifact; sent status requires provider acceptance.
- Generated PDFs are polished, readable, branded, downloadable, and linked to their projects and source evidence.

## Task 7: Complete importer and whole-product acceptance

**Goal:** Prove Atlas V1 as a coherent product and prepare a safe, explicit transition from the preserved application.

Implement:

- Repeatable SQLite/upload importer with dry-run, conflict reporting, source identifiers, provenance, and explicit unknown/unverified treatment.
- Complete browser journeys for Today, Projects, Project Rooms, Kanban/list/calendar, privacy sharing, artifacts/evidence, Location Pursuit gates, agents, and reports.
- Responsive, keyboard, contrast, reduced-motion, error-state, and performance verification.
- API/OpenAPI conformance, PostgreSQL transaction/concurrency, worker, Google-fixture, MCP, PDF golden/visual, privacy, audit, idempotency, and importer tests.
- Operator dashboards/runbooks for sync failures, report failures, outbox terminal events, backups, and cutover rollback.

Acceptance:

- All eleven acceptance scenarios in Section 15 of the design pass.
- Mojave, Hawaiʻi, and The Landing pass the complete criteria in Section 8 of `.superpowers/sdd/atlas-v1-product-gap-map.md`.
- No product page depends on legacy SQLite APIs.
- V1 data/uploads remain intact; import is repeatable and never silently overwrites conflicts or asserts unverified truth.

## Task 8: Qualify and deploy Atlas V1 to `atlas.rangeway.app`

**Goal:** Run the equipped gates, deploy the approved product, and verify production without sacrificing rollback.

Execute only after Tasks 1-7 are independently approved:

- Run the full zero-skip PostgreSQL suite, Docker image/Compose validation, ShellCheck, systemd verification, Caddy/TLS checks, real backup/restore rehearsal, and native lock/concurrency tests on the target Ubuntu VPS.
- Create and verify encrypted off-server backup storage.
- Provision production owner and Google Workspace credentials through the documented ceremonies.
- Back up preserved V1 state, run importer dry-run and approved import, deploy the exact reviewed commit, verify authentication and all critical product journeys, then switch `atlas.rangeway.app`.
- Retain V1 rollback artifacts and monitor web, worker, database, sync, report, and backup health through the validation period.

Acceptance:

- Every equipped gate runs with zero unexplained skips or failures.
- TLS, Google sign-in, private search, project/work mutation, agent attribution, PDF generation/download, backup, and restore are proven against the deployed release.
- Production release SHA and API/contract versions match the reviewed commit exactly.
- Rollback remains available until the validation period is explicitly closed.
