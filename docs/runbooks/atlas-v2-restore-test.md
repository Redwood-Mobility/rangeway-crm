# Atlas V2 restore-test runbook

## Trust rule

**A backup is not trusted until a restore test succeeds.** File existence, a successful `pg_dump`, or a matching checksum alone is not recovery evidence.

This procedure is non-destructive: it restores into uniquely named temporary Docker volumes and a temporary PostgreSQL container. It must never target the live `atlas-db` or `atlas-artifacts` volumes. It does not authorize a live production restore.

## Prerequisites

- The exact backup directory emitted as `ATLAS_BACKUP_PATH=…` by `deploy/backup.sh`.
- Docker running, with permission to create temporary containers and volumes.
- `sha256sum`, `awk`, `sort`, `mktemp`, and `rmdir` available.
- An existing absolute temporary root other than `/`; the script defaults to `/tmp`.
- The backup directory must contain non-empty `atlas-postgres.dump`, `atlas-artifacts.tgz`, `metadata.txt`, and `manifest.sha256` files.
- The backup directory must be a narrow, resolved path such as `/var/backups/atlas-v2/20260802T210000Z-AbCd12`, never `/`, a user home directory, a live volume name, or an unresolved glob.

## Verify the manifest before restore

Replace the example directory with the exact `ATLAS_BACKUP_PATH` value; do not use a wildcard:

```bash
cd /var/backups/atlas-v2/20260802T210000Z-AbCd12
sha256sum --check manifest.sha256
```

Expected checksum evidence names exactly these three files and reports `OK` for each:

```text
atlas-postgres.dump: OK
atlas-artifacts.tgz: OK
metadata.txt: OK
```

The restore script repeats this verification and refuses manifests with missing or extra filenames.

## Exact restore-test command

Return to the deployed Atlas V2 repository and pass the exact backup directory as the only argument:

```bash
cd /opt/atlas-v2
ATLAS_RESTORE_TMP_ROOT=/var/tmp \
./deploy/restore-test.sh /var/backups/atlas-v2/20260802T210000Z-AbCd12
```

The script validates release provenance in the checksummed metadata, creates unique temporary database and artifact volumes, extracts the artifact archive, starts a temporary PostgreSQL 17 container, restores the custom dump with `pg_restore`, and removes its temporary containers, volumes, and work directory. A normal released backup must carry an exact 40-character commit and proves the expected migration row plus immutable Rangeway organization UUID `00000000-0000-4000-8000-000000000001`; the mutable organization display name is deliberately not part of restore validity. The one special `unreleased-v2-foundation` form is accepted only with `migration_provenance=zero` and a 64-character immutable migration-set hash, and its restored database must prove that the complete known application relation set is absent: `schema_migrations`, `organizations`, `users`, `actors`, `organization_memberships`, `audit_events`, `outbox_events`, and `api_idempotency_keys`.

## Required evidence

A passing record includes all of the following:

- The exact backup directory and its `metadata.txt` contents, including source Git commit and PostgreSQL image.
- The three successful checksum lines.
- Exit status `0` from `deploy/restore-test.sh`.
- `Restore test passed for <exact-directory>.`
- `Verified schema migration row, immutable Rangeway organization ID, and artifact archive extraction.`, or the exact zero-migration verification line for an authenticated `unreleased-v2-foundation` retry backup.
- Confirmation that the live `atlas-db` and `atlas-artifacts` volumes were not mounted, changed, renamed, or deleted.
- The operator, UTC date, and evidence location.

Any checksum mismatch, provenance mismatch, restore error, missing migration row, missing immutable Rangeway organization ID, non-empty unreleased database, artifact extraction error, or cleanup error fails the test. A changed organization display name does not. Quarantine a failed backup; do not repair its manifest or relabel it trusted. Create a new backup after correcting the underlying issue, then test that new artifact.

## Cadence and sign-off

Run and record a restore test:

- Immediately after the first approved Atlas V2 backup.
- At least quarterly thereafter, using a recent backup.
- After any material change to PostgreSQL, artifact storage, backup tooling, restore tooling, deployment topology, or retention policy.
- Before relying on a backup for an approved migration, deployment, or recovery decision.

Use one dated row per attempt; failed attempts remain in the record.

| Quarter / trigger | Backup directory | Source commit | Checksum evidence | Restore evidence | Operator | UTC date | Result |
|---|---|---|---|---|---|---|---|
| Initial approval | _exact path_ | _40-character commit_ | _evidence link_ | _evidence link_ | _name_ | YYYY-MM-DD | Pending |
| 2026 Q4 | _exact path_ | _40-character commit_ | _evidence link_ | _evidence link_ | _name_ | YYYY-MM-DD | Pending |

A quarter is unsigned until a named operator records a dated passing result with retained evidence. Backup retention must not convert an untested or failed artifact into a trusted one.
