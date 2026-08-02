# Atlas V2 Platform Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Track every step with the checkboxes below.

**Goal:** Replace Atlas V1's technical foundation with a tested, secure Atlas V2 modular monolith that can support the operating core, Location Pursuits, Google Workspace indexing, role-based PDF reports, and agent integrations in later plans.

**Architecture:** One TypeScript repository produces two long-running processes: an Express web/API process and a background worker. PostgreSQL is the authoritative database; a native artifact volume stores uploaded and generated files. All human, agent, and automation access crosses a versioned API and a shared identity/permission boundary. Every state mutation writes an audit event and an outbox event in the same database transaction.

**Tech stack:** Node.js 22, TypeScript 5.9, Express 5, React 19, Vite 7, PostgreSQL 17, `pg`, Zod 4, Vitest, Supertest, Docker Compose, and Caddy.

**Design source:** `docs/superpowers/specs/2026-08-02-atlas-v2-design.md`

## Foundation constraints

- Preserve the V1 implementation and its existing SQLite/upload data. Do not delete or repurpose the `crm-data` or `crm-uploads` Docker volumes during this plan.
- Every durable Atlas record belongs to an organization. The initial Rangeway organization ID is `00000000-0000-4000-8000-000000000001`.
- Google Workspace will be the primary production sign-in. Local password sign-in is allowed only when `AUTH_MODE=local` and `NODE_ENV!=production`.
- Human, agent, and automation identities are distinct actor types with separate credentials and attributable audit history.
- No client, agent, integration, or report renderer receives direct database access.
- API errors use stable codes. Permission failures do not reveal whether a private record exists.
- A successful mutation, audit event, and outbox event commit atomically. A failed mutation leaves none of them behind.
- V2 records are archived, not permanently deleted, unless a later approved retention policy explicitly requires deletion.
- Every task ends with focused tests plus `npm run typecheck` and `npm run build`.
- This plan does not implement Project Rooms, Work Items, Google indexing, PDF generation, MCP tools, or V1 data migration. Those receive separate implementation plans on top of this foundation.

## Target structure

```text
db/migrations/0001_platform.sql
openapi/atlas-v2.yaml
src/client/
src/server/app.ts
src/server/index.ts
src/server/config.ts
src/server/platform/db/client.ts
src/server/platform/db/migrate.ts
src/server/platform/http/api-error.ts
src/server/platform/http/error-handler.ts
src/server/platform/http/request-context.ts
src/server/modules/identity/identity.repository.ts
src/server/modules/identity/identity.routes.ts
src/server/modules/identity/identity.service.ts
src/server/modules/audit/audit.repository.ts
src/server/modules/events/outbox.repository.ts
src/server/modules/events/outbox.service.ts
src/shared/api.ts
src/shared/identity.ts
src/worker/index.ts
src/worker/outbox-worker.ts
tests/helpers/database.ts
tests/server/
tests/worker/
docs/runbooks/atlas-v2-operations.md
docs/runbooks/atlas-v2-restore-test.md
```

## Task 1: Preserve V1 and establish the testable application seam

**Files:**

- Modify: `package.json`
- Modify: `package-lock.json`
- Create: `vitest.config.ts`
- Create: `src/server/app.ts`
- Modify: `src/server/index.ts`
- Create: `tests/server/health.test.ts`

- [ ] **Step 1: Commit the current V1 reference state without mixing it with V2 work**

Review the eight existing modified files, then stage only:

```bash
git add README.md deploy/backup.sh deploy/deploy.sh docker-compose.yml \
  src/client/index.html src/client/src/main.tsx src/client/src/styles.css src/server/index.ts
git diff --cached --check
git commit -m "chore: preserve Atlas v1 reference implementation"
git branch codex/atlas-v1-archive
```

Expected: the commit succeeds, `codex/atlas-v1-archive` points at that commit, and `git status --short` is empty.

- [ ] **Step 2: Add the test dependencies and scripts**

