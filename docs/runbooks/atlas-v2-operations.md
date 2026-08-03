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

For a manual maintenance window, initialize or rotate the three application-role credentials transactionally, then run migrations only through the operations profile:

```bash
docker compose build web worker
docker compose up -d db
docker compose exec -T db /docker-entrypoint-initdb.d/001-atlas-roles.sh
docker compose --profile operations run --rm migrator
```

The role script validates every credential before contacting PostgreSQL and applies all role password, ownership, and grant changes inside one SQL transaction. The deployment path runs it only after the explicit compatibility boundary, so any role-rotation or subsequent migration failure leaves old writers stopped. The migration runner serializes concurrent runs with a PostgreSQL advisory lock and is idempotent. `atlas_migrator` owns migration capability; `atlas_web` cannot access `schema_migrations`, and `atlas_worker` can only claim and finish outbox rows. Audit rows reject updates and deletes even from the table owner. Before any approved production migration, create an exact backup and pass its restore test. If migration reports a checksum or history-prefix mismatch, stop; do not alter `schema_migrations` to force progress.

## One-time production owner provisioning

Run this only after the approved production schema is migrated and before the intended owner attempts their first Google sign-in. Replace the example identity with the approved exact owner. Do not add these one-time fields to the persistent production environment file:

```bash
ATLAS_PRODUCTION_OWNER_EMAIL=owner@rangeway.energy \
ATLAS_PRODUCTION_OWNER_NAME='Approved Owner' \
ATLAS_PRODUCTION_OWNER_CONFIRM=PROVISION_ATLAS_PRODUCTION_OWNER \
docker compose run --rm --no-deps \
  -e ATLAS_PRODUCTION_OWNER_EMAIL \
  -e ATLAS_PRODUCTION_OWNER_NAME \
  -e ATLAS_PRODUCTION_OWNER_CONFIRM \
  web npm run db:provision:production-owner
```

Expected output is either `Atlas production owner provisioned. Google identity remains unlinked until verified sign-in.` or the exact-idempotent no-change message. The command refuses non-production or non-Google mode, a non-`atlas_web@db:5432/atlas` connection, an unsafe database password, a non-Workspace email, an explicit Google subject, a conflicting owner, or a conflicting email identity. User, actor, owner membership, audit evidence, and outbox evidence commit atomically. The outbox payload contains IDs and role only; private audit evidence contains the email and display name.

Verify one enabled owner, one provisioning audit row, and one matching outbox event without modifying any record:

```bash
docker compose exec -T db psql --username=atlas --dbname=atlas --command="SELECT u.email, a.display_name, m.role, u.google_subject IS NOT NULL AS google_linked FROM users u JOIN actors a ON a.user_id = u.id JOIN organization_memberships m ON m.organization_id = a.organization_id AND m.user_id = u.id WHERE a.type = 'human' AND m.role = 'owner';"
docker compose exec -T db psql --username=atlas --dbname=atlas --command="SELECT action, resource_type, request_id, created_at FROM audit_events WHERE action = 'identity.owner.provisioned' ORDER BY created_at DESC;"
docker compose exec -T db psql --username=atlas --dbname=atlas --command="SELECT event_type, aggregate_type, request_id, created_at FROM outbox_events WHERE event_type = 'identity.owner-provisioned.v1' ORDER BY created_at DESC;"
```

Before first sign-in, `google_linked` must be false. Only the public `/api/auth/google` redirect followed by the verified `/api/auth/google/callback` may link Google's immutable subject. A subject/email mismatch fails authentication and emits no identity-change evidence.

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

## Service-actor administration hold

