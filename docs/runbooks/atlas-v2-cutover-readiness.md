# Atlas V2 cutover readiness

Status as of the completion of Tasks 1–7. **No deployment has been attempted and
no DNS change has been made.**

This document states exactly what has been verified, what has not, and what must
happen before `atlas.rangeway.app` serves the new application.

## Verified on this machine

Against a live PostgreSQL 17 instance, with every migration applied in order:

| Gate | Result |
|---|---|
| Migrations `0001`–`0014` apply idempotently | pass |
| Migrations `0001`–`0013` byte-identical after later work | pass |
| Full test suite | 34 files, 434 passed, 5 skipped, 0 failed |
| `npm run typecheck` | pass |
| `npm run build` | pass |
| Redocly OpenAPI lint | pass |
| `npm audit --audit-level=high` | 0 vulnerabilities |
| Browser journeys | Today, Command Center, Projects, Project Room, Gates, Board, List, Calendar, Agents |
| Responsive | no horizontal overflow at 320 px; lanes stack rather than shrink |

Docker is now available through Colima (Docker 29.5.2, Ubuntu 24.04 guest), so
the Compose topology cases run: 33 pass, including the full five-service
topology once the `operations` profile is activated. The production image builds
and runs non-root as uid 1000 on Node 22.

The 5 remaining skips are all in `deploy/deployment-coordinator.test.ts` and
need a Linux `flock` and real systemd transient cgroups **on the host running the
tests**. Colima provides a Linux VM for containers, but the suite executes on
macOS, so these stay skipped here and must run on the Ubuntu VPS.
**No PostgreSQL test and no Compose test is skipped.**

## Blocked — cannot be completed from here

These are not incomplete work; they are gates that require resources this
machine does not have.

1. **Host-level systemd and `flock`.** Five deployment-coordinator cases need
   them on the test host. They can only run on the Ubuntu VPS.
2. **Google OAuth credentials.** `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` and
   `GOOGLE_REDIRECT_URI` for `atlas.rangeway.app` have not been issued. Google
   sign-in is therefore unverified end to end. The Workspace integration is built
   and tested against recorded fixtures; a real mailbox has never been contacted.
3. **The VPS.** No deployment, backup rehearsal, restore rehearsal or TLS check
   has been run against `72.60.71.39`. Docker is not installed there.
4. **Production V1 data — location unknown.** The local
   `data/rangeway-crm.sqlite` holds one user and no records, and a survey of
   `72.60.71.39` found no Atlas deployment and no Atlas SQLite file anywhere on
   it. If a production V1 exists it is on a host not yet identified; if it never
   shipped, there is nothing to import and step 4 below is a no-op.

## The target host is shared

`72.60.71.39` is the Rangeway public web server, not a dedicated Atlas host. A
survey on 2026-08-03 found nginx serving roughly ten live sites on 80/443 —
`rangeway-pages`, `rangeway-investors`, `rangeway-newsroom`, `rangeway-mojave`,
`rangeway-hawaii`, `rangeway-bozeman`, `pathfinder-pages`, `ChargeVia`,
`current-mile-group` — plus a `rangeway-survey` Node application. It runs
Ubuntu 26.04 with systemd 259 and `flock`, and has 91 GB free.

Atlas therefore deploys **co-tenant**:

- Caddy moved behind the `edge` Compose profile. It is not started here, because
  contending for 80/443 would put every other Rangeway site at risk.
- `web` publishes on `127.0.0.1:${ATLAS_BIND_PORT:-8081}` only. Atlas is never
  directly reachable from outside the host.
- nginx fronts it through `deploy/nginx/atlas.rangeway.app.conf`, terminating
  TLS with the existing Let's Encrypt setup and forwarding with
  `X-Forwarded-Proto: https` so Secure cookies and OAuth redirects resolve.
- `deploy.sh` accepts Ubuntu 24.04 or 26.04. The systemd transient-unit probe
  remains the real gate on host suitability.

The `edge` profile keeps the original standalone topology intact and tested, so
moving Atlas to its own host later needs no code change.

**Installing Docker on this host is a change to a server running live public
sites.** It has not been done, and should happen during a window where a brief
nginx reload is acceptable.

## Required order for cutover

Each step must pass before the next begins.

1. Run the full suite on the Ubuntu VPS, where the five coordinator cases can
   execute. Any remaining skip must be explained, not accepted.
2. Issue Google OAuth credentials for the production origin and verify sign-in
   against the deployed application.
3. Back up the preserved V1 volumes if a V1 deployment is located —
   `rangeway-crm_crm-data` and `rangeway-crm_crm-uploads` — and prove the backup
   restores. A backup that has not been restored is not a backup.
4. Run the importer with `apply: false` against the production V1 database.
   Review the plan by hand: every conflict, every unmapped-vocabulary warning,
   and every record that would be created. Nothing about this step is automatic.
5. Only after that review, run the import with `apply: true`.
6. Deploy the exact reviewed commit. Verify TLS, Google sign-in, a project
   mutation, agent attribution, and a PDF render against the deployed release.
7. Install the nginx vhost, run `nginx -t`, issue the certificate with certbot,
   and reload. A broken config here takes down every Rangeway site on the host,
   not just Atlas.
8. Switch DNS for `atlas.rangeway.app` last.

## Rollback

The V1 application is preserved on `codex/atlas-v1-archive` and its Docker
volumes are untouched by anything in Tasks 1–7. The importer opens the V1
database read-only, which is proven by a test comparing row counts before and
after a full import. Rollback is: point DNS back and start the V1 containers.

Keep this path available until the validation period is explicitly closed.

## Honest limitations to carry into production

- **Google Workspace has never contacted Google.** Sync, incremental history
  tokens and permission reflection are proven against recorded fixtures. The
  first real sync is the first real test.
- **PDF rendering is deterministic but typographically plain.** It uses the
  standard PDF fonts and a single-column layout. It is correct and readable, not
  designed.
- **No accessibility audit has been run.** Semantics, focus, contrast, reduced
  motion and keyboard operation were built to the declared contract and
  spot-checked, but no axe scan and no screen-reader pass has happened.
- **Report narrative is authored by a person.** Nothing generates prose from
  operating data yet; the builder freezes the data and a human writes the
  narrative before approval.