Run:

```bash
npm install --save-dev vitest supertest @types/supertest
```

Add these scripts to `package.json`:

```json
"test": "vitest run",
"test:watch": "vitest",
"test:integration": "vitest run tests/server tests/worker",
"db:migrate": "tsx src/server/platform/db/migrate.ts"
```

Create `vitest.config.ts` with Node as the test environment and `tests/**/*.test.ts` as the include pattern.

- [ ] **Step 3: Write the failing health-route test**

Create `tests/server/health.test.ts`:

```ts
import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp } from "../../src/server/app.js";

describe("GET /api/v2/health", () => {
  it("returns the V2 service identity", async () => {
    const response = await request(createApp()).get("/api/v2/health");

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      status: "ok",
      service: "atlas-web",
      apiVersion: "v2",
    });
  });
});
```

Run `npm test -- tests/server/health.test.ts`.

Expected: FAIL because `src/server/app.ts` does not exist.

- [ ] **Step 4: Extract an application factory and make the test pass**

Create `src/server/app.ts` exporting `createApp(): Express`. Register `GET /api/v2/health` there and keep middleware/routes/static serving in the factory. Reduce `src/server/index.ts` to configuration loading, `createApp()`, `listen()`, and shutdown wiring. Server-relative imports retain `.js` extensions.

Run:

```bash
npm test -- tests/server/health.test.ts
npm run typecheck
npm run build
```

Expected: all commands pass and the production entrypoint still serves the SPA.

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json vitest.config.ts src/server/app.ts src/server/index.ts tests/server/health.test.ts
git commit -m "test: establish Atlas V2 application harness"
```

## Task 2: Make runtime configuration strict and environment-safe

**Files:**

- Modify: `src/server/config.ts`
- Modify: `.env.example`
- Modify: `deploy/env.production.example`
- Create: `tests/server/config.test.ts`

- [ ] **Step 1: Write failing configuration tests**

Test an exported `parseConfig(env)` function for these cases:

1. Development defaults to port `8080`, `AUTH_MODE=local`, and artifact directory `./artifacts`.
2. Production rejects `AUTH_MODE=local`.
3. Production rejects missing `DATABASE_URL`, `SESSION_SECRET`, `ATLAS_ORIGIN`, and Google OAuth values.
4. `SESSION_SECRET` must be at least 32 characters.
5. `ATLAS_ORIGIN` must be an HTTPS URL in production.

Run `npm test -- tests/server/config.test.ts`.

Expected: FAIL until the new schema exists.

- [ ] **Step 2: Implement the Zod configuration schema**

Export a `Config` type and `parseConfig(env: NodeJS.ProcessEnv): Config`. The returned object must include:

```ts
{
  nodeEnv: "development" | "test" | "production";
  port: number;
  databaseUrl: string;
  sessionSecret: string;
  atlasOrigin: string;
  artifactDir: string;
  authMode: "google" | "local";
  googleClientId?: string;
  googleClientSecret?: string;
  googleRedirectUri?: string;
  workerPollMs: number;
}
```

Use `superRefine` for production-only rules. Tests may use explicit safe values rather than weakening validation globally.

- [ ] **Step 3: Replace the environment examples**

Document every field in `.env.example`. In `deploy/env.production.example`, set `AUTH_MODE=google`, `ATLAS_ORIGIN=https://atlas.rangeway.app`, PostgreSQL service URL, OAuth callback URL, and conspicuous replacement values for secrets.

- [ ] **Step 4: Verify and commit**

```bash
npm test -- tests/server/config.test.ts
npm run typecheck
npm run build
git add src/server/config.ts .env.example deploy/env.production.example tests/server/config.test.ts
git commit -m "feat: enforce Atlas runtime configuration"
```

## Task 3: Establish PostgreSQL, migrations, and the platform schema

**Files:**

