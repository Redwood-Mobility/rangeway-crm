# Atlas V2 operations runbook

## Scope and deployment hold

This runbook covers the Atlas V2 platform foundation: `web`, `worker`, PostgreSQL, Caddy, backups, and non-destructive recovery decisions. Atlas V2 is not yet the complete operating-office UI. **Do not deploy it** until the equipped foundation gates, Operating Core, representative acceptance projects, and cutover are approved.

V1 remains preserved on `codex/atlas-v1-archive`. V1 data has not been migrated. Never point V2 at, delete, rename, or repurpose the V1 `crm-data` or `crm-uploads` volumes.

Run commands from the Atlas V2 repository root unless a command says otherwise. Use exact, narrow paths such as `/var/backups/atlas-v2`; never use `/`, a user home directory, the source tree, or an unresolved glob as a backup or restore target.

## Health checks

Use liveness only to determine whether the web process can answer HTTP:

```bash
curl --fail --silent --show-error http://127.0.0.1:8080/api/v2/health
```

Expected body:

```json
{"status":"ok","service":"atlas-web","apiVersion":"v2"}
```

Liveness does not prove database access, role grants, worker health, or release identity. Use readiness for deployment and traffic decisions:

```bash
curl --fail --silent --show-error http://127.0.0.1:8080/api/v2/ready
curl --fail --silent --show-error https://atlas.rangeway.app/api/v2/ready
```

The ready response must contain `status=ready`, `service=atlas-web`, `apiVersion=v2`, `contractVersion=atlas-v2-foundation-v1`, and the exact reviewed 40-character release SHA. It performs a bounded real database query and verifies `atlas_web@atlas`, exact `CONNECT`-only database access, exact `USAGE`-only `public` schema access, the required non-privileged role attributes with no inherited memberships, the exact required table and update-column privileges, the absence of table-wide update/delete/truncate/reference/trigger rights, and denial of immutable audit/outbox columns. Database failure or any identity/grant mismatch returns a stable, non-diagnostic `503 SERVICE_UNAVAILABLE` response.

Check Compose service and database health:

```bash
docker compose ps
docker compose exec -T db pg_isready --username=atlas --dbname=atlas
worker_container="$(docker compose ps -q worker)"
test -n "${worker_container}"
test "$(docker inspect --format '{{.State.Health.Status}}' "${worker_container}")" = healthy
```

Worker health executes a real database probe as `atlas_worker`, verifies the expected database, confirms only outbox read plus the eight delivery-state update columns, and confirms payload and immutable event columns remain denied. Healthy means the exact web readiness contract passes, PostgreSQL accepts connections, worker health is `healthy`, and `web`, `worker`, `db`, and `caddy` are running without a restart loop. The deployment verifier executes these same shared contracts as `atlas_migrator`, so readiness and release verification cannot drift into separate grant definitions.

## Logs and request tracing

Inspect a bounded window rather than following logs indefinitely:

```bash
docker compose logs --since=15m web worker db caddy
docker compose logs --since=2m worker
```

API responses include `X-Request-Id`. Search that UUID in web logs and match it to `audit_events.request_id` or `outbox_events.request_id`. Application error logs contain only the HTTP method, route path without query parameters, request ID, and allowlisted actor identifiers when available. They never intentionally record request bodies, query strings, session cookies, bearer keys, password hashes, environment files, or full private payloads. Treat any appearance of those values as a security incident rather than normal debugging evidence.

Repeated worker failures, terminal outbox events, migration checksum errors, unhealthy PostgreSQL, or an unexpected API version are stop conditions. Preserve logs and investigate before restarting or deploying.

## Migrations

Migration files under `db/migrations/` are immutable and checksum-protected. Never edit an applied migration or run an ad hoc down migration.

For local host processes after a build:

```bash
npm run build
npm run db:migrate
```

Production image builds, database-role rotation, and migrations are deployment-coordinator actions, not standalone maintenance commands. Run them only through the reviewed deployment entrypoint from the exact clean commit:

```bash
ATLAS_HOST=atlas-v2-host.example \
ATLAS_USER=root \
ATLAS_DIR=/opt/atlas-v2 \
ATLAS_BACKUP_ROOT=/var/backups/atlas-v2 \
ATLAS_ENV_FILE=/etc/atlas-v2/production.env \
./deploy/deploy.sh
```

