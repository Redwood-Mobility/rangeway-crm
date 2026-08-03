# Atlas V2 operations runbook

## Scope and deployment hold

This runbook covers the Atlas V2 platform foundation: `web`, `worker`, PostgreSQL, Caddy, backups, and non-destructive recovery decisions. Atlas V2 is not yet the complete operating-office UI. **Do not deploy it** until the equipped foundation gates, Operating Core, representative acceptance projects, and cutover are approved.

V1 remains preserved on `codex/atlas-v1-archive`. V1 data has not been migrated. Never point V2 at, delete, rename, or repurpose the V1 `crm-data` or `crm-uploads` volumes.

Run commands from the Atlas V2 repository root unless a command says otherwise. Use exact, narrow paths such as `/var/backups/atlas-v2`; never use `/`, a user home directory, the source tree, or an unresolved glob as a backup or restore target.

## Health checks

Check the V2 HTTP identity locally:

```bash
curl --fail --silent --show-error http://127.0.0.1:8080/api/v2/health
```

Expected body:

```json
{"status":"ok","service":"atlas-web","apiVersion":"v2"}
```

Check the production public boundary only after deployment is approved:

```bash
curl --fail --silent --show-error https://atlas.rangeway.app/api/v2/health
```

Check Compose service and database health:

```bash
docker compose ps
docker compose exec -T db pg_isready --username=atlas --dbname=atlas
```

Healthy means the HTTP response identifies `atlas-web` and `v2`, PostgreSQL accepts connections, and `web`, `worker`, `db`, and `caddy` are running without a restart loop.

## Logs and request tracing

Inspect a bounded window rather than following logs indefinitely:

```bash
docker compose logs --since=15m web worker db caddy
docker compose logs --since=2m worker
```

API responses include `X-Request-Id`. Search that UUID in web logs and match it to `audit_events.request_id` or `outbox_events.request_id`. Do not paste session cookies, bearer keys, password hashes, environment files, or full private payloads into tickets or chat.

Repeated worker failures, terminal outbox events, migration checksum errors, unhealthy PostgreSQL, or an unexpected API version are stop conditions. Preserve logs and investigate before restarting or deploying.

## Migrations

Migration files under `db/migrations/` are immutable and checksum-protected. Never edit an applied migration or run an ad hoc down migration.

For local host processes after a build:

```bash
npm run build
npm run db:migrate
```

For the Compose image:

```bash
docker compose build web
docker compose up -d db
docker compose run --rm web npm run db:migrate
```

The migration runner serializes concurrent runs with a PostgreSQL advisory lock and is idempotent. Before any approved production migration, create an exact backup and pass its restore test. If migration reports a checksum or history-prefix mismatch, stop; do not alter `schema_migrations` to force progress.

Inspect recorded migration evidence:

```bash
docker compose exec -T db psql --username=atlas --dbname=atlas --command="SELECT filename, checksum, applied_at FROM schema_migrations ORDER BY applied_at, filename;"
```

## Worker backlog and failed events

Summarize pending, leased, retrying, and terminal events:

```bash
docker compose exec -T db psql --username=atlas --dbname=atlas --command="SELECT count(*) FILTER (WHERE published_at IS NULL AND terminal_at IS NULL) AS pending, count(*) FILTER (WHERE processing_started_at IS NOT NULL) AS leased, count(*) FILTER (WHERE attempt_count > 0 AND terminal_at IS NULL AND published_at IS NULL) AS retrying, count(*) FILTER (WHERE terminal_at IS NOT NULL) AS terminal FROM outbox_events;"
```

Inspect safe failure metadata without printing payloads or credentials:

```bash
docker compose exec -T db psql --username=atlas --dbname=atlas --command="SELECT id, organization_id, event_type, aggregate_type, aggregate_id, attempt_count, available_at, terminal_at, left(coalesce(last_error, ''), 240) AS last_error FROM outbox_events WHERE published_at IS NULL AND (attempt_count > 0 OR terminal_at IS NOT NULL) ORDER BY updated_at DESC LIMIT 100;"
```

The worker uses leases, `FOR UPDATE SKIP LOCKED`, idempotency keys, exponential backoff, and a bounded terminal state. Do not manually mark an event published. Before any operator-reviewed retry, identify and correct the handler failure, confirm idempotency, preserve the original record, and document the event IDs and decision.

## Backup invocation