- Modify: `package.json`
- Modify: `package-lock.json`
- Create: `src/server/platform/db/client.ts`
- Create: `src/server/platform/db/migrate.ts`
- Create: `db/migrations/0001_platform.sql`
- Create: `tests/helpers/database.ts`
- Create: `tests/server/migrations.test.ts`

- [ ] **Step 1: Add PostgreSQL dependencies**

```bash
npm install pg
npm install --save-dev @types/pg
```

- [ ] **Step 2: Write the failing migration test**

`tests/helpers/database.ts` must:

- Read `TEST_DATABASE_URL`, defaulting to `postgres://atlas:atlas@localhost:5432/postgres`.
- Create a uniquely named temporary database using only lowercase letters, digits, and underscores.
- Return its URL and a cleanup function that terminates connections before dropping it.
- Skip with a clear message only when the PostgreSQL server cannot be reached; never substitute SQLite.

`tests/server/migrations.test.ts` must create a temporary database, run all migrations twice, and assert that these relations exist exactly once:

```text
schema_migrations
organizations
users
actors
organization_memberships
audit_events
outbox_events
```

It must also assert that the Rangeway organization seed exists with ID `00000000-0000-4000-8000-000000000001`.

Run `npm test -- tests/server/migrations.test.ts`.

Expected: FAIL because the migration runner and schema do not exist.

- [ ] **Step 3: Implement database connections and transaction support**

In `client.ts`, export:

```ts
export type DbClient = PoolClient;
export function createPool(databaseUrl: string): Pool;
export async function withTransaction<T>(
  pool: Pool,
  operation: (client: DbClient) => Promise<T>,
): Promise<T>;
```

`withTransaction` must issue `BEGIN`, commit only after the operation resolves, roll back on any error, and always release the client.

- [ ] **Step 4: Implement ordered, checksum-verified migrations**

`migrate.ts` must load `db/migrations/*.sql` in filename order, calculate SHA-256 for each file, and record filename/checksum/applied timestamp in `schema_migrations`. Re-running is a no-op. A filename whose recorded checksum differs from the file must fail startup rather than silently changing history.

- [ ] **Step 5: Define the platform schema**

`0001_platform.sql` must create:

- `organizations`: UUID ID, slug, name, timestamps, optional archived timestamp.
- `users`: UUID ID, unique email using `citext`, display name, Google subject, local password hash, timestamps, optional disabled timestamp.
- `actors`: UUID ID, organization ID, type enum (`human`, `agent`, `automation`), optional user ID, unique service-key prefix, service-key hash, display name, timestamps, optional disabled timestamp.
- `organization_memberships`: organization/user pair, role enum (`owner`, `admin`, `member`, `viewer`), created timestamp.
- `audit_events`: organization/actor/request IDs, action, resource type/ID, JSONB before/after/metadata, timestamp.
- `outbox_events`: organization/actor/request IDs, event type, aggregate type/ID, integer schema version, JSONB payload, availability/attempt/processing/publication fields, timestamps.

Add foreign keys, unique constraints, check constraints that enforce human actors reference a user and service actors do not, plus indexes for organization scoping and pending outbox delivery. Enable `citext` and `pgcrypto`. Seed the Rangeway organization idempotently.

- [ ] **Step 6: Verify and commit**

```bash
npm test -- tests/server/migrations.test.ts
npm run typecheck
npm run build
git add package.json package-lock.json src/server/platform/db db/migrations tests/helpers/database.ts tests/server/migrations.test.ts
git commit -m "feat: add PostgreSQL platform schema"
```

## Task 4: Implement actors, memberships, and permission primitives

**Files:**

- Create: `src/shared/identity.ts`
- Create: `src/server/modules/identity/identity.repository.ts`
- Create: `src/server/modules/identity/identity.service.ts`
- Create: `tests/server/identity.test.ts`
- Create: `tests/server/permissions.test.ts`

- [ ] **Step 1: Define shared identity contracts**

Create these exported types in `src/shared/identity.ts`:

