import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const sourceRoot = path.resolve(import.meta.dirname, "../..");
const temporaryRoots: string[] = [];
const releaseCommit = "a".repeat(40);

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function temporaryDirectory(prefix: string): string {
  const root = mkdtempSync(path.join(os.tmpdir(), prefix));
  temporaryRoots.push(root);
  return root;
}

function executable(filename: string, source: string): void {
  writeFileSync(filename, source, { mode: 0o755 });
  chmodSync(filename, 0o755);
}

function fakeTool(binDirectory: string, name: string, body: string): void {
  executable(path.join(binDirectory, name), `#!/usr/bin/env bash\nset -euo pipefail\n${body}\n`);
}

function productionEnvironment(): string {
  return [
    "NODE_ENV=production",
    "POSTGRES_PASSWORD=correct-horse-battery-staple",
    "DATABASE_URL=postgresql://atlas:correct-horse-battery-staple@db:5432/atlas",
    "SESSION_SECRET=a-production-session-secret-at-least-32-characters",
    "ATLAS_ORIGIN=https://atlas.rangeway.app",
    "AUTH_MODE=google",
    "GOOGLE_CLIENT_ID=test-client",
    "GOOGLE_CLIENT_SECRET=test-secret",
    "GOOGLE_REDIRECT_URI=https://atlas.rangeway.app/api/auth/google/callback",
    "",
  ].join("\n");
}

type DeployFixture = {
  root: string;
  repository: string;
  remoteDirectory: string;
  backupRoot: string;
  environmentFile: string;
  binDirectory: string;
  logDirectory: string;
};

function createDeployFixture(): DeployFixture {
  const root = temporaryDirectory("atlas-deploy-test-");
  const repository = path.join(root, "repository");
  const remoteDirectory = path.join(root, "remote", "app");
  const backupRoot = path.join(root, "remote-backups");
  const binDirectory = path.join(root, "bin");
  const logDirectory = path.join(root, "logs");
  mkdirSync(path.join(repository, "deploy"), { recursive: true });
  mkdirSync(path.join(repository, "openapi"), { recursive: true });
  mkdirSync(path.join(repository, "nested"), { recursive: true });
  mkdirSync(binDirectory, { recursive: true });
  mkdirSync(logDirectory, { recursive: true });
  copyFileSync(path.join(sourceRoot, "deploy/deploy.sh"), path.join(repository, "deploy/deploy.sh"));
  chmodSync(path.join(repository, "deploy/deploy.sh"), 0o755);
  writeFileSync(path.join(repository, "package.json"), "{}\n");
  writeFileSync(path.join(repository, "openapi/atlas-v2.yaml"), "openapi: 3.1.0\n");
  const environmentFile = path.join(repository, ".env.production");
  writeFileSync(environmentFile, productionEnvironment());
  writeFileSync(path.join(repository, ".env.secret"), "DO_NOT_SYNC=one\n");
  writeFileSync(path.join(repository, "nested/.env.development"), "DO_NOT_SYNC=two\n");

  fakeTool(binDirectory, "git", `
case "$*" in
  "diff --quiet"|"diff --cached --quiet") exit 0 ;;
  "status --porcelain --untracked-files=normal") exit 0 ;;
  "rev-parse --verify HEAD") printf '%s\\n' '${releaseCommit}'; exit 0 ;;
esac
exit 0`);
  fakeTool(binDirectory, "npm", "exit 0");
  fakeTool(binDirectory, "npx", "exit 0");
  fakeTool(binDirectory, "realpath", `
mode=physical
if [[ "\${1:-}" == "-m" ]]; then mode=missing; shift; fi
[[ "\${1:-}" == "--" ]] && shift
/usr/bin/ruby -e 'mode, target = ARGV; puts(mode == "missing" ? File.expand_path(target) : File.realpath(target))' "\${mode}" "$1"`);
  fakeTool(binDirectory, "rsync", `
counter_file="\${FAKE_LOG_DIR}/rsync-counter"
counter=0
[[ -f "\${counter_file}" ]] && counter="$(< "\${counter_file}")"
counter=$((counter + 1))
printf '%s\\n' "\${counter}" > "\${counter_file}"
printf '%s\\n' "$@" > "\${FAKE_LOG_DIR}/rsync-\${counter}.args"
[[ "\${FAKE_RSYNC_FAIL_ON:-}" == "\${counter}" ]] && exit 42
exit 0`);
  fakeTool(binDirectory, "curl", `
printf '%s\\n' "$*" >> "\${FAKE_LOG_DIR}/curl.log"
if [[ "$*" == *"--resolve atlas.rangeway.app:443:127.0.0.1"* ]]; then
  [[ "\${FAKE_TARGET_HEALTH_FAIL:-0}" == "1" ]] && printf '%s\\n' '{"apiVersion":"v1"}' || printf '%s\\n' '{"apiVersion":"v2"}'
else
  [[ "\${FAKE_PUBLIC_HEALTH_FAIL:-0}" == "1" ]] && printf '%s\\n' '{"apiVersion":"v1"}' || printf '%s\\n' '{"apiVersion":"v2"}'
fi`);
  fakeTool(binDirectory, "sha256sum", `
if [[ "\${1:-}" == "--check" ]]; then
  shift
  /usr/bin/shasum -a 256 -c "$@"
else
  /usr/bin/shasum -a 256 "$@"
fi`);
  fakeTool(binDirectory, "docker", `
printf '%s\\n' "$*" >> "\${FAKE_LOG_DIR}/docker.log"
if [[ "$*" == "volume inspect atlas-db" ]]; then
  [[ "\${FAKE_HAS_DB:-0}" == "1" ]] && exit 0 || exit 1
fi
if [[ "$*" == "compose ps -q db" ]]; then printf '%s\\n' db-container; exit 0; fi
if [[ "$*" == *"State.Health.Status"* ]]; then printf '%s\\n' healthy; exit 0; fi
exit 0`);
  fakeTool(binDirectory, "ssh", `
printf '%s\\n' "$*" >> "\${FAKE_LOG_DIR}/ssh.log"
while [[ "\${1:-}" == -* ]]; do
  case "$1" in -o|-i) shift 2 ;; *) shift ;; esac
done
shift
if [[ "$#" -eq 1 ]]; then
  /bin/bash -c "$1"
  exit $?
fi
if [[ "\${1:-}" == "bash" && "\${2:-}" == "-s" && "\${3:-}" == "--" ]]; then
  shift 3
  script_file="$(mktemp "\${TMPDIR:-/tmp}/atlas-fake-ssh.XXXXXX")"
  /bin/cat > "\${script_file}"
  {
    printf '%s\\n' '--- remote script ---'
    /bin/cat "\${script_file}"
  } >> "\${FAKE_LOG_DIR}/ssh-scripts.log"
  if [[ -n "\${FAKE_REMOTE_SYMLINK_OUTPUT:-}" ]] && /usr/bin/grep -q "REMOTE_DIR=%s" "\${script_file}"; then
    printf '%b' "\${FAKE_REMOTE_SYMLINK_OUTPUT}"
    status=0
  else
    /bin/bash "\${script_file}" "$@"
    status=$?
  fi
  /bin/unlink "\${script_file}"
  exit "\${status}"
fi
exit 64`);

  return { root, repository, remoteDirectory, backupRoot, environmentFile, binDirectory, logDirectory };
}