Backups contain both a PostgreSQL custom dump and the artifact archive. The script briefly stops only app services that were active, restarts that same subset, writes into a private pending directory, verifies non-empty artifacts, emits metadata and SHA-256 checksums, and publishes one final directory atomically.

Prepare a narrow backup root once:

```bash
sudo install -d -m 0700 -o atlas -g atlas /var/backups/atlas-v2
```

Invoke a backup from the deployed repository:

```bash
BACKUP_ROOT=/var/backups/atlas-v2 \
COMPOSE_PROJECT_NAME=atlas-v2 \
./deploy/backup.sh
```

Capture the single `ATLAS_BACKUP_PATH=/var/backups/atlas-v2/<exact-directory>` output as evidence. Then perform the restore test in [the restore-test runbook](atlas-v2-restore-test.md). **A backup is untrusted until that restore test succeeds.**

## Deployment procedure

This section documents the mechanism for a later approved release; it is not approval to deploy the current foundation.

1. Confirm the worktree is clean and the intended commit is reviewed.
2. Confirm all automated gates pass, including PostgreSQL integration tests with zero skips, OpenAPI lint, Compose resolution, Bash syntax, and YAML parsing.
3. Confirm the equipped foundation gates, Operating Core, representative acceptance projects, and cutover plan are approved.
4. Confirm the production environment file contains no placeholders, uses `NODE_ENV=production`, `AUTH_MODE=google`, an HTTPS `ATLAS_ORIGIN`, and a `DATABASE_URL` targeting `db:5432/atlas`. Development-owner seed variables must be absent.
5. Confirm the V1 archive and V1 volumes are intact.
6. If an Atlas V2 database already exists, the deployment script must create an exact fresh backup and run the deployed `deploy/restore-test.sh` against that exact `ATLAS_BACKUP_PATH` before any source synchronization or migration. Any missing or failed restore test stops deployment with the previous commit and exact backup path. A first-ever deployment with no V2 database has no prior state to back up and may proceed without this pre-deploy restore step.
7. Run the deploy script from the exact reviewed commit:

```bash
ATLAS_HOST=atlas-v2-host.example \
ATLAS_USER=atlas \
ATLAS_DIR=/opt/atlas-v2 \
ATLAS_BACKUP_ROOT=/var/backups/atlas-v2 \
ATLAS_ENV_FILE=/etc/atlas-v2/production.env \
./deploy/deploy.sh
```

The script validates the clean source tree, runs the local gates, resolves remote paths before mutation, backs up an existing V2 database, proves that exact backup with a non-destructive restore test, and only then synchronizes source without data or secrets, builds, migrates, starts the services, verifies target-bound and public HTTPS health, and records `.atlas-release`.

Record the released commit, previous commit, exact backup path, target-bound health response, public health response, migration rows, and service status in the change record.

## Rollback decision points

Rollback is manual and non-destructive. The deployment script deliberately does not auto-restore data.

- **Before synchronization:** stop. No remote application change should exist; investigate the local gate or preflight failure.
- **After synchronization but before migration:** inspect remote source and service state. A reviewed code-only redeploy of the previous recorded commit may be appropriate.
- **After migration:** do not assume the previous code is schema-compatible. Compare the migration prefix and application compatibility before a code-only rollback.
- **After writes on the new release:** do not overwrite the live database. Preserve it, identify the exact pre-deploy backup, run the non-destructive restore test, and convene an operator-reviewed recovery decision.
- **Any V1/V2 ambiguity:** stop. Never attach a V2 service to a V1 volume and never treat the absence of V2 data as permission to migrate V1 implicitly.

For a reviewed code-only rollback, create a separate clean worktree at the exact previous commit and run the same deploy gate from there:

```bash
git worktree add /var/tmp/atlas-v2-rollback-<commit> <previous-40-character-commit>
cd /var/tmp/atlas-v2-rollback-<commit>
ATLAS_HOST=atlas-v2-host.example \
ATLAS_USER=atlas \
ATLAS_DIR=/opt/atlas-v2 \
ATLAS_BACKUP_ROOT=/var/backups/atlas-v2 \
ATLAS_ENV_FILE=/etc/atlas-v2/production.env \
./deploy/deploy.sh
```

Do not perform a live data restore from this runbook. The existing restore tool is intentionally a non-destructive test harness; a production data-recovery procedure requires explicit incident approval, preservation of the current state, and a separately reviewed command plan.