```ts
export const actorTypes = ["human", "agent", "automation"] as const;
export type ActorType = (typeof actorTypes)[number];

export const organizationRoles = ["owner", "admin", "member", "viewer"] as const;
export type OrganizationRole = (typeof organizationRoles)[number];

export interface ActorContext {
  actorId: string;
  actorType: ActorType;
  actorName: string;
  organizationId: string;
  role: OrganizationRole;
  requestId: string;
  userId?: string;
}
```

- [ ] **Step 2: Write failing identity lifecycle tests**

Cover these observable behaviors through `IdentityService`:

- `createHumanUser` lowercases the email, creates user/actor/membership in one transaction, and returns no password hash.
- Creating the same email twice returns a stable conflict error.
- `createServiceActor` accepts only `agent` or `automation`, returns the plaintext key exactly once, stores only a SHA-256 hash plus a 12-character lookup prefix, and assigns a role.
- A disabled actor cannot authenticate.
- A viewer cannot perform a member operation; owner can perform all organization operations.

Run:

```bash
npm test -- tests/server/identity.test.ts tests/server/permissions.test.ts
```

Expected: FAIL because the repository/service do not exist.

- [ ] **Step 3: Implement the repository with organization-scoped queries**

The repository must expose exact methods for:

```ts
createHumanUser(input, client)
findHumanActorByEmail(organizationId, email, client)
createServiceActor(input, serviceKeyPrefix, serviceKeyHash, client)
findServiceActorByPrefix(serviceKeyPrefix, client)
disableActor(organizationId, actorId, disabledAt, client)
```

Every read or mutation after service-key prefix lookup must include `organization_id` in its SQL predicate. Map database snake_case rows to explicit camelCase return objects rather than returning raw rows.

- [ ] **Step 4: Implement identity and permission services**

`IdentityService` must generate service keys with `crypto.randomBytes(32).toString("base64url")`, compare hashes with `timingSafeEqual`, and use `withTransaction` for multi-row creation. Export `assertMinimumRole(actual, required)` using this rank:

```ts
const roleRank: Record<OrganizationRole, number> = {
  viewer: 10,
  member: 20,
  admin: 30,
  owner: 40,
};
```

Throw `ApiError` with code `FORBIDDEN` for insufficient roles and the same `UNAUTHENTICATED` error for missing, invalid, or disabled credentials.

- [ ] **Step 5: Verify and commit**

```bash
npm test -- tests/server/identity.test.ts tests/server/permissions.test.ts
npm run typecheck
npm run build
git add src/shared/identity.ts src/server/modules/identity tests/server/identity.test.ts tests/server/permissions.test.ts
git commit -m "feat: add Atlas actor and permission model"
```

## Task 5: Standardize request context, API errors, and the V2 contract

**Files:**

- Create: `src/shared/api.ts`
- Create: `src/server/platform/http/api-error.ts`
- Create: `src/server/platform/http/error-handler.ts`
- Create: `src/server/platform/http/request-context.ts`
- Create: `src/server/modules/identity/identity.routes.ts`
- Modify: `src/server/app.ts`
- Create: `openapi/atlas-v2.yaml`
- Create: `tests/server/api-contract.test.ts`

- [ ] **Step 1: Write failing API contract tests**

Test:

1. Every response carries `X-Request-Id`; a supplied valid UUID is retained and malformed values are replaced.
2. Unauthenticated `GET /api/v2/me` returns status `401` and `{ error: { code, message, requestId } }`.
3. An unknown authenticated resource and a known-but-private resource both return the same `404 NOT_FOUND` envelope.
4. A development login establishes a secure, HTTP-only signed session and `/api/v2/me` returns the actor context.
5. `POST /api/v2/auth/local/login` returns `404` when `AUTH_MODE` is not `local`.

Run `npm test -- tests/server/api-contract.test.ts`.

Expected: FAIL because the middleware and V2 routes do not exist.