Do not invoke the production image build, installed role initializer, or migrator directly. Doing so bypasses the durable token, exact database-session label, prior-release retention, compatibility boundary, process-tree cancellation, and guardian recovery contract.

The role script validates every credential before contacting PostgreSQL and applies all role password, ownership, function ownership, database/schema ownership, membership removal, and grant changes inside one SQL transaction. It transfers the `atlas` database, `public` schema, all migration-managed relations, and `atlas_reject_audit_mutation()` to `atlas_migrator`, including upgrades from earlier migration prefixes. PostgreSQL does not provide `ALTER EXTENSION ... OWNER`; therefore bootstrap role `atlas` intentionally retains ownership of `citext` and `pgcrypto`, while application roles receive no extension-management capability. Future tables and functions created under `atlas_migrator` remain migrator-owned. Additive migrations `0005_exact_runtime_permissions.sql` and `0006_exact_database_schema_privileges.sql`, together with the role initializer, revoke stale broad grants before applying the exact database, schema, role, membership, table, and column contracts.

The deployment path runs role rotation only after the explicit compatibility boundary, so any role-rotation or subsequent migration failure leaves old writers stopped. The migration runner serializes concurrent runs with a PostgreSQL advisory lock and is idempotent. `atlas_migrator` owns migration capability; `atlas_web` cannot access `schema_migrations`, and `atlas_worker` can only claim and finish outbox rows. Audit rows reject updates and deletes even from the table owner. Every production PostgreSQL URL must explicitly select `db:5432/atlas`; omitted or different ports fail before a pool is created. Before any approved production migration, create an exact backup and pass its restore test. If migration reports a checksum or history-prefix mismatch, stop; do not alter `schema_migrations` to force progress.

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

Backups contain both a PostgreSQL custom dump and the artifact archive. The installed helper does not load Compose or execute from the live release tree. It validates the exact `atlas-v2` Docker project plus distinct named `atlas-db` and `atlas-artifacts` volumes, discovers the one running database container through exact project/service labels, proves that container mounts the expected database volume, and requires it to be running without being paused or restarting. Before any mutation it inspects exact-label web, worker, and migrator containers; a paused container makes the backup fail closed and remain untouched. It then stops the exact web/worker IDs, finds and stops every exact-label `migrator`, and proves no matching writer remains. A migrator is never added to the restorable set. Unreleased zero-state provenance is queried only after that fence and immediately before the dump, inside the same quiesced interval. Database provenance and dumping run directly in the exact database container; the artifact archive mounts only the exact named artifact volume. The helper writes into a private pending directory, verifies non-empty artifacts, emits metadata and SHA-256 checksums, publishes one final directory atomically, and restarts only the exact web/worker IDs that were active at acquisition.

A standalone invocation non-blockingly acquires `/run/lock/atlas-v2-deployment.lock` and holds it through every discovery, stop, dump, archive, restart, failure cleanup, and exit. It also proves the guardian inactive and `/var/lib/atlas-v2-deployment/active.state` absent under the root-owned state lock. Refusal is mandatory during any prepared backup, migration, compatibility-boundary, recovered, failed-closed, or otherwise unresolved deployment state. During coordinator-managed backup, the guardian already owns the host lock, so the helper instead authenticates the complete exact token/action claim against root-owned durable state under the shared state lock: status and action phase must be `prepared`, action name must be `backup`, PID and systemd unit must match, the guardian must have acknowledged the same token, and the lease must remain live. There is no standalone bypass environment.

Prepare a narrow backup root once:

```bash
install -d -m 0700 -o root -g root /var/backups/atlas-v2
```

Invoke the installed backup helper with the exact trusted repository identity:

```bash
BACKUP_ROOT=/var/backups/atlas-v2 \
COMPOSE_PROJECT_NAME=atlas-v2 \
/usr/local/libexec/atlas-v2/backup.sh --repository-root /opt/atlas-v2
```

Capture the single `ATLAS_BACKUP_PATH=/var/backups/atlas-v2/<exact-directory>` output as evidence. Then perform the restore test in [the restore-test runbook](atlas-v2-restore-test.md). **A backup is untrusted until that restore test succeeds.**