The foundation has a guarded internal service boundary for creating and disabling agent and automation actors. It requires a current, enabled human owner in the same organization; persists the actor change, private audit evidence, and minimal outbox evidence atomically; and returns a new bearer secret only once. There is intentionally no public API or operator CLI for this boundary yet. Do not create service actors with direct SQL or repurpose the development seed. The operator ceremony for identity approval, secret custody, rotation, and emergency revocation is deferred to the Agent Platform milestone and must be reviewed before a management surface is exposed.

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
4. Confirm the production environment file contains no placeholders; uses `NODE_ENV=production` and `AUTH_MODE=google`; provides distinct 24-128 character `POSTGRES_BOOTSTRAP_PASSWORD`, `ATLAS_MIGRATOR_PASSWORD`, `ATLAS_WEB_PASSWORD`, and `ATLAS_WORKER_PASSWORD` values using only letters, numbers, underscore, or hyphen; and contains no shared `DATABASE_URL`. `ATLAS_ORIGIN` and `GOOGLE_REDIRECT_URI` must be HTTPS, use the same origin, and the callback must end at `/api/auth/google/callback`. Development-owner and one-time production-owner variables must be absent.
5. Confirm the V1 archive and V1 volumes are intact.
6. Confirm the bootstrap installed `/usr/local/sbin/atlas-v2-deployment-coordinator`, `atlas-v2-deployment-guardian.service`, and the private `/var/lib/atlas-v2-deployment` state directory. Confirm Docker and systemd are healthy. If an Atlas V2 database already exists, the deployment script must create an exact fresh backup and run the deployed `deploy/restore-test.sh` against that exact `ATLAS_BACKUP_PATH` before any source synchronization or migration. Any missing or failed restore test stops deployment with the previous commit and exact backup path. A first-ever deployment with no V2 database has no prior state to back up and may proceed without this pre-deploy restore step.
7. Run the deploy script from the exact reviewed commit:

```bash
ATLAS_HOST=atlas-v2-host.example \
ATLAS_USER=atlas \
ATLAS_DIR=/opt/atlas-v2 \
ATLAS_BACKUP_ROOT=/var/backups/atlas-v2 \
ATLAS_ENV_FILE=/etc/atlas-v2/production.env \
./deploy/deploy.sh
```

The script validates the clean source tree, pairwise-distinct production database credentials, local gates, and exact canonical remote paths. Its first remote release action asks the host-wide coordinator to acquire one durable token, capture the exact prior web and worker container set, persist the prior release marker, start the systemd guardian, and receive an acknowledgement for that same token. A concurrent deploy is refused. For an existing V2 database the script then creates one backup with writers quiesced, records the exact path in coordinator state before running the non-destructive restore test, and stops before synchronization if the proof fails.

Before the compatibility boundary, an explicit failure or an expired lease makes the guardian restart only the exact writers that were active at acquisition. `ATLAS_DEPLOYMENT_LEASE_SECONDS` defaults to 900 and may be set from 2 through 900 for a reviewed operation; the deployer renews between bounded stages. Because the guardian is a boot-enabled systemd service with private host state, it reconciles again after host restart. Malformed state stops all writers and requires operator resolution rather than broad cleanup or a guessed restart.

After synchronization and image build, the script atomically moves coordinator state from `quiesced` to `boundary`, rotates all database roles in one transaction, migrates through the operations-only migrator, starts the services, and verifies target-bound and public HTTPS health. At and after that boundary, expiration or failure stops web and worker and remains fail-closed on every reconciliation. Only after both health proofs does the coordinator atomically install `.atlas-release`, archive the completed state, and disable the guardian unit. A stale `recovery_failed` or `failed_closed` record blocks another deployment pending explicit operator resolution.

Record the released commit, previous commit, exact backup path, target-bound health response, public health response, migration rows, and service status in the change record.

## Rollback decision points

Rollback is manual and non-destructive. The deployment script deliberately does not auto-restore data.

- **Before synchronization:** the coordinator guardian restores exactly the prior-active writer containers if backup preflight had quiesced them. Investigate the local gate or preflight failure.
- **After synchronization but before migration:** the same durable, boot-reconciled guardian restores exactly the captured prior-active writers when the owner fails or the lease expires. Inspect synchronized source and failure evidence before retrying.
- **At the compatibility boundary or afterward:** the guardian stops web and worker and persists `failed_closed`. It repeats that stop on future reconciliation and never restarts old containers automatically. Review the exact backup, migration prefix, and failed release before choosing a forward fix or an operator-approved recovery.
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
