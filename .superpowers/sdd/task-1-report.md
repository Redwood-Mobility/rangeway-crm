# Task 1 Report: Complete Operating Core Domain and API

## Status

DONE_WITH_CONCERNS

The PostgreSQL-backed `/api/v2` Operating Core is implemented end to end. It adds Project Rooms, memberships and health history; canonical workstreams and work items; decisions, risks, blockers, milestones and activity; people, counterparties, affiliations and project relationships; saved views, Today, portfolio, project context and native authorized search. No client, deployment, or legacy SQLite code was changed.

## Delivered scope

- Added additive migrations `0007_operating_core.sql` and `0008_operating_core_permissions.sql` for the complete Operating Core schema, org-scoped foreign keys and indexes, actor/user provenance, archive and merge metadata, and explicit least-privilege `atlas_web`/`atlas_worker` grants.
- Preserved migrations `0001` through `0006` byte-for-byte. Their SHA-256 values remain:
  - `0001`: `73b91f8487afe9e34fd07ee7d4521ca3d559d1e6727225739e932f0a5ca20ef2`
  - `0002`: `659ffd93d0e7e9dbc853f3284f6bbb8e8a0e9a809d63e6971708a0e57e07cab9`
  - `0003`: `fefdfd3f694d4ecb180734a6299c7cfdca06a884ffdb95613bbbc461a20bc489`
  - `0004`: `1ae5381b8f1cb93dafe1517213a991b24cdc7bf2f73863acd34eab703b2d1af5`
  - `0005`: `c6cca53b905a5a628e4af9772b2207a6517aa64ae5347ccbe434f0c201398751`
  - `0006`: `6b34489c3a6963bef9cb99acdd315f25c5855e3a541a612611a56697fd654028`
- Added centralized shared Operating Core vocabularies, cursor encoding/decoding and transition/cycle policy.
- Added strict Zod request validation and the complete Task 1-5 endpoint families under `/api/v2`, including cursor pagination, filters and required mutation idempotency keys.
- Added project-safe authorization: cross-org and unauthorized access resolve to the same `NOT_FOUND`; project writes require org owner/admin, project ownership, or an owner/editor project membership.
- Added one canonical work record and query path for board, list, calendar, Today, portfolio and project context projections.
- Added work ordering, labels, parent/dependency checks, completion metadata, blocker validation, archive/recovery, merges with provenance preservation, and private project-relationship visibility.
- Routed every material mutation through the existing atomic idempotency/audit/outbox transaction primitive with operation-specific request hashing.
- Added 16 product outbox event types and production acknowledgement handlers for every emitted type.
- Expanded `openapi/atlas-v2.yaml` with the Operating Core paths, strict contracts, approved vocabularies, cursor fields, error responses and `Idempotency-Key` requirements.

## TDD evidence

Tests were added before implementation for policy, migrations, HTTP dispatch/validation, service authorization/projection behavior, OpenAPI coverage, worker registration and PostgreSQL atomic acceptance. The initial focused run failed on missing Operating Core modules/routes/migrations. Incremental green checkpoints were:

- Policy and migration contract: 6 passing tests.
- API, service and policy: 12 passing tests.
- Operating Core focused suite: 31 passing, 5 equipped-environment skips.

The final authoritative full run was serialized after confirming no other Vitest process was active.

## Verification evidence

- `npm run typecheck`: PASS.
- `npm run build`: PASS; Vite transformed 1,699 modules and produced the production client bundle.
- `npx --yes @redocly/cli@latest lint openapi/atlas-v2.yaml`: PASS; contract valid with the repository's three explicit ignores.
- `npm audit --audit-level=high`: PASS; 0 vulnerabilities.
- `git diff --check`: PASS.
- Full `npm test -- --reporter=dot`: PASS — 28 files passed; 344 tests passed; 37 tests skipped; 381 total; 191.78 seconds.

## PostgreSQL acceptance status

Four new PostgreSQL acceptance tests prove, when `TEST_DATABASE_URL` or the default local PostgreSQL fixture is available:

1. A moved work item is immediately consistent across board, list, calendar, Today, portfolio and project context.
2. Cross-organization and unauthorized project reads return safe `NOT_FOUND`.
3. Invalid status transitions, dependency cycles and invalid blocker targets are rejected.
4. Identical idempotency replay succeeds, key/payload reuse conflicts, and a forced outbox failure rolls back business row, audit row, outbox row and idempotency record together.

This machine had no reachable PostgreSQL at `localhost:5432`; these four tests emitted `EQUIPPED_POSTGRESQL_SKIP` and are included in the 37 skipped tests above. They are documented as unavailable, not passing. Existing equipped PostgreSQL tests likewise remained skipped for the same infrastructure reason.

## Acceptance checklist

- Project Rooms CRUD/archive/recovery, owner/member enforcement, health history and project context: implemented.
- Five approved work types and six approved statuses, canonical projections, ordering, labels, parent/dependency safety and completion metadata: implemented.
- Decisions, risks, blockers, milestones, readable activity, people, counterparties, affiliations, project relationships and merge provenance: implemented.
- Today, portfolio health, saved views and authorized native search: implemented.
- Cursor validation, deterministic invalid-input handling, safe `NOT_FOUND`, idempotent replay/conflict, atomic audit/outbox and least-privilege grants: implemented and covered.
- Production worker handlers for every emitted event: implemented and covered.
- OpenAPI, typecheck, build and non-equipped tests: passing.
- Equipped PostgreSQL execution: pending a reachable PostgreSQL fixture; tests are ready and self-identifying.