`--repository-root` remains the release-provenance and backup-root separation boundary; it is not a Compose execution root. During an authenticated `unreleased-v2-foundation` retry, `/opt/atlas-v2` may be the restored empty prior tree. The immutable installed helper must still operate from exact Docker labels and named volumes before candidate promotion, without reading candidate or staged paths. Operators must not set the managed token/action variables manually; only the guarded coordinator child obtains a valid claim from the exact active state.

## Deployment procedure

This section documents the mechanism for a later approved release; it is not approval to deploy the current foundation.

### Operator and trust boundary

Bootstrap is run once as root from reviewed source on Ubuntu 24.04 LTS with systemd 255 or newer. Before package or filesystem mutation, bootstrap validates `/etc/os-release`, checks the systemd version, executes a disposable transient unit with `ExitType=cgroup` and `KillMode=control-group`, and proves that `--collect` left no unit loaded. It then creates root-owned `/opt/atlas-v2`, `/var/backups/atlas-v2`, `/var/lib/atlas-v2-deployment` (including its private staging directory), and the shared install-lock parent. It installs the coordinator at `/usr/local/sbin/atlas-v2-deployment-coordinator`, the guardian unit at `/etc/systemd/system/atlas-v2-deployment-guardian.service`, and immutable backup/restore tools under `/usr/local/libexec/atlas-v2/`. It creates no application operator, Docker-group membership, or delegated `sudo` policy. Restrict the root deployment key at the SSH and infrastructure layers and use it only for this reviewed ceremony.

Each release creates an immutable archive of the exact clean `HEAD`, copies the exact production environment file, hashes both, and transfers them with the reviewed coordinator, guardian unit, backup tool, restore-test tool, database-role initializer, and Caddy configuration into a unique root-private staging directory. The remote install holds `/run/lock/atlas-v2-deployment-install.lock` continuously across hash verification, atomic replacement of all six installed assets, systemd reload/loaded-unit verification, and coordinator `begin`. The role initializer and Caddy configuration are installed as root-owned stable-path assets under `/usr/local/libexec/atlas-v2`; no privileged configuration is executed or mounted from the mutable release tree. If installed bytes differ, replacement is allowed only when the guardian is inactive and no unresolved durable ownership exists. An authenticated `recovered` record is stopped, verified inactive, and durably archived under the same install lock before one retry; unknown, malformed, `recovery_failed`, or `failed_closed` state blocks replacement and admission. Never overwrite an installed operations asset in place.

1. Confirm the worktree is clean and the intended commit is reviewed.
2. Confirm all automated gates pass, including PostgreSQL integration tests with zero skips, OpenAPI lint, Compose resolution, Bash syntax, and YAML parsing.
3. Confirm the equipped foundation gates, Operating Core, representative acceptance projects, and cutover plan are approved.
4. Confirm the production environment file contains no placeholders; uses `NODE_ENV=production` and `AUTH_MODE=google`; provides distinct 24-128 character `POSTGRES_BOOTSTRAP_PASSWORD`, `ATLAS_MIGRATOR_PASSWORD`, `ATLAS_WEB_PASSWORD`, and `ATLAS_WORKER_PASSWORD` values using only letters, numbers, underscore, or hyphen; and contains no shared `DATABASE_URL`. `ATLAS_ORIGIN` and `GOOGLE_REDIRECT_URI` must be HTTPS, use the same origin, and the callback must end at `/api/auth/google/callback`. Development-owner and one-time production-owner variables must be absent.
5. Confirm the V1 archive and V1 volumes are intact.
6. Confirm bootstrap completed as root on Ubuntu 24.04 LTS/systemd 255 or newer and deployment access uses the restricted root administrator; confirm `/usr/local/sbin/atlas-v2-deployment-coordinator`, `/etc/systemd/system/atlas-v2-deployment-guardian.service`, `/usr/local/libexec/atlas-v2/{backup.sh,restore-test.sh,init-roles.sh,Caddyfile}`, `/var/lib/atlas-v2-deployment`, `/opt/atlas-v2`, and `/var/backups/atlas-v2` are root-owned with the documented modes. Confirm Docker and systemd are healthy. Deploy repeats the disposable transient-unit capability probe before remote staging or installation. If an Atlas V2 database already exists, the coordinator passes the exact `/opt/atlas-v2` provenance root to the immutable installed backup tool, which uses exact Docker labels and named volumes without requiring a live Compose file, and then runs the immutable installed restore-test tool against that exact `ATLAS_BACKUP_PATH` before candidate promotion or migration. Any missing or failed restore test stops deployment with the previous provenance and exact backup path. A first-ever deployment with no V2 database has no prior state to back up and may proceed without this pre-deploy restore step. If that first attempt creates a database volume but fails before the compatibility boundary, one automatic retry may back up and restore-prove it only as `unreleased-v2-foundation`: no `.atlas-release` or live Compose tree may exist, the database must prove the exact zero-migration state, and the manifest must carry the coordinator-recorded immutable migration-set hash.
7. Run the deploy script from the exact reviewed commit:

```bash
ATLAS_HOST=atlas-v2-host.example \
ATLAS_USER=root \
ATLAS_DIR=/opt/atlas-v2 \
ATLAS_BACKUP_ROOT=/var/backups/atlas-v2 \
ATLAS_ENV_FILE=/etc/atlas-v2/production.env \
./deploy/deploy.sh
```

The script validates the clean source tree, pairwise-distinct production database credentials, exact `:5432` database URLs, local gates, supported host, and exact canonical remote paths. The narrow secret-bearing local stage is protected by its cleanup trap immediately after creation, before archive, environment-copy, hashing, or transfer can fail. Transfer into the unique root-private remote token stage occurs before ownership and cannot mutate the live release. Archive, partial transfer, signal, or install failure before acquisition triggers constrained remote cleanup of only the exact generated UUID path; cleanup never scans a parent or logs staged contents. If SSH loses the `begin` response, the trap reads the root-owned durable state directly under the install and state locks to distinguish exact, other, or absent ownership; it never executes installed coordinator bytes during this inspection. The shared install/acquisition lock then verifies and installs the full immutable operations bundle and remains held through `begin`. The host-wide coordinator rejects any running exact-label migrator, captures the exact running web and worker containers through Docker project/service labels without depending on Compose or a release tree, persists an `activating` claim plus prior release provenance and every reviewed bundle/input and migration-set hash, starts the systemd guardian, and promotes the claim to `prepared` only after an acknowledgement for that same token. Failure to start, restart, or acknowledge the guardian leaves no `prepared` claim. A concurrent deploy is refused. For an existing V2 database the coordinator creates one backup with writers quiesced, records the exact path before running the non-destructive restore test, and stops before candidate promotion if the proof fails.

Before the compatibility boundary, an explicit failure or an expired lease makes the guardian restore the exact retained prior release tree and restart only the exact writers that were active at acquisition. `ATLAS_DEPLOYMENT_LEASE_SECONDS` defaults to 900 and may be set from 30 through 900 in production; two-second leases exist only in the isolated test harness. Backup, restore proof, whole-directory source/environment promotion, build/config validation, role rotation, migration, permission verification, writer start, target-bound readiness, worker health, public readiness, and exact release verification execute as coordinator-guarded actions. In production each action runs in a token-and-action-named transient systemd unit with `ExitType=cgroup` and `KillMode=control-group`; the portable test harness uses an equivalent recorded process-group reaper. An exact-token/exact-phase heartbeat renews the lease throughout every probe and retry, and ownership, phase, or lease loss terminates the verified cgroup, including descendants left after a direct leader exits. Cancellation removes only exact-token containers, fences any exact Atlas migrator, resolves the database through the exact running Compose project/service labels, terminates the exact `PGAPPNAME=atlas-deploy-<token>` sessions by direct container execution, and proves those sessions absent before clearing action identity. If no exact labeled database container exists, no database sessions can exist and cancellation performs no Compose call. Any ambiguous database container, direct query failure, or unproven process/container/session cleanup keeps recovery fail-closed. The coordinator also verifies the immutable operations-bundle hashes before every guarded or recovery action. Because the guardian is a boot-enabled systemd service with private host state and a real host-wide `flock`, it reconciles again after host restart and refuses overlap. Malformed or tampered state/bundle evidence stops all three writer classes and requires operator resolution rather than broad cleanup or a guessed restart.