- [ ] **Step 2: Define stable error codes**

In `src/shared/api.ts` define:

```ts
export type ApiErrorCode =
  | "INVALID_INPUT"
  | "UNAUTHENTICATED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "CONFLICT"
  | "RATE_LIMITED"
  | "INTERNAL_ERROR";

export interface ApiErrorBody {
  error: {
    code: ApiErrorCode;
    message: string;
    requestId: string;
    details?: unknown;
  };
}
```

Implement `ApiError` with HTTP status, code, safe public message, and optional safe details. The error handler maps Zod failures to `INVALID_INPUT`, logs full internal errors with request/actor context, and never exposes stack traces or SQL details.

- [ ] **Step 3: Add request and authentication context**

`request-context.ts` must:

- Assign a UUID request ID and response header.
- Authenticate either the signed human session cookie or `Authorization: Bearer atlas_<prefix>.<secret>`.
- Attach exactly one `ActorContext` to the request.
- Reject conflicting cookie and bearer credentials.
- Return indistinguishable `UNAUTHENTICATED` responses for absent, invalid, expired, or disabled credentials.

Extend the Express request type through a local declaration so route handlers do not cast `req`.

- [ ] **Step 4: Add V2 identity routes**

Implement:

```text
GET  /api/v2/health
GET  /api/v2/me
POST /api/v2/auth/local/login   development/test local mode only
POST /api/v2/auth/logout
```

Use Argon2id password verification. Add `argon2` to dependencies and store only password hashes. The local bootstrap account may be created by a development seed command, never implicitly in production startup.

- [ ] **Step 5: Write the initial OpenAPI 3.1 contract**

`openapi/atlas-v2.yaml` must describe the four routes, cookie/bearer security schemes, `ActorContext`, `ApiErrorBody`, request ID header, and production server `https://atlas.rangeway.app/api/v2`. Validate syntax with:

```bash
npx --yes @redocly/cli lint openapi/atlas-v2.yaml
```

Expected: zero errors. Warnings must either be fixed or documented in the commit message.

- [ ] **Step 6: Verify and commit**

```bash
npm test -- tests/server/api-contract.test.ts
npm run typecheck
npm run build
git add package.json package-lock.json src/shared/api.ts src/server/platform/http src/server/modules/identity/identity.routes.ts src/server/app.ts openapi/atlas-v2.yaml tests/server/api-contract.test.ts
git commit -m "feat: define the Atlas V2 API boundary"
```

## Task 6: Make audit and outbox writes atomic with business mutations

**Files:**

- Create: `src/server/modules/audit/audit.repository.ts`
- Create: `src/server/modules/events/outbox.repository.ts`
- Create: `src/server/modules/events/outbox.service.ts`
- Create: `tests/server/mutation-transaction.test.ts`

- [ ] **Step 1: Write failing atomicity tests**

Use an organization display-name change as the test mutation. Assert:

- Success changes the organization and creates one audit event plus one `organization.updated.v1` outbox event with matching organization, actor, request, and aggregate IDs.
- `before` and `after` audit values contain only allowed business fields, never secrets.
- An exception after the business update but before commit rolls back the organization change, audit event, and outbox event.
- An actor from another organization receives `NOT_FOUND`; no events are written.

Run `npm test -- tests/server/mutation-transaction.test.ts`.

Expected: FAIL because the transaction coordinator does not exist.

- [ ] **Step 2: Implement explicit audit and event inputs**

Export:

```ts
interface AuditInput {
  organizationId: string;
  actorId: string;
  requestId: string;
  action: string;
  resourceType: string;
  resourceId: string;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  metadata?: Record<string, unknown>;
}

interface OutboxInput {
  organizationId: string;
  actorId: string;
  requestId: string;
  eventType: `${string}.v${number}`;
  aggregateType: string;
  aggregateId: string;
  schemaVersion: number;
  payload: Record<string, unknown>;
}
```

