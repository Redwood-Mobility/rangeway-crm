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

## Concerns and boundaries

- Blocker target vocabulary includes `requirement`, but this Task 1 service intentionally rejects requirement targets until Task 8 owns Location Pursuit requirement persistence. Accepting unvalidated requirement UUIDs now would create dangling blockers.
- The migration SQL and transactional PostgreSQL acceptance suite could not execute against a live PostgreSQL server on this machine. Static migration tests, full TypeScript/build checks and all non-equipped tests pass, but an equipped CI/environment run remains the final database-runtime gate.