function deploy(fixture: DeployFixture, overrides: NodeJS.ProcessEnv = {}) {
  return spawnSync("/bin/bash", [path.join(fixture.repository, "deploy/deploy.sh")], {
    cwd: fixture.repository,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${fixture.binDirectory}:${process.env.PATH}`,
      FAKE_LOG_DIR: fixture.logDirectory,
      ATLAS_HOST: "atlas-test-host",
      ATLAS_USER: "atlas",
      ATLAS_DIR: fixture.remoteDirectory,
      ATLAS_BACKUP_ROOT: fixture.backupRoot,
      ATLAS_ENV_FILE: fixture.environmentFile,
      ...overrides,
    },
  });
}

function installRemoteBackup(fixture: DeployFixture): string {
  mkdirSync(path.join(fixture.remoteDirectory, "deploy"), { recursive: true });
  writeFileSync(path.join(fixture.remoteDirectory, ".atlas-release"), `${releaseCommit}\n`);
  const exactBackup = path.join(fixture.backupRoot, "20260802T200000Z-exact");
  executable(path.join(fixture.remoteDirectory, "deploy/backup.sh"), `#!/usr/bin/env bash
set -euo pipefail
ATLAS_BACKUP_FORMAT="atlas-v2-postgres-artifacts-v1"
exact='${exactBackup}'
mkdir -p "\${exact}"
printf dump > "\${exact}/atlas-postgres.dump"
printf artifacts > "\${exact}/atlas-artifacts.tgz"
printf metadata > "\${exact}/metadata.txt"
(cd "\${exact}" && sha256sum atlas-postgres.dump atlas-artifacts.tgz metadata.txt > manifest.sha256)
printf 'ATLAS_BACKUP_PATH=%s\\n' "\${exact}"
`);
  return exactBackup;
}

describe("deploy.sh behavior", () => {
  it("rejects a canonical backup root inside the synchronized remote tree before SSH", () => {
    const fixture = createDeployFixture();
    const result = deploy(fixture, {
      ATLAS_BACKUP_ROOT: path.join(fixture.remoteDirectory, "../app/backups"),
    });

    expect(result.status).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toMatch(/backup.*outside|synchronized/i);
    expect(existsSync(path.join(fixture.logDirectory, "ssh.log"))).toBe(false);
  });

  it("accepts an outside custom backup root and excludes all environment sources from tree sync", () => {
    const fixture = createDeployFixture();
    const result = deploy(fixture);


    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    const treeSync = readFileSync(path.join(fixture.logDirectory, "rsync-1.args"), "utf8");
    const secretSync = readFileSync(path.join(fixture.logDirectory, "rsync-2.args"), "utf8");
    expect(treeSync).toContain(".env\n");
    expect(treeSync).toContain(".env.*\n");
    expect(treeSync).toContain("/.env.production\n");
    expect(secretSync).toContain(`${realpathSync(fixture.environmentFile)}\n`);
    expect(secretSync).toContain(`${fixture.remoteDirectory}/.env\n`);
    expect(secretSync).toContain("--chmod=F600\n");
    expect(readFileSync(path.join(fixture.logDirectory, "curl.log"), "utf8")).toMatch(
      /--noproxy \* .*--resolve atlas\.rangeway\.app:443:127\.0\.0\.1/,
    );
  });

  it("rejects unsafe canonical paths returned through a remote symlink before mutation", () => {
    const fixture = createDeployFixture();
    const result = deploy(fixture, {
      FAKE_REMOTE_SYMLINK_OUTPUT:
        "REMOTE_DIR=/opt/atlas v2\nREMOTE_BACKUP_ROOT=/var/backups/atlas-v2\n",
    });

    expect(result.status).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toMatch(/unsupported|canonical|deployment paths/i);
    expect(readFileSync(path.join(fixture.logDirectory, "ssh.log"), "utf8").trim().split("\n")).toHaveLength(1);
    expect(existsSync(path.join(fixture.logDirectory, "docker.log"))).toBe(false);
    expect(existsSync(path.join(fixture.logDirectory, "rsync-counter"))).toBe(false);
    expect(existsSync(fixture.remoteDirectory)).toBe(false);
  });

  it("rejects duplicate canonical path keys before mutation", () => {
    const fixture = createDeployFixture();
    const result = deploy(fixture, {
      FAKE_REMOTE_SYMLINK_OUTPUT: [
        `REMOTE_DIR=${fixture.remoteDirectory}`,
        `REMOTE_DIR=${fixture.remoteDirectory}-duplicate`,
        `REMOTE_BACKUP_ROOT=${fixture.backupRoot}`,
        "",
      ].join("\n"),
    });

    expect(result.status).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toMatch(/exactly once|canonical|deployment paths/i);
    expect(readFileSync(path.join(fixture.logDirectory, "ssh.log"), "utf8").trim().split("\n")).toHaveLength(1);
    expect(existsSync(path.join(fixture.logDirectory, "rsync-counter"))).toBe(false);
  });

  it("prints exact recovery evidence after a post-backup failure without changing the release marker", () => {
    const fixture = createDeployFixture();
    const exactBackup = installRemoteBackup(fixture);
    const result = deploy(fixture, { FAKE_HAS_DB: "1", FAKE_RSYNC_FAIL_ON: "1" });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(`Previous Git commit: ${releaseCommit}`);
    expect(result.stderr).toContain(`Exact pre-deploy backup: ${exactBackup}`);
    expect(result.stderr).toMatch(/No rollback was run automatically/i);
    expect(readFileSync(path.join(fixture.remoteDirectory, ".atlas-release"), "utf8").trim()).toBe(releaseCommit);
  });

  it("does not install a release marker when target-bound health fails", () => {
    const fixture = createDeployFixture();
    const result = deploy(fixture, { FAKE_TARGET_HEALTH_FAIL: "1" });

    expect(result.status).not.toBe(0);
    expect(existsSync(path.join(fixture.remoteDirectory, ".atlas-release"))).toBe(false);
    expect(readFileSync(path.join(fixture.logDirectory, "curl.log"), "utf8")).toMatch(
      /--resolve atlas\.rangeway\.app:443:127\.0\.0\.1/,
    );
  });

  it("does not install a release marker when public health fails after target health passes", () => {
    const fixture = createDeployFixture();
    const result = deploy(fixture, { FAKE_PUBLIC_HEALTH_FAIL: "1" });

    expect(result.status).not.toBe(0);
    expect(existsSync(path.join(fixture.remoteDirectory, ".atlas-release"))).toBe(false);
    const healthCalls = readFileSync(path.join(fixture.logDirectory, "curl.log"), "utf8")
      .trim()
      .split("\n");
    expect(healthCalls).toHaveLength(2);
    expect(healthCalls[0]).toContain("--resolve atlas.rangeway.app:443:127.0.0.1");
    expect(healthCalls[1]).not.toContain("--resolve");
  });
});

type BackupFixture = {
  root: string;
  repository: string;
  backupRoot: string;
  binDirectory: string;
  logDirectory: string;
};

function createBackupFixture(): BackupFixture {
  const root = temporaryDirectory("atlas-backup-test-");
  const repository = path.join(root, "repository");
  const backupRoot = path.join(root, "backups");
  const binDirectory = path.join(root, "bin");
  const logDirectory = path.join(root, "logs");
  mkdirSync(path.join(repository, "deploy"), { recursive: true });
  mkdirSync(binDirectory, { recursive: true });
  mkdirSync(logDirectory, { recursive: true });
  copyFileSync(path.join(sourceRoot, "deploy/backup.sh"), path.join(repository, "deploy/backup.sh"));
  chmodSync(path.join(repository, "deploy/backup.sh"), 0o755);
  writeFileSync(path.join(repository, "docker-compose.yml"), "name: atlas-v2\nservices: {}\n");

  fakeTool(binDirectory, "git", `
if [[ "$*" == "rev-parse --is-inside-work-tree" ]]; then exit 0; fi
if [[ "$*" == "rev-parse --verify HEAD" ]]; then printf '%s\\n' '${releaseCommit}'; exit 0; fi
exit 0`);
  fakeTool(binDirectory, "sha256sum", `
[[ "\${FAKE_FAIL_STAGE:-}" == "checksum" ]] && exit 51
/usr/bin/shasum -a 256 "$@"`);
  fakeTool(binDirectory, "docker", `
printf '%s\\n' "$*" >> "\${FAKE_LOG_DIR}/docker.log"
last_argument=""
for argument in "$@"; do last_argument="\${argument}"; done
if [[ "$*" == "compose ps -q db" ]]; then printf '%s\\n' db-container; exit 0; fi
if [[ "$*" == *"compose ps"* && ( "\${last_argument}" == "web" || "\${last_argument}" == "worker" ) ]]; then
  requested_status=""
  previous_argument=""
  for argument in "$@"; do
    [[ "\${previous_argument}" == "--status" ]] && requested_status="\${argument}"
    previous_argument="\${argument}"
  done
  [[ "\${FAKE_PROBE_FAIL:-}" == "\${last_argument}:\${requested_status}" ]] && exit 55
  case "\${last_argument}" in
    web) service_state="\${FAKE_WEB_STATE:-running}" ;;
    worker) service_state="\${FAKE_WORKER_STATE:-running}" ;;
  esac
  [[ "\${service_state}" == "\${requested_status}" ]] && printf '%s\\n' "\${last_argument}-container"
  exit 0
fi
if [[ "$*" == *"State.Running"* ]]; then printf '%s\\n' true; exit 0; fi
if [[ "$*" == *"Config.Image"* ]]; then printf '%s\\n' postgres:17-bookworm; exit 0; fi
if [[ "$*" == "volume inspect atlas-artifacts" ]]; then exit 0; fi
if [[ "$*" == *"compose exec"* && "$*" == *"pg_dump"* ]]; then
  [[ "\${FAKE_FAIL_STAGE:-}" == "pg_dump" ]] && exit 52
  printf '%s' dump
  exit 0
fi
if [[ "\${1:-}" == "run" ]]; then
  [[ "\${FAKE_FAIL_STAGE:-}" == "tar" ]] && exit 53
  backup_mount=""
  for argument in "$@"; do [[ "\${argument}" == *:/backup ]] && backup_mount="\${argument%:/backup}"; done
  [[ -n "\${backup_mount}" ]] || exit 54
  printf '%s' artifacts > "\${backup_mount}/atlas-artifacts.tgz"
  exit 0
fi
exit 0`);
  return { root, repository, backupRoot, binDirectory, logDirectory };
}

function backup(fixture: BackupFixture, overrides: NodeJS.ProcessEnv = {}) {
  return spawnSync("/bin/bash", [path.join(fixture.repository, "deploy/backup.sh")], {
    cwd: fixture.repository,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${fixture.binDirectory}:${process.env.PATH}`,
      FAKE_LOG_DIR: fixture.logDirectory,
      BACKUP_ROOT: fixture.backupRoot,
      ATLAS_GIT_COMMIT: releaseCommit,
      ...overrides,
    },
  });
}