`recordAudit(input, client)` and `enqueueEvent(input, client)` must require an existing transaction client; they must not acquire their own pool connection.

- [ ] **Step 3: Implement a transaction coordinator**

Export `mutateWithAuditAndEvent<T>()` from `outbox.service.ts`. Its inputs are the pool, actor context, a business mutation callback returning `{ value, audit, event }`, and an optional test-only hook invoked after the event insert but before commit. It must call the business mutation, `recordAudit`, and `enqueueEvent` inside one `withTransaction` callback.

Validate that actor, audit, and event organization IDs match before inserts. Reject mismatches as `INTERNAL_ERROR` and roll back.

- [ ] **Step 4: Verify and commit**

```bash
npm test -- tests/server/mutation-transaction.test.ts
npm run typecheck
npm run build
git add src/server/modules/audit src/server/modules/events tests/server/mutation-transaction.test.ts
git commit -m "feat: make Atlas mutations auditable and evented"
```

## Task 7: Process outbox events safely in a dedicated worker

**Files:**

- Create: `src/worker/outbox-worker.ts`
- Create: `src/worker/index.ts`
- Modify: `package.json`
- Modify: `tsconfig.server.json`
- Create: `tests/worker/outbox-worker.test.ts`

- [ ] **Step 1: Write failing worker tests**

Test with two concurrent worker instances:

- A pending event is claimed by one worker only using `FOR UPDATE SKIP LOCKED`.
- A successful handler sets `published_at` and clears processing fields.
- A failed handler increments attempts, records a bounded error message, clears its lease, and calculates exponential backoff capped at 15 minutes.
- An event is marked terminal after 10 failures and is not selected again.
- An expired processing lease becomes eligible for retry.
- Reprocessing the same event is safe because handlers receive the stable outbox event ID as their idempotency key.

Run `npm test -- tests/worker/outbox-worker.test.ts`.

Expected: FAIL because the worker does not exist.

- [ ] **Step 2: Implement the claim query and result model**

In `outbox-worker.ts`, claim up to 25 rows in one transaction with this ordering and locking behavior:

```sql
SELECT *
FROM outbox_events
WHERE published_at IS NULL
  AND terminal_at IS NULL
  AND available_at <= now()
  AND (processing_started_at IS NULL OR processing_started_at < now() - interval '5 minutes')
ORDER BY available_at, created_at
FOR UPDATE SKIP LOCKED
LIMIT $1
```

Set `processing_started_at` and a generated `processing_token` before committing the claim. Completion/failure updates must include both event ID and processing token so a stale worker cannot finish a newly reclaimed lease.

- [ ] **Step 3: Implement handler dispatch and retry behavior**

Define `OutboxHandler = (event, context) => Promise<void>` and a registry keyed by versioned event type. Unknown event types are failures, not successes. Calculate retry delay as `min(2 ** attempts * 5 seconds, 15 minutes)` with testable clock/random dependencies. Truncate stored errors to 2,000 characters.

- [ ] **Step 4: Add the worker entrypoint**

`src/worker/index.ts` loads validated config, opens its own pool, polls at `workerPollMs`, and handles `SIGTERM`/`SIGINT` by stopping new claims, allowing the current batch up to 25 seconds, closing the pool, and exiting nonzero only when shutdown fails.

Add scripts:

```json
"dev:worker": "tsx watch src/worker/index.ts",
"start:worker": "node dist/worker/index.js"
```

Include `src/worker/**/*.ts` and `src/shared/**/*.ts` in `tsconfig.server.json` output.

- [ ] **Step 5: Verify and commit**

```bash
npm test -- tests/worker/outbox-worker.test.ts
npm run typecheck
npm run build
git add src/worker package.json package-lock.json tsconfig.server.json tests/worker/outbox-worker.test.ts
git commit -m "feat: add reliable Atlas event worker"
```

## Task 8: Build the single-VPS V2 deployment and recoverable backups

**Files:**