## Review fix wave (2026-08-03)

Closes the 3 Critical and 8 Important findings in
`.superpowers/sdd/task-1-review-findings.md`.

**A working local PostgreSQL 17 replaced the deferred equipped gate.** Every
PostgreSQL-backed test in this repository had previously been skipped, never
executed. Running them immediately exposed defects that static analysis and the
independent review both missed:

- Critical 3 was real and worse than described: with no `dueAt` and no
  `ownerUserId`, the calendar projection and Today assertions passed against
  empty arrays. The primary Task 1 acceptance test proved nothing.
- A first mutation returned PostgreSQL `Date` objects while its idempotent
  replay returned ISO strings from the stored JSON response, so the same request
  produced two different shapes. Not previously reported.
- `deploy/postgres/init-roles.sh` revokes all privileges and re-granted only the
  platform tables. Rotating database credentials on a deployed Atlas would have
  stripped `atlas_web` of every Operating Core privilege. Not previously
  reported; surfaced by extending the permission contract.
- The end-to-end smoke test could never have passed as written: the session
  cookie is issued `Secure`, so a supertest cookie jar over plain HTTP never
  returns it. `secure: true` is correct for the HTTPS-only deployment, so the
  test now replays the cookie explicitly.

### Critical

1. Person and counterparty merges now require an organization owner or
   administrator (`assertPrivilegedMergeActor`). Project relationships are
   re-pointed in place by `transferProjectRelationships` rather than copied, so
   each row keeps its identity, `created_by_actor_id` and `visibility` — a
   private relationship still belongs to the actor who created it. Where the
   surviving record already holds a relationship for a project, that
   relationship wins and the merged-away one is archived, so a merge never
   overwrites the survivor's data. Moved and superseded relationship IDs are
   recorded in the audit and outbox evidence.
2. `changeProjectRelationship` loads and locks the existing row first and
   authorizes against it through `canMutateProjectRelationship`. A project
   editor can no longer update, expose, or archive another actor's private
   relationship; the refusal is the same safe `NOT_FOUND` the read path already
   produced, so existence is not disclosed. Accurate before/after values are now
   passed to `mutationRecord` (the add path previously hardcoded `before: null`).
3. The projection fixture supplies `dueAt` and `ownerUserId`, and the assertions
   check both fields across board, list and calendar.

### Important

1. `project.context` returns a `sections` map giving each collection's count,
   truncation flag and continuation cursor instead of silently cutting at 100,
   and `contextDecisions` includes decisions linked through `decision_projects`.
2. `requirement` is removed from `blockerTargetTypes` and deferred to Task 3,
   which must reintroduce it with referential validation.
3. Cursors carry `purpose` and `sortType`. `decodeCursor` requires both to match
   the listing's contract and validates the sort value against its type, so an
   invalid timestamp or numeric returns `INVALID_INPUT` instead of a 500.
   `isWellFormedCursor` keeps structural rejection at the route, before any
   handler runs.
4. Search types are a strict enum filtered in SQL before `ORDER BY` and `LIMIT`.
   Filtering the returned page in memory had silently dropped matches whenever
   the first page happened to hold other types.
5. The `/search` `types` parameter is documented in OpenAPI. Exact request and
   response schemas for the generic mutation bodies remain outstanding and are
   deferred to Task 2, where the client consumes each endpoint.
6. `src/shared/database-permission-contract.ts` covers all 20 Operating Core
   relations with their exact update columns and models per-relation DELETE
   grants. `init-roles.sh` restores the complete contract during rotation.
7. Migration `0009_operating_core_integrity_and_permissions.sql` adds
   project-inclusive unique keys and composite foreign keys for workstream,
   parent, dependency, risk-workstream and milestone-workstream relationships,
   and persists `project_id` on `work_item_dependencies`. Migrations `0001`
   through `0008` are byte-identical.
8. Board, list and calendar exclude archived projects, matching Today, portfolio
   and search. `includeArchived` is the single explicit opt-in.

### Verification (2026-08-03, live PostgreSQL 17.10)

- `npm test`: 28 files passed; 373 tests passed; 13 skipped; 0 failed.
- Skips are 8 Docker Compose cases and 5 deployment-coordinator cases needing a
  Linux `flock` or a systemd transient cgroup. Docker is not installed on this
  macOS host and systemd does not exist on it. No PostgreSQL test is skipped.
- Previous baseline for comparison: 341 passed, 5 failed, 37 skipped.
- `npm run typecheck`, `npm run build`, Redocly OpenAPI lint,
  `npm audit --audit-level=high` (0 vulnerabilities), `git diff --check`: passed.
- Migrations `0001`-`0008` unmodified; only `0009` added.
- New behavioral regression tests prove private-relationship authorization,
  merge authorization with preserved creator ownership, and cross-project
  rejection at the database boundary with the service layer bypassed.

### Environment note

`better-sqlite3` was rebuilt for Node 24; its binding had been compiled for
Node 22, which made the preserved V1 SQLite application fail to load and
`tests/server/production-legacy.test.ts` fail. This was a host issue, not a code
defect.

## Concerns and boundaries

- Blocker target vocabulary includes `requirement`, but this Task 1 service intentionally rejects requirement targets until Task 8 owns Location Pursuit requirement persistence. Accepting unvalidated requirement UUIDs now would create dangling blockers.
- The migration SQL and transactional PostgreSQL acceptance suite could not execute against a live PostgreSQL server on this machine. Static migration tests, full TypeScript/build checks and all non-equipped tests pass, but an equipped CI/environment run remains the final database-runtime gate.