In the durable `syncing` phase, the coordinator verifies the staged archive/environment hashes, extracts a complete candidate directory, installs the environment at mode `0600`, validates the installed hash, immediately removes the exact staged `atlas.env`, and atomically exchanges the complete candidate with `/opt/atlas-v2`; it never incrementally synchronizes a live mixed-version tree. The exact previous tree and its validated `.atlas-release` marker—or explicitly validated absence for unreleased zero state—remain at the token-specific retained path. A pre-boundary crash after the exchange restores that exact tree before any recovered writer starts. Only then does state become `synced`. The guarded pre-boundary build resolves Compose and starts real web, worker, and migrator configuration parsers inside their images; invalid production configuration fails before the compatibility boundary. The exact candidate commit becomes both the immutable image tag and `ATLAS_RELEASE_SHA`. The script durably moves coordinator state from `synced` to `boundary`, rotates all database roles from the hash-verified installed initializer with the exact token application name, migrates through the operations-only migrator with that same label, checks database/schema access, role attributes, inherited memberships, relation/function ownership, and the shared exact web/worker permission contracts, and starts services. Caddy is force-recreated so its stable-path bind uses the exact newly installed reviewed bytes. One guarded `verify-release` action then requires a healthy worker container and both target-bound and public DB-backed readiness responses with the exact API version, contract version, and candidate release while its heartbeat remains active. At and after the boundary, expiration or failure stops web, worker, and migrator containers and remains fail-closed on every reconciliation. Only after those proofs does the coordinator archive the retained prior tree, delete the remaining exact token stage, durably remove the candidate marker, publish `.atlas-release`, and write active state as complete. It then disables the guardian, proves the unit stopped and inactive, reacquires the lock, revalidates the same complete claim, and only then archives state with directory `fsync`; a guardian stop or inactivity-proof failure leaves the complete state active and blocks another deployment. Recovered-state retirement likewise archives its exact candidate evidence and deletes the remaining exact token stage. A stale `recovery_failed` or `failed_closed` record blocks another deployment pending explicit operator resolution.

Record the released commit, previous release provenance, exact backup path, guarded `VERIFIED_RELEASE=<40-character-commit>` evidence, migration rows, and service status in the change record.

## Rollback decision points

Rollback is manual and non-destructive. The deployment script deliberately does not auto-restore data.

- **Before durable acquisition:** immutable bundle transfer failure cannot change the live release or writers. The local trap removes only the exact generated remote token stage and reports if cleanup cannot be proved; do not use broad or glob-based cleanup.
- **After acquisition but before candidate promotion:** the coordinator guardian restores exactly the prior-active writer containers if backup preflight had quiesced them. Investigate the backup or restore-proof evidence.
- **During or after atomic promotion but before migration:** the same durable, boot-reconciled guardian terminates the recorded action cgroup, atomically restores the retained prior release tree and marker, and only then restores exactly the captured prior-active writers. An authenticated successful recovery is durably retired under the install lock before a later deployment is admitted.
- **At the compatibility boundary or afterward:** the guardian stops web, worker, and any one-off migrator and persists `failed_closed`. It repeats that exact-label stop on future reconciliation and never restarts old containers automatically. Review the exact backup, migration prefix, and failed release before choosing a forward fix or an operator-approved recovery.
- **After writes on the new release:** do not overwrite the live database. Preserve it, identify the exact pre-deploy backup, run the non-destructive restore test, and convene an operator-reviewed recovery decision.
- **Any V1/V2 ambiguity:** stop. Never attach a V2 service to a V1 volume and never treat the absence of V2 data as permission to migrate V1 implicitly.

For a reviewed code-only rollback, create a separate clean worktree at the exact previous commit and run the same deploy gate from there:

```bash
git worktree add /var/tmp/atlas-v2-rollback-<commit> <previous-40-character-commit>
cd /var/tmp/atlas-v2-rollback-<commit>
ATLAS_HOST=atlas-v2-host.example \
ATLAS_USER=root \
ATLAS_DIR=/opt/atlas-v2 \
ATLAS_BACKUP_ROOT=/var/backups/atlas-v2 \
ATLAS_ENV_FILE=/etc/atlas-v2/production.env \
./deploy/deploy.sh
```

Do not perform a live data restore from this runbook. The existing restore tool is intentionally a non-destructive test harness; a production data-recovery procedure requires explicit incident approval, preservation of the current state, and a separately reviewed command plan.