- Modify: `Dockerfile`
- Modify: `docker-compose.yml`
- Modify: `deploy/Caddyfile`
- Modify: `deploy/deploy.sh`
- Modify: `deploy/backup.sh`
- Create: `deploy/restore-test.sh`
- Create: `tests/deploy/compose.test.ts`

- [ ] **Step 1: Write failing deployment configuration tests**

The test must parse `docker compose config --format json` and assert:

- Services are exactly `web`, `worker`, `db`, and `caddy`.
- `web` and `worker` use the same image and run different start commands.
- PostgreSQL is version 17 and mounts `atlas-db` at `/var/lib/postgresql/data`.
- `web` and `worker` mount `atlas-artifacts` at `/app/artifacts`.
- Only Caddy publishes host ports.
- `web` depends on a healthy database and has an HTTP healthcheck.
- `worker` depends on a healthy database.
- Old named volumes are not declared or removed by V2 Compose.

Run `npm test -- tests/deploy/compose.test.ts`.

Expected: FAIL against the V1 Compose file.

- [ ] **Step 2: Create the production image**

Use a two-stage Node 22 Debian-based Dockerfile so native dependencies build consistently. The builder runs `npm ci`, `npm run typecheck`, and `npm run build`. The runtime installs production dependencies only, runs as a non-root user, includes `dist`, `db/migrations`, `openapi`, and the built client, and creates writable `/app/artifacts`.

- [ ] **Step 3: Replace Compose with the V2 topology**

Define:

```text
web     npm run db:migrate && npm start
worker  npm run db:migrate && npm run start:worker
db      postgres:17-bookworm
caddy   caddy:2.10-alpine
```

Use a database healthcheck based on `pg_isready`. Use restart policies and resource-conscious defaults suitable for one VPS. Do not expose PostgreSQL publicly. Caddy proxies `atlas.rangeway.app` to `web:8080` with compression and security headers.

- [ ] **Step 4: Make deployment fail safely**

Update `deploy/deploy.sh` to:

1. Require the target host and production environment file.
2. Run tests, typecheck, build, and OpenAPI lint locally.
3. Run `deploy/backup.sh` remotely before replacing containers when an existing V2 database volume is present.
4. Sync source without deleting `.env`, artifact data, database data, backups, or V1 data directories.
5. Build and start `db`, wait for health, run migrations as a one-off command, then start `web`, `worker`, and `caddy`.
6. Wait for Compose health and verify `https://atlas.rangeway.app/api/v2/health` returns `apiVersion=v2`.
7. Print exact rollback guidance using the previous Git commit and latest backup; do not automate a destructive rollback.

- [ ] **Step 5: Back up PostgreSQL and artifacts with integrity manifests**

`deploy/backup.sh` must create a timestamped directory containing:

```text
atlas-postgres.dump
atlas-artifacts.tgz
manifest.sha256
metadata.txt
```

Use `pg_dump --format=custom` through the running database service. Archive the artifact volume read-only. Record Git commit, Compose project, database image, and timestamp in metadata. Generate SHA-256 checksums and fail if either backup is empty. Never remove old backups in this plan.

- [ ] **Step 6: Add a non-destructive restore test**

`deploy/restore-test.sh BACKUP_DIRECTORY` must verify checksums, create uniquely named temporary PostgreSQL and artifact volumes, restore into them, confirm the schema migration row and Rangeway organization, then remove only those explicit temporary resources. It must refuse an empty path, `/`, `$HOME`, the live volume names, or any unresolved glob.

- [ ] **Step 7: Verify and commit**

```bash
npm test -- tests/deploy/compose.test.ts
docker compose config >/dev/null
npm run typecheck
npm run build
git add Dockerfile docker-compose.yml deploy tests/deploy/compose.test.ts
git commit -m "ops: add recoverable Atlas V2 deployment"
```

## Task 9: Prove the foundation and write the operator handoff

**Files:**

