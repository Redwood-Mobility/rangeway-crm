# Atlas V2 foundation

Atlas is Rangeway's internal relationship and site-development system. It is being built as an operating office for the people, locations, diligence, decisions, and next actions behind a hospitality-driven EV charging network. It is not a generic sales CRM.

> **Foundation status — do not deploy yet.** This branch proves the Atlas V2 platform foundation; it is not the complete operating-office UI. Do not deploy or cut over to it until the equipped foundation gates, the Operating Core, representative acceptance projects, and the cutover plan are separately reviewed and approved.

The current foundation includes PostgreSQL migrations, organization-scoped human/agent/automation identities, stable API envelopes and request IDs, idempotent mutation/audit/outbox transactions, an explicit bounded-retry outbox worker registry, least-privilege database roles, and recoverable deployment and backup tooling. Project Rooms, Workstreams, universal Work Items, Today, portfolio health, decisions, risks, milestones, and their Kanban/list/calendar projections belong to the next Operating Core plan.

## Architecture

Atlas V2 is a TypeScript modular monolith built and deployed from one repository as two long-running application processes:

- `atlas-web`: Express, the versioned `/api/v2` boundary, and the built React client.
- `atlas-worker`: background outbox processing with bounded retries and safe concurrent claims.

PostgreSQL 17 is authoritative for V2 records, append-only audit history, API idempotency records, and the transactional outbox. A separate `atlas-artifacts` volume is reserved for uploaded and generated artifacts. Caddy terminates production TLS. The web and worker use the same image but start with different commands. Production migrations run through the operations-only `atlas_migrator` service; web and worker never migrate on startup and connect as `atlas_web` and `atlas_worker` respectively.

Every client, human, agent, automation, and future integration crosses the API and shared permission boundary. No client receives direct database access. A successful business mutation, audit event, and outbox event commit in one PostgreSQL transaction.

## V1 preservation and migration status

The preserved V1 reference is branch `codex/atlas-v1-archive` at commit `2d90e4d281c477fa6290d62dfe7c6e9b1d8fe1c5`. V1 uses SQLite and its original upload storage.

**No V1 data has been migrated to V2.** The V2 deployment files intentionally use only `atlas-db` and `atlas-artifacts`; they must never rename, delete, mount, or repurpose the V1 `crm-data` or `crm-uploads` volumes. Migration and cutover require a later, approved plan.

## Local prerequisites

- Node.js 22 and npm.
- PostgreSQL 17 reachable through the `DATABASE_URL` in `.env`.
- Docker only if using the local PostgreSQL container shown below or validating the production topology.
- Git.

The test suite may skip PostgreSQL integration tests only when PostgreSQL is recognizably unreachable. A skip is not passing integration evidence.

## First local run

Install the application and create the local environment file:

```bash
npm install
cp .env.example .env
```

Edit `.env` and set explicit development-only values for:

```dotenv
NODE_ENV=development
AUTH_MODE=local
DATABASE_URL=postgresql://atlas:atlas@localhost:5432/atlas
ATLAS_DEV_OWNER_EMAIL=zak@winnick.io
ATLAS_DEV_OWNER_NAME=Zak Winnick
ATLAS_DEV_OWNER_PASSWORD=replace-with-a-local-password-of-at-least-12-characters
```

For a local PostgreSQL 17 container, create a dedicated development volume and container once:

```bash
docker volume create atlas-v2-local-dev-db
docker run --name atlas-v2-local-db --detach \
  --publish 127.0.0.1:5432:5432 \
  --env POSTGRES_USER=atlas \
  --env POSTGRES_PASSWORD=atlas \
  --env POSTGRES_DB=atlas \
  --volume atlas-v2-local-dev-db:/var/lib/postgresql/data \
  postgres:17-bookworm
```

On later runs, start that exact container with:

```bash
docker start atlas-v2-local-db
```

Build the server tools, migrate, and explicitly seed the one local Rangeway owner:

```bash
npm run build
npm run db:migrate
npm run db:seed:development
```

The seed command compiles to `dist/server/platform/db/seed-development.js`. It migrates first, creates the human owner through `IdentityService`, hashes the password with Argon2id, and is safe to rerun with the same credentials. It refuses `NODE_ENV=production`, any environment other than `development`, and any auth mode other than `local`. Web and worker startup never seed implicitly. Do not set the development-owner variables in a production environment file.

Run the three local development processes in separate terminals:

```bash
npm run dev:server
```

```bash
npm run dev:worker
```

```bash
npm run dev:client
```

Open `http://localhost:5173`. `npm run dev` is a convenience command for web plus client; the worker still needs its own process.

## Authentication and actors

- **Human:** a real user with an organization membership. Local password login is available only with `AUTH_MODE=local` outside production and issues the canonical signed `rw_session` cookie. Production is constrained to Google Workspace mode. The first successful Workspace login links the provisioned user to Google's immutable subject; later email changes update that same identity, while recycled-email or subject-mismatch attempts are rejected.
- **Agent:** a named service actor such as Codex or Hermes. It uses its own one-time `atlas_…` bearer credential and never impersonates an unrecorded human.
- **Automation:** a non-human scheduled or event-driven actor. It also has its own bearer credential and distinct audit attribution.

An HTTP request may present one human session cookie or one Atlas bearer credential, never both. Every authenticated actor is organization-scoped and every mutation carries the actor and request ID into audit and outbox records.

Mutation routes that declare `Idempotency-Key` require a caller-generated key. Retrying the same operation, actor, organization, key, and request body returns the stored response without repeating business, audit, or outbox writes. Reusing that scope and key for a different request returns `409 CONFLICT`.

Production uses `ATLAS_ORIGIN` as the browser return origin and `GOOGLE_REDIRECT_URI` as the exact OAuth callback. Both must be HTTPS, the callback must use the same origin, and the callback path is `/api/auth/google/callback`.

## Verification commands

```bash
npm test
npm run typecheck
npm run build
npx --yes @redocly/cli lint openapi/atlas-v2.yaml
docker compose config >/dev/null
git diff --check
```

The smoke test is available directly with:

```bash
npm test -- tests/smoke/platform-foundation.test.ts
```

## Source documents and operator guides

- [Approved Atlas V2 design](docs/superpowers/specs/2026-08-02-atlas-v2-design.md)
- [Platform foundation implementation plan](docs/superpowers/plans/2026-08-02-atlas-v2-platform-foundation.md)
- [Atlas V2 OpenAPI contract](openapi/atlas-v2.yaml)
- [Operations runbook](docs/runbooks/atlas-v2-operations.md)
- [Restore-test runbook](docs/runbooks/atlas-v2-restore-test.md)

The deployment scripts are foundation artifacts, not deployment approval. Production deployment remains blocked by the warning at the top of this guide.
