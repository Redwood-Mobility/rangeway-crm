# Atlas production runbook

Live at **https://atlas.rangeway.app** since 2026-08-03.

## How it is deployed

Atlas is a **co-tenant** on `72.60.71.39`, the Rangeway public web server. That
host also serves roughly ten live sites through nginx, so Atlas does not own the
edge and must never contend for it.

| Thing | Value |
|---|---|
| Release tree | `/opt/atlas-v2` |
| Environment | `/opt/atlas-v2/.env` (mode 600) |
| Compose project | `atlas-v2` |
| Containers | `atlas-v2-db-1`, `atlas-v2-web-1`, `atlas-v2-worker-1` |
| Image | `atlas-v2-app:v2` |
| Bind address | `127.0.0.1:8081` — loopback only |
| Reverse proxy | nginx, `/etc/nginx/sites-available/atlas` |
| TLS | Let's Encrypt via certbot, auto-renewing |
| Volumes | `atlas-db`, `atlas-artifacts` |

Caddy is **not** running. It stays behind the `edge` Compose profile for a host
Atlas owns outright. Starting it here would fight nginx for 80/443 and take the
public sites down with it.

Atlas is unreachable from the internet except through nginx.

## Redeploying

`deploy/deploy.sh` is **not safe to use on this host** — see the known issue
below. Until that is resolved, redeploys are manual:

```bash
# From the worktree, build a clean archive. COPYFILE_DISABLE matters: macOS
# writes `._name.sql` sidecars that the migrator would otherwise read as SQL.
COPYFILE_DISABLE=1 tar czf /tmp/atlas-src.tgz \
  --exclude=node_modules --exclude=dist --exclude=.git --exclude=data \
  --exclude=uploads --exclude=artifacts --exclude='.env*' --exclude='._*' .
scp -i ~/.ssh/atlas_hostinger_ed25519 /tmp/atlas-src.tgz root@72.60.71.39:/tmp/

ssh -i ~/.ssh/atlas_hostinger_ed25519 root@72.60.71.39 '
  cd /opt/atlas-v2
  tar xzf /tmp/atlas-src.tgz -C /opt/atlas-v2
  find . -name "._*" -delete
  docker build -t atlas-v2-app:v2 .
  docker compose --profile operations run --rm migrator   # only if migrations changed
  docker compose up -d --force-recreate web worker
'
```

Verify afterwards:

```bash
curl -s https://atlas.rangeway.app/api/v2/ready
```

`.env` is never overwritten by this flow.

## Database access

Roles are least-privilege and distinct. `atlas_web` cannot run migrations;
`atlas_migrator` cannot serve traffic; `atlas_worker` may only update outbox
delivery columns.

```bash
cd /opt/atlas-v2 && set -a && . ./.env && set +a
docker exec -e PGPASSWORD="$POSTGRES_BOOTSTRAP_PASSWORD" atlas-v2-db-1 \
  psql -U atlas -d atlas
```

The bootstrap `atlas` superuser is for administration only. Nothing serving
traffic uses it.

## Identity

Sign-in is Google SSO restricted to `hd=rangeway.co`. Atlas independently
verifies the hosted domain, the audience against the client ID, and
`email_verified` before issuing a session.

The owner is `zak@rangeway.co`, provisioned unlinked and bound to a Google
subject on first verified sign-in. Both events are in `audit_events`.

To provision another owner, the confirmation phrase is required and the
`DATABASE_URL` must use `atlas_web`:

```bash
docker compose run --rm --no-deps \
  -e NODE_ENV=production -e AUTH_MODE=google \
  -e DATABASE_URL="postgresql://atlas_web:${ATLAS_WEB_PASSWORD}@db:5432/atlas" \
  -e GOOGLE_ALLOWED_DOMAIN=rangeway.co \
  -e ATLAS_PRODUCTION_OWNER_EMAIL=someone@rangeway.co \
  -e ATLAS_PRODUCTION_OWNER_NAME="Their Name" \
  -e ATLAS_PRODUCTION_OWNER_CONFIRM=PROVISION_ATLAS_PRODUCTION_OWNER \
  --entrypoint node web dist/server/platform/db/provision-production-owner.js
```

## Known issues

**The deployment coordinator is unreliable on this host.** The case
`cancels exact release verification and stops writers when boundary ownership is
lost` fails roughly two runs in three, in isolation, on Ubuntu 26.04 with
systemd 259. That behaviour is what stops a half-dead deploy from continuing to
write during a migration, so `deploy.sh` must not be used here until it is
understood. The coordinator is deploy automation only — nothing serving traffic
depends on it, which is why the manual path above is safe.

Everything else in `deployment-coordinator.test.ts` passes on this host,
including real `flock` mutual exclusion, real transient systemd cgroups, the
install lock, and concurrent-begin serialisation.

**Google Workspace sync is inert.** Sign-in works. Gmail, Drive and Calendar
indexing needs a per-user consent flow requesting `gmail.readonly`,
`drive.readonly` and `calendar.readonly`, plus token exchange, refresh and
encrypted storage behind the existing `credentialReference` boundary. None of
that exists yet. Everything downstream of it is built and tested against
recorded fixtures.

**No V1 data was imported.** A survey of this host found no Atlas V1 deployment
and no Atlas SQLite database. If one exists elsewhere, the importer is ready and
its dry-run writes nothing.

**No accessibility audit has been run.** No axe scan, no screen-reader pass.

## Nginx safety

The vhost lives alongside ten production sites. A broken config takes all of
them down, not just Atlas. Always:

```bash
nginx -t && systemctl reload nginx
```

If certbot ever rewrites the vhost, check that the 443 block still contains the
`proxy_pass` to `127.0.0.1:8081`. Certbot clones the HTTP block, which only
redirects — leaving a redirect loop. A working copy is committed at
`deploy/nginx/atlas.rangeway.app.conf`.

## Rollback

Atlas runs entirely in its own Compose project and named volumes. Stopping it
touches nothing else on the host:

```bash
cd /opt/atlas-v2 && docker compose down
rm -f /etc/nginx/sites-enabled/atlas && nginx -t && systemctl reload nginx
```

The public sites are unaffected by Atlas being up or down.