- Create: `tests/smoke/platform-foundation.test.ts`
- Modify: `README.md`
- Create: `docs/runbooks/atlas-v2-operations.md`
- Create: `docs/runbooks/atlas-v2-restore-test.md`

- [ ] **Step 1: Write the end-to-end foundation smoke test**

The smoke test must use a temporary database and the real application factory to:

1. Apply migrations.
2. Create a human owner and an agent actor.
3. Authenticate both through their supported credentials.
4. Read `/api/v2/me` for both.
5. Perform the organization-name test mutation as each authorized actor.
6. Assert audit attribution and outbox event creation.
7. Run the worker until both events are published.
8. Assert unauthenticated and wrong-organization attempts return the stable safe envelopes.

Run `npm test -- tests/smoke/platform-foundation.test.ts`.

Expected before any correction: the test may expose wiring gaps across the modules. Fix product code, not assertions, unless an assertion contradicts the approved design.

- [ ] **Step 2: Replace the README with the V2 operating guide**

Document:

- What Atlas is and is not.
- The two-process modular-monolith architecture.
- Local prerequisites and exact first-run commands.
- How to start PostgreSQL, migrate, seed a local owner, run web/client/worker, test, typecheck, and build.
- Authentication modes and the human/agent/automation distinction.
- The V1 archive branch and the explicit fact that V1 data has not yet been migrated.
- Links to the approved design, this foundation plan, OpenAPI contract, and runbooks.

- [ ] **Step 3: Write the operations and restore runbooks**

`atlas-v2-operations.md` must include health checks, logs, migrations, worker backlog queries, failed event inspection, backup invocation, deployment procedure, and non-destructive rollback decision points.

`atlas-v2-restore-test.md` must include prerequisites, checksum verification, exact restore-test command, expected evidence, quarterly cadence, and a dated sign-off table. It must state that a backup is not trusted until a restore test succeeds.

- [ ] **Step 4: Run the complete foundation gate**

```bash
npm test
npm run typecheck
npm run build
npx --yes @redocly/cli lint openapi/atlas-v2.yaml
docker compose config >/dev/null
git diff --check
```

Expected: all tests and builds pass, OpenAPI has zero errors, Compose resolves, and Git reports no whitespace errors.

- [ ] **Step 5: Manually verify local runtime behavior**

Start the stack, then run:

```bash
curl --fail --silent http://localhost:8080/api/v2/health
docker compose exec db pg_isready -U atlas
docker compose logs worker --since=2m
```

Expected: health JSON identifies `atlas-web` and `v2`; PostgreSQL accepts connections; worker logs show startup without repeated failures.

- [ ] **Step 6: Commit the completed foundation**

```bash
git add README.md docs/runbooks tests/smoke/platform-foundation.test.ts
git commit -m "docs: complete Atlas V2 foundation handoff"
```

## Foundation completion gate

Do not begin the Operating Core implementation plan until all of these are true:

- [ ] The V1 reference commit and `codex/atlas-v1-archive` branch exist.
- [ ] PostgreSQL migrations are idempotent and checksum-protected.
- [ ] Human, agent, and automation identities are distinct and organization-scoped.
- [ ] API errors and request IDs are stable and documented in OpenAPI.
- [ ] Mutations, audit events, and outbox events are transactionally atomic.
- [ ] Concurrent workers cannot double-claim an event, and retries are bounded.
- [ ] Docker Compose runs web, worker, PostgreSQL, and Caddy with persistent V2 volumes.
- [ ] Backup artifacts pass the non-destructive restore test.
- [ ] `npm test`, `npm run typecheck`, `npm run build`, OpenAPI lint, and Compose validation all pass.
- [ ] No V1 volume or production data has been deleted, renamed, or migrated implicitly.

After this gate, write the next plan for the **Operating Core**: Project Rooms, Workstreams, universal Work Items, Today, portfolio health, decisions, risks, milestones, and Kanban/list/calendar projections.