describe("backup.sh behavior", () => {
  it("rejects a canonical backup root inside the synchronized repository before mutation", () => {
    const fixture = createBackupFixture();
    const nestedBackup = path.join(fixture.repository, "nested", "..", "backups");
    const result = backup(fixture, { BACKUP_ROOT: nestedBackup });

    expect(result.status).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toMatch(/source directory|outside/i);
    expect(existsSync(path.join(fixture.repository, "backups"))).toBe(false);
    expect(existsSync(path.join(fixture.logDirectory, "docker.log"))).toBe(false);
  });

  it("stops web then worker, publishes one exact backup, and restarts only after the manifest", () => {
    const fixture = createBackupFixture();
    const result = backup(fixture);

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toMatch(/^ATLAS_BACKUP_PATH=\/.*\n$/);
    const exactBackup = result.stdout.trim().slice("ATLAS_BACKUP_PATH=".length);
    expect(existsSync(path.join(exactBackup, "manifest.sha256"))).toBe(true);
    const log = readFileSync(path.join(fixture.logDirectory, "docker.log"), "utf8");
    const stopWeb = log.indexOf("compose stop web");
    const stopWorker = log.indexOf("compose stop worker");
    const dump = log.indexOf("pg_dump");
    const archive = log.indexOf("run --rm");
    const startWorker = log.indexOf("compose start worker");
    const startWeb = log.indexOf("compose start web");
    expect(stopWeb).toBeGreaterThanOrEqual(0);
    expect(stopWorker).toBeGreaterThan(stopWeb);
    expect(dump).toBeGreaterThan(stopWorker);
    expect(archive).toBeGreaterThan(dump);
    expect(startWorker).toBeGreaterThan(archive);
    expect(startWeb).toBeGreaterThan(startWorker);
    expect(log).not.toMatch(/compose (?:stop|start) (?:db|caddy)/);
  });

  it("aborts on a service-state probe failure before stopping or backing up", () => {
    const fixture = createBackupFixture();
    const result = backup(fixture, { FAKE_PROBE_FAIL: "worker:restarting" });

    expect(result.status).not.toBe(0);
    expect(result.stdout).not.toContain("ATLAS_BACKUP_PATH=");
    const log = readFileSync(path.join(fixture.logDirectory, "docker.log"), "utf8");
    expect(log).toContain("compose ps --status restarting -q worker");
    expect(log).not.toMatch(/compose stop|pg_dump|compose start/);
    expect(existsSync(fixture.backupRoot) ? readdirSync(fixture.backupRoot) : []).toEqual([]);
  });

  it("treats restarting as active, restores only that service after failure, and removes partial output", () => {
    const fixture = createBackupFixture();
    const result = backup(fixture, {
      FAKE_WEB_STATE: "stopped",
      FAKE_WORKER_STATE: "restarting",
      FAKE_FAIL_STAGE: "pg_dump",
    });

    expect(result.status).not.toBe(0);
    expect(result.stdout).not.toContain("ATLAS_BACKUP_PATH=");
    const log = readFileSync(path.join(fixture.logDirectory, "docker.log"), "utf8");
    expect(log).toContain("compose stop worker");
    expect(log).toContain("compose start worker");
    expect(log).not.toContain("compose stop web");
    expect(log).not.toContain("compose start web");
    expect(readdirSync(fixture.backupRoot)).toEqual([]);
  });

  it.each(["pg_dump", "tar", "checksum"])(
    "restarts the originally running app services and publishes nothing when %s fails",
    (failureStage) => {
      const fixture = createBackupFixture();
      const result = backup(fixture, { FAKE_FAIL_STAGE: failureStage });

      expect(result.status).not.toBe(0);
      expect(result.stdout).not.toContain("ATLAS_BACKUP_PATH=");
      const log = readFileSync(path.join(fixture.logDirectory, "docker.log"), "utf8");
      expect(log).toContain("compose start worker");
      expect(log).toContain("compose start web");
      expect(readdirSync(fixture.backupRoot)).toEqual([]);
    },
  );

  it("restarts exactly the app services that were running before backup", () => {
    const fixture = createBackupFixture();
    const result = backup(fixture, { FAKE_WORKER_STATE: "stopped" });

    expect(result.status, result.stderr).toBe(0);
    const log = readFileSync(path.join(fixture.logDirectory, "docker.log"), "utf8");
    expect(log).toContain("compose stop web");
    expect(log).toContain("compose start web");
    expect(log).not.toContain("compose stop worker");
    expect(log).not.toContain("compose start worker");
  });
});
