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
  symlinkSync,
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
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), prefix)));
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
    "POSTGRES_BOOTSTRAP_PASSWORD=bootstrap-password-0123456789",
    "ATLAS_MIGRATOR_PASSWORD=migrator-password-0123456789",
    "ATLAS_WEB_PASSWORD=web-password-01234567890123",
    "ATLAS_WORKER_PASSWORD=worker-password-0123456789",
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
  coordinator: string;
  guardianUnit: string;
  backupTool: string;
  restoreTool: string;
  roleInitializer: string;
  caddyConfig: string;
  coordinatorStage: string;
  coordinatorStateRoot: string;
  coordinatorConfig: string;
  coordinatorInstallLock: string;
};

function createDeployFixture(): DeployFixture {
  const root = temporaryDirectory("atlas-deploy-test-");
  const repository = path.join(root, "repository");
  const remoteDirectory = path.join(root, "remote", "app");
  const backupRoot = path.join(root, "remote-backups");
  const binDirectory = path.join(root, "bin");
  const logDirectory = path.join(root, "logs");
  const coordinator = path.join(root, "atlas-v2-deployment-coordinator");
  const guardianUnit = path.join(root, "atlas-v2-deployment-guardian.service");
  const backupTool = path.join(root, "immutable-tools", "backup.sh");
  const restoreTool = path.join(root, "immutable-tools", "restore-test.sh");
  const roleInitializer = path.join(root, "immutable-tools", "init-roles.sh");
  const caddyConfig = path.join(root, "immutable-tools", "Caddyfile");
  const coordinatorStage = path.join(root, "coordinator-stage");
  const coordinatorStateRoot = path.join(root, "coordinator-state");
  const coordinatorConfig = path.join(root, "coordinator.conf");
  const coordinatorInstallLock = path.join(root, "install.lock");
  mkdirSync(path.join(repository, "deploy/systemd"), { recursive: true });
  mkdirSync(path.join(repository, "openapi"), { recursive: true });
  mkdirSync(path.join(repository, "nested"), { recursive: true });
  mkdirSync(binDirectory, { recursive: true });
  mkdirSync(logDirectory, { recursive: true });
  mkdirSync(remoteDirectory, { recursive: true });
  mkdirSync(backupRoot, { recursive: true });
  mkdirSync(path.dirname(backupTool), { recursive: true });
  copyFileSync(path.join(sourceRoot, "deploy/deploy.sh"), path.join(repository, "deploy/deploy.sh"));
  chmodSync(path.join(repository, "deploy/deploy.sh"), 0o755);
  copyFileSync(path.join(sourceRoot, "deploy/deployment-coordinator.sh"), path.join(repository, "deploy/deployment-coordinator.sh"));
  copyFileSync(
    path.join(sourceRoot, "deploy/systemd/atlas-v2-deployment-guardian.service"),
    path.join(repository, "deploy/systemd/atlas-v2-deployment-guardian.service"),
  );
  copyFileSync(path.join(sourceRoot, "deploy/backup.sh"), path.join(repository, "deploy/backup.sh"));
  copyFileSync(path.join(sourceRoot, "deploy/restore-test.sh"), path.join(repository, "deploy/restore-test.sh"));
  mkdirSync(path.join(repository, "deploy/postgres"), { recursive: true });
  copyFileSync(path.join(sourceRoot, "deploy/postgres/init-roles.sh"), path.join(repository, "deploy/postgres/init-roles.sh"));
  copyFileSync(path.join(sourceRoot, "deploy/Caddyfile"), path.join(repository, "deploy/Caddyfile"));
  copyFileSync(path.join(sourceRoot, "deploy/deployment-coordinator.sh"), coordinator);
  chmodSync(coordinator, 0o755);
  copyFileSync(path.join(sourceRoot, "deploy/systemd/atlas-v2-deployment-guardian.service"), guardianUnit);
  copyFileSync(path.join(sourceRoot, "deploy/backup.sh"), backupTool);
  chmodSync(backupTool, 0o755);
  copyFileSync(path.join(sourceRoot, "deploy/restore-test.sh"), restoreTool);
  chmodSync(restoreTool, 0o755);
  copyFileSync(path.join(sourceRoot, "deploy/postgres/init-roles.sh"), roleInitializer);
  chmodSync(roleInitializer, 0o755);
  copyFileSync(path.join(sourceRoot, "deploy/Caddyfile"), caddyConfig);
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
if [[ "\${1:-}" == "archive" ]]; then
  [[ "\${FAKE_GIT_ARCHIVE_FAIL:-0}" == "1" ]] && exit 41
  output=""
  for argument in "$@"; do
    case "\${argument}" in --output=*) output="\${argument#--output=}" ;; esac
  done
  [[ -n "\${output}" ]]
  /usr/bin/tar -cf "\${output}" package.json openapi deploy
  exit 0
fi
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
destination=""
for argument in "$@"; do destination="\${argument}"; done
destination="\${destination#*:}"
mkdir -p -- "\${destination}"
for argument in "$@"; do
  case "\${argument}" in
    */deployment-coordinator.sh|*/atlas-v2-deployment-guardian.service|*/backup.sh|*/restore-test.sh|*/init-roles.sh|*/Caddyfile|*/atlas-release.tar|*/atlas.env)
      /bin/cp "\${argument}" "\${destination}/"
      ;;
  esac
done
[[ "\${FAKE_RSYNC_FAIL_ON:-}" == "\${counter}" ]] && exit 42
exit 0`);
  fakeTool(binDirectory, "curl", `
printf '%s\\n' "$*" >> "\${FAKE_LOG_DIR}/curl.log"
if [[ "$*" == *"--resolve atlas.rangeway.app:443:127.0.0.1"* ]]; then
  [[ "\${FAKE_TARGET_HEALTH_FAIL:-0}" == "1" ]] && printf '%s\\n' '{"apiVersion":"v1"}' || printf '%s\\n' '{"apiVersion":"v2","contractVersion":"atlas-v2-foundation-v1","release":"${releaseCommit}"}'
else
  [[ "\${FAKE_PUBLIC_HEALTH_FAIL:-0}" == "1" ]] && printf '%s\\n' '{"apiVersion":"v1"}' || printf '%s\\n' '{"apiVersion":"v2","contractVersion":"atlas-v2-foundation-v1","release":"${releaseCommit}"}'
fi`);
  fakeTool(binDirectory, "sha256sum", `
if [[ "\${1:-}" == "--check" ]]; then
  shift
  /usr/bin/shasum -a 256 -c "$@"
else
  /usr/bin/shasum -a 256 "$@"
fi`);
  fakeTool(binDirectory, "flock", "exit 0");
  fakeTool(binDirectory, "sleep", "exit 0");
  fakeTool(binDirectory, "docker", `
printf '%s\\n' "$*" >> "\${FAKE_LOG_DIR}/docker.log"
if [[ "$*" == *"compose ps --all --format"* ]]; then
  printf '%b' "\${FAKE_WRITER_SNAPSHOT:-web|running|web-container\\nworker|running|worker-container\\n}"
  exit 0
fi
if [[ "$*" == "volume inspect atlas-db" ]]; then
  [[ "\${FAKE_HAS_DB:-0}" == "1" ]] && exit 0 || exit 1
fi
if [[ "$*" == "compose ps -q db" ]]; then printf '%s\\n' db-container; exit 0; fi
if [[ "$*" == "compose ps -q web" ]]; then printf '%s\\n' web-container; exit 0; fi
if [[ "$*" == "compose ps -q worker" ]]; then printf '%s\\n' worker-container; exit 0; fi
if [[ "$*" == *"State.Health.Status"* ]]; then printf '%s\\n' healthy; exit 0; fi
if [[ "$*" == *"pg_stat_activity"* ]]; then printf '0\\n'; exit 0; fi
if [[ "$*" == *"--profile operations run"* && "$*" == *"migrator"* \
  && "$*" != *"verify-runtime-permissions"* && "\${FAKE_MIGRATION_FAIL:-0}" == "1" ]]; then exit 59; fi
if [[ "$*" == *"compose exec -T"* && "$*" == *"PGAPPNAME=atlas-deploy-"* && "$*" == *"db bash -s --"* && "\${FAKE_ROLE_ROTATION_FAIL:-0}" == "1" ]]; then exit 60; fi
if [[ "$*" == "compose build web worker" && "\${FAKE_BUILD_DB_FAIL:-0}" == "1" ]]; then exit 61; fi
exit 0`);
  fakeTool(binDirectory, "systemctl", `
printf '%s\\n' "$*" >> "\${FAKE_LOG_DIR}/systemctl.log"
case "$*" in
  "enable --now atlas-v2-deployment-guardian.service"|"restart atlas-v2-deployment-guardian.service")
    : > "\${FAKE_LOG_DIR}/guardian-active"
    '${coordinator}' guardian-once
    ;;
  "is-active --quiet atlas-v2-deployment-guardian.service")
    [[ -f "\${FAKE_LOG_DIR}/guardian-active" ]]
    ;;
  "disable --now atlas-v2-deployment-guardian.service")
    /bin/unlink "\${FAKE_LOG_DIR}/guardian-active" 2>/dev/null || true
    ;;
  "daemon-reload") exit 0 ;;
  "cat --no-pager --full atlas-v2-deployment-guardian.service")
    printf '%s\\n' '# /etc/systemd/system/atlas-v2-deployment-guardian.service'
    /bin/cat "\${FAKE_GUARDIAN_UNIT_PATH}"
    ;;
  *) exit 0 ;;
esac`);
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
  set +e
  /bin/bash "\${script_file}" "$@"
  status=$?
  set -e
  /bin/unlink "\${script_file}"
  exit "\${status}"
fi
exit 64`);

  return {
    root,
    repository,
    remoteDirectory,
    backupRoot,
    environmentFile,
    binDirectory,
    logDirectory,
    coordinator,
    guardianUnit,
    backupTool,
    restoreTool,
    roleInitializer,
    caddyConfig,
    coordinatorStage,
    coordinatorStateRoot,
    coordinatorConfig,
    coordinatorInstallLock,
  };
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
      ATLAS_USER: "root",
      ATLAS_DIR: fixture.remoteDirectory,
      ATLAS_BACKUP_ROOT: fixture.backupRoot,
      ATLAS_ENV_FILE: fixture.environmentFile,
      ATLAS_COORDINATOR_PATH: fixture.coordinator,
      ATLAS_GUARDIAN_UNIT_PATH: fixture.guardianUnit,
      ATLAS_COORDINATOR_STATE_FILE: path.join(fixture.coordinatorStateRoot, "active.state"),
      ATLAS_COORDINATOR_STAGE: fixture.coordinatorStage,
      ATLAS_COORDINATOR_INSTALL_LOCK: fixture.coordinatorInstallLock,
      ATLAS_BACKUP_TOOL_PATH: fixture.backupTool,
      ATLAS_RESTORE_TOOL_PATH: fixture.restoreTool,
      ATLAS_ROLE_INITIALIZER_PATH: fixture.roleInitializer,
      ATLAS_CADDY_CONFIG_PATH: fixture.caddyConfig,
      ATLAS_COORDINATOR_TEST_MODE: "1",
      ATLAS_COORDINATOR_STATE_ROOT: fixture.coordinatorStateRoot,
      ATLAS_COORDINATOR_CONFIG_FILE: fixture.coordinatorConfig,
      ATLAS_COORDINATOR_GLOBAL_LOCK: path.join(fixture.root, "coordinator.lock"),
      ATLAS_COORDINATOR_ACTION_CLEANUP_LOCK: path.join(fixture.root, "action-cleanup.lock"),
      ATLAS_COORDINATOR_NOW_EPOCH: "100",
      FAKE_GUARDIAN_UNIT_PATH: fixture.guardianUnit,
      ...overrides,
    },
  });
}

function installRemoteBackup(fixture: DeployFixture): string {
  writeFileSync(path.join(fixture.remoteDirectory, ".atlas-release"), `${releaseCommit}\n`);
  const exactBackup = path.join(fixture.backupRoot, "20260802T200000Z-exact");
  executable(path.join(fixture.repository, "deploy/backup.sh"), `#!/usr/bin/env bash
set -euo pipefail
ATLAS_BACKUP_FORMAT="atlas-v2-postgres-artifacts-v1"
exact='${exactBackup}'
printf '%s\\n' "\${ATLAS_KEEP_QUIESCED:-unset}" > "\${FAKE_LOG_DIR}/backup-quiesced.log"
docker stop web-container worker-container >/dev/null
mkdir -p "\${exact}"
printf dump > "\${exact}/atlas-postgres.dump"
printf artifacts > "\${exact}/atlas-artifacts.tgz"
printf 'web_was_active=1\nworker_was_active=1\nwriters_quiesced=1\n' > "\${exact}/metadata.txt"
(cd "\${exact}" && sha256sum atlas-postgres.dump atlas-artifacts.tgz metadata.txt > manifest.sha256)
printf 'ATLAS_BACKUP_PATH=%s\\n' "\${exact}"
`);
  executable(path.join(fixture.repository, "deploy/restore-test.sh"), `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$1" > "\${FAKE_LOG_DIR}/restore-test.log"
if [[ "\${FAKE_RESTORE_FAIL:-0}" == "1" ]]; then
  echo "simulated restore-test failure" >&2
  exit 58
fi
echo "simulated restore-test success" >&2
`);
  return exactBackup;
}

describe("deploy.sh behavior", () => {
  it("uses the installed systemd guardian coordinator and contains no detached setsid lease", () => {
    const deploySource = readFileSync(path.join(sourceRoot, "deploy/deploy.sh"), "utf8");
    const bootstrapSource = readFileSync(path.join(sourceRoot, "deploy/bootstrap-ubuntu.sh"), "utf8");
    const unitSource = readFileSync(
      path.join(sourceRoot, "deploy/systemd/atlas-v2-deployment-guardian.service"),
      "utf8",
    );
    expect(deploySource).toContain("atlas-v2-deployment-coordinator");
    expect(deploySource).toMatch(/ATLAS_COORDINATOR_INSTALL_LOCK_HELD=1 exec[^\n]*coordinator[^\n]*begin/);
    expect(deploySource).toMatch(/transition.*boundary/);
    expect(deploySource).toMatch(/complete.*LOCAL_COMMIT/);
    expect(deploySource).not.toMatch(/setsid|\.lease\.sh|ATLAS_PREFLIGHT_ACK_PROTOCOL/);
    expect(bootstrapSource).toContain("atlas-v2-deployment-guardian.service");
    expect(unitSource).toContain("WantedBy=multi-user.target");
    expect(unitSource).toContain("Restart=on-failure");
  });

  it("verifies the complete immutable operations bundle before acquiring deployment ownership", () => {
    const deploySource = readFileSync(path.join(sourceRoot, "deploy/deploy.sh"), "utf8");
    const trustPosition = deploySource.indexOf("install_verified_coordinator");
    const beginPosition = deploySource.indexOf("ATLAS_COORDINATOR_INSTALL_LOCK_HELD=1 exec");
    expect(trustPosition).toBeGreaterThan(0);
    expect(beginPosition).toBeGreaterThan(trustPosition);
    expect(deploySource).toContain("deploy/deployment-coordinator.sh");
    expect(deploySource).toContain("deploy/systemd/atlas-v2-deployment-guardian.service");
    expect(deploySource).toContain("deploy/backup.sh");
    expect(deploySource).toContain("deploy/restore-test.sh");
    expect(deploySource).toContain("deploy/postgres/init-roles.sh");
    expect(deploySource).toContain("deploy/Caddyfile");
    expect(deploySource).toContain("COORDINATOR_SHA256");
    expect(deploySource).toContain("GUARDIAN_UNIT_SHA256");
    expect(deploySource).toContain("BACKUP_SHA256");
    expect(deploySource).toContain("RESTORE_SHA256");
    expect(deploySource).toContain("ROLE_INITIALIZER_SHA256");
    expect(deploySource).toContain("CADDY_CONFIG_SHA256");
    expect(deploySource).toMatch(/createHash\("sha256"\)/);
    expect(deploySource).toContain("sha256sum --");
    expect(deploySource).toContain("systemctl cat --no-pager --full");
    expect(deploySource).toContain("systemctl daemon-reload");
    expect(deploySource).toMatch(/owner.*root.*root|root:root/i);
    expect(deploySource).toMatch(/0755/);
    expect(deploySource).toMatch(/0644/);
  });

  it("uses one root-owned install/acquisition lock through atomic bundle replacement and begin", () => {
    const deploySource = readFileSync(path.join(sourceRoot, "deploy/deploy.sh"), "utf8");
    const coordinatorSource = readFileSync(path.join(sourceRoot, "deploy/deployment-coordinator.sh"), "utf8");

    expect(deploySource).toContain("ATLAS_COORDINATOR_INSTALL_LOCK");
    expect(deploySource).toMatch(/flock -x[^\n]*INSTALL_LOCK|flock -x[^\n]*[0-9]+/);
    expect(deploySource).toMatch(/ATLAS_COORDINATOR_INSTALL_LOCK_HELD=1 exec[^\n]*begin/);
    expect(coordinatorSource).toContain("INSTALL_LOCK");
    expect(coordinatorSource).toContain("ATLAS_COORDINATOR_INSTALL_LOCK_HELD");
    expect(deploySource.indexOf("active.state")).toBeLessThan(deploySource.indexOf(".next"));
  });

  it("refuses to replace coordinator code underneath active durable ownership", () => {
    const deploySource = readFileSync(path.join(sourceRoot, "deploy/deploy.sh"), "utf8");
    expect(deploySource).toMatch(/active\.state[\s\S]*refus|refus[\s\S]*active\.state/i);
    expect(deploySource).toMatch(/is-active[\s\S]*guardian/i);
    expect(deploySource).toContain('coordinator_next="${coordinator}.next"');
    expect(deploySource.indexOf("active.state")).toBeLessThan(
      deploySource.indexOf('mv -f -- "${coordinator_next}"'),
    );
  });

  it.each(["coordinator", "unit", "backup", "restore", "roles", "caddy"])(
    "replaces and verifies a stale or tampered installed %s before begin",
    (target) => {
      const fixture = createDeployFixture();
      const installed = target === "coordinator"
        ? fixture.coordinator
        : target === "unit"
          ? fixture.guardianUnit
          : target === "backup"
            ? fixture.backupTool
          : target === "restore"
            ? fixture.restoreTool
            : target === "roles"
              ? fixture.roleInitializer
              : fixture.caddyConfig;
      const reviewed = target === "coordinator"
        ? path.join(sourceRoot, "deploy/deployment-coordinator.sh")
        : target === "unit"
          ? path.join(sourceRoot, "deploy/systemd/atlas-v2-deployment-guardian.service")
          : target === "backup"
            ? path.join(sourceRoot, "deploy/backup.sh")
          : target === "restore"
            ? path.join(sourceRoot, "deploy/restore-test.sh")
            : target === "roles"
              ? path.join(sourceRoot, "deploy/postgres/init-roles.sh")
              : path.join(sourceRoot, "deploy/Caddyfile");
      writeFileSync(installed, "tampered-installed-bytes\n", {
        mode: target === "unit" || target === "caddy" ? 0o644 : 0o755,
      });

      const result = deploy(fixture);

      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
      expect(readFileSync(installed, "utf8")).toBe(readFileSync(reviewed, "utf8"));
      const sshScripts = readFileSync(path.join(fixture.logDirectory, "ssh-scripts.log"), "utf8");
      expect(sshScripts.indexOf("expected_coordinator_hash")).toBeLessThan(
        sshScripts.indexOf('coordinator="$1"'),
      );
    },
  );

  it("does not replace tampered coordinator bytes while durable state is active", () => {
    const fixture = createDeployFixture();
    const tampered = "tampered-active-coordinator\n";
    writeFileSync(fixture.coordinator, tampered, { mode: 0o755 });
    mkdirSync(fixture.coordinatorStateRoot, { recursive: true });
    writeFileSync(path.join(fixture.coordinatorStateRoot, "active.state"), "operator-resolution-required\n");

    const result = deploy(fixture);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/active\.state|active.*coordinator/i);
    expect(readFileSync(fixture.coordinator, "utf8")).toBe(tampered);
  });

  it("bootstraps a coherent root-admin-only deployment model without delegated privilege", () => {
    const bootstrapSource = readFileSync(path.join(sourceRoot, "deploy/bootstrap-ubuntu.sh"), "utf8");
    const deploySource = readFileSync(path.join(sourceRoot, "deploy/deploy.sh"), "utf8");
    expect(bootstrapSource).not.toMatch(/useradd|usermod|docker group|sudoers|NOPASSWD/i);
    expect(bootstrapSource).toMatch(/-o root -g root[\s\S]*\/opt\/atlas-v2/);
    expect(bootstrapSource).toMatch(/-o root -g root[\s\S]*\/var\/backups\/atlas-v2/);
    expect(bootstrapSource).toContain("atlas-v2-deployment-install.lock");
    expect(bootstrapSource).toContain("flock -x 9");
    expect(deploySource).toContain('REMOTE_USER="${ATLAS_USER:-root}"');
    expect(deploySource).toMatch(/REMOTE_USER.*root/);
    expect(deploySource).toMatch(/id -u/);
    expect(deploySource).not.toMatch(/sudo -n|privileged\(\)/);
  });

  it("promotes staged source and environment only through a guarded durable sync phase", () => {
    const deploySource = readFileSync(path.join(sourceRoot, "deploy/deploy.sh"), "utf8");
    const coordinatorSource = readFileSync(path.join(sourceRoot, "deploy/deployment-coordinator.sh"), "utf8");

    expect(deploySource).toContain('guard "${DEPLOYMENT_TOKEN}" syncing sync-release');
    expect(deploySource).toContain('transition "${DEPLOYMENT_TOKEN}" quiesced syncing');
    expect(deploySource).toContain('transition "${DEPLOYMENT_TOKEN}" syncing synced');
    expect(deploySource).not.toMatch(/rsync[^\n]*REMOTE_DIR/);
    expect(coordinatorSource).toContain("sync-release");
    expect(coordinatorSource).toContain("RENAME_EXCHANGE");
  });

  it("installs the narrow local-stage cleanup trap before archive, copy, hashing, or transfer", () => {
    const deploySource = readFileSync(path.join(sourceRoot, "deploy/deploy.sh"), "utf8");
    const temporaryPosition = deploySource.indexOf('LOCAL_CANDIDATE_STAGE="$(mktemp');
    const trapPosition = deploySource.indexOf("trap cleanup_local_candidate", temporaryPosition);
    expect(temporaryPosition).toBeGreaterThan(0);
    expect(trapPosition).toBeGreaterThan(temporaryPosition);
    for (const fallibleOperation of ["git archive", 'install -m 0600 "${ENV_FILE}"', "RELEASE_ARCHIVE_SHA256", "rsync -az"]) {
      expect(trapPosition).toBeLessThan(deploySource.indexOf(fallibleOperation, temporaryPosition));
    }
  });

  it("documents no direct role, image, or migration maintenance bypass", () => {
    const runbook = readFileSync(path.join(sourceRoot, "docs/runbooks/atlas-v2-operations.md"), "utf8");
    const migrationSection = runbook.slice(runbook.indexOf("## Migrations"), runbook.indexOf("## One-time production owner"));
    expect(migrationSection).not.toMatch(/docker compose (?:build|exec|run)/);
    expect(migrationSection).toMatch(/deploy(?:ment)? coordinator|deploy\.sh/i);
  });

  it("fences every long mutation and writer start with the exact token and phase", () => {
    const deploySource = readFileSync(path.join(sourceRoot, "deploy/deploy.sh"), "utf8");
    for (const action of ["build-db", "rotate-roles", "migrate", "start-writers", "verify-contract"]) {
      expect(deploySource).toContain(`guard \"\${DEPLOYMENT_TOKEN}\"`);
      expect(deploySource).toContain(action);
    }
    expect(deploySource).not.toContain("REMOTE_MIGRATE_AND_START");
  });

  it.each([
    "POSTGRES_BOOTSTRAP_PASSWORD",
    "ATLAS_MIGRATOR_PASSWORD",
    "ATLAS_WEB_PASSWORD",
    "ATLAS_WORKER_PASSWORD",
  ])("rejects a non-URL-safe %s before any remote action without logging the value", (field) => {
    const fixture = createDeployFixture();
    const secret = "unsafe%40password/with-reserved";
    const environment = productionEnvironment().replace(
      new RegExp(`^${field}=.*$`, "m"),
      `${field}=${secret}`,
    );
    writeFileSync(fixture.environmentFile, environment);

    const result = deploy(fixture);

    expect(result.status).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toMatch(/URL-safe|credential/i);
    expect(`${result.stdout}${result.stderr}`).not.toContain(secret);
    expect(existsSync(path.join(fixture.logDirectory, "ssh.log"))).toBe(false);
  });

  it.each([
    ["POSTGRES_BOOTSTRAP_PASSWORD", "ATLAS_MIGRATOR_PASSWORD"],
    ["POSTGRES_BOOTSTRAP_PASSWORD", "ATLAS_WEB_PASSWORD"],
    ["POSTGRES_BOOTSTRAP_PASSWORD", "ATLAS_WORKER_PASSWORD"],
    ["ATLAS_MIGRATOR_PASSWORD", "ATLAS_WEB_PASSWORD"],
    ["ATLAS_MIGRATOR_PASSWORD", "ATLAS_WORKER_PASSWORD"],
    ["ATLAS_WEB_PASSWORD", "ATLAS_WORKER_PASSWORD"],
  ])("rejects duplicate credentials for %s and %s without logging them", (first, second) => {
    const fixture = createDeployFixture();
    const duplicate = "pairwise-duplicate-password-01";
    let environment = productionEnvironment();
    environment = environment.replace(new RegExp(`^${first}=.*$`, "m"), `${first}=${duplicate}`);
    environment = environment.replace(new RegExp(`^${second}=.*$`, "m"), `${second}=${duplicate}`);
    writeFileSync(fixture.environmentFile, environment);

    const result = deploy(fixture);

    expect(result.status).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toMatch(/database.*credentials.*pairwise distinct/i);
    expect(`${result.stdout}${result.stderr}`).not.toContain(duplicate);
    expect(existsSync(path.join(fixture.logDirectory, "ssh.log"))).toBe(false);
  });

  it("enforces pairwise-distinct role credentials inside the PostgreSQL role initializer", () => {
    const source = readFileSync(path.join(sourceRoot, "deploy/postgres/init-roles.sh"), "utf8");
    expect(source).toContain("Atlas database role credentials must be pairwise distinct.");
    expect(source).toMatch(/password_names/);
    expect(source).not.toMatch(/echo.*password_value/);
  });

  it("executes the installed reviewed role initializer with the exact token application name", () => {
    const fixture = createDeployFixture();
    const result = deploy(fixture);

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    const dockerLog = readFileSync(path.join(fixture.logDirectory, "docker.log"), "utf8");
    expect(dockerLog).toContain(`PGAPPNAME=atlas-deploy-`);
    expect(dockerLog).toContain("db bash -s --");
    expect(dockerLog).not.toContain("/docker-entrypoint-initdb.d/001-atlas-roles.sh");
  });

  it("force-recreates Caddy so an upgraded immutable config bind uses the new inode", () => {
    const fixture = createDeployFixture();
    writeFileSync(fixture.caddyConfig, "stale-caddy-bytes\n", { mode: 0o644 });
    const result = deploy(fixture);

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(readFileSync(fixture.caddyConfig, "utf8")).toBe(
      readFileSync(path.join(sourceRoot, "deploy/Caddyfile"), "utf8"),
    );
    expect(readFileSync(path.join(fixture.logDirectory, "docker.log"), "utf8"))
      .toContain("compose up -d --force-recreate caddy");
  });

  it("allows a first deployment with no existing V2 database and no backup restore", () => {
    const fixture = createDeployFixture();
    const result = deploy(fixture);

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(existsSync(path.join(fixture.logDirectory, "restore-test.log"))).toBe(false);
  });

  it("restore-tests the exact fresh backup before syncing an existing V2 deployment", () => {
    const fixture = createDeployFixture();
    const exactBackup = installRemoteBackup(fixture);
    const result = deploy(fixture, { FAKE_HAS_DB: "1" });

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(readFileSync(path.join(fixture.logDirectory, "restore-test.log"), "utf8").trim()).toBe(
      exactBackup,
    );
    expect(existsSync(path.join(fixture.logDirectory, "rsync-1.args"))).toBe(true);
  });

  it("leaves no durable ownership or writer mutation when immutable bundle staging fails", () => {
    const fixture = createDeployFixture();
    installRemoteBackup(fixture);
    const result = deploy(fixture, {
      FAKE_HAS_DB: "1",
      FAKE_RSYNC_FAIL_ON: "1",
    });

    expect(result.status).not.toBe(0);
    expect(existsSync(path.join(fixture.coordinatorStateRoot, "active.state"))).toBe(false);
    expect(existsSync(path.join(fixture.logDirectory, "docker.log"))).toBe(false);
  });

  it.each(["archive", "transfer"])(
    "removes the local secret-bearing candidate directory after a pre-acquisition %s failure",
    (failure) => {
      const fixture = createDeployFixture();
      const localTemporaryRoot = path.join(fixture.root, "local-tmp");
      mkdirSync(localTemporaryRoot);
      const result = deploy(fixture, {
        TMPDIR: localTemporaryRoot,
        ...(failure === "archive" ? { FAKE_GIT_ARCHIVE_FAIL: "1" } : { FAKE_RSYNC_FAIL_ON: "1" }),
      });

      expect(result.status).not.toBe(0);
      expect(readdirSync(localTemporaryRoot).filter((entry) => entry.startsWith("atlas-v2-candidate.")))
        .toEqual([]);
      expect(existsSync(path.join(fixture.coordinatorStateRoot, "active.state"))).toBe(false);
    },
  );

  it("retires a recovered deployment under the install lock and retries without manual intervention", () => {
    const fixture = createDeployFixture();
    writeFileSync(path.join(fixture.remoteDirectory, ".atlas-release"), `${releaseCommit}\n`);
    writeFileSync(path.join(fixture.remoteDirectory, "prior.txt"), "prior release bytes\n");
    const failed = deploy(fixture, { FAKE_BUILD_DB_FAIL: "1" });
    expect(failed.status).not.toBe(0);
    expect(readFileSync(path.join(fixture.coordinatorStateRoot, "active.state"), "utf8"))
      .toContain("status=recovered");

    const retried = deploy(fixture);
    expect(retried.status, `${retried.stdout}\n${retried.stderr}`).toBe(0);
    expect(readFileSync(path.join(fixture.remoteDirectory, ".atlas-release"), "utf8"))
      .toBe(`${releaseCommit}\n`);
    expect(readdirSync(path.join(fixture.coordinatorStateRoot, "history")).some((entry) =>
      entry.endsWith(".recovered.state"))).toBe(true);
  });

  it("never executes unauthenticated installed coordinator bytes to retire recovered state", () => {
    const fixture = createDeployFixture();
    writeFileSync(path.join(fixture.remoteDirectory, ".atlas-release"), `${releaseCommit}\n`);
    writeFileSync(path.join(fixture.remoteDirectory, "prior.txt"), "prior release bytes\n");
    const failed = deploy(fixture, { FAKE_BUILD_DB_FAIL: "1" });
    expect(failed.status).not.toBe(0);
    expect(readFileSync(path.join(fixture.coordinatorStateRoot, "active.state"), "utf8"))
      .toContain("status=recovered");

    const executionMarker = path.join(fixture.logDirectory, "unauthenticated-coordinator-ran");
    executable(fixture.coordinator, `#!/usr/bin/env bash\n: > '${executionMarker}'\nexit 1\n`);
    const retried = deploy(fixture);

    expect(retried.status).not.toBe(0);
    expect(existsSync(executionMarker)).toBe(false);
    expect(retried.stderr).toMatch(/unauthenticated coordinator bytes/i);
  });

  it("fails closed with recovery evidence before sync when the fresh backup restore test fails", () => {
    const fixture = createDeployFixture();
    const exactBackup = installRemoteBackup(fixture);
    const result = deploy(fixture, {
      FAKE_HAS_DB: "1",
      FAKE_RESTORE_FAIL: "1",
    });

    expect(result.status).not.toBe(0);
    expect(readFileSync(path.join(fixture.logDirectory, "restore-test.log"), "utf8").trim()).toBe(
      exactBackup,
    );
    expect(readFileSync(path.join(fixture.logDirectory, "rsync-counter"), "utf8").trim()).toBe("1");
    expect(result.stderr).toContain(`Previous Git commit: ${releaseCommit}`);
    expect(result.stderr).toContain(`Exact pre-deploy backup: ${exactBackup}`);
    expect(result.stderr).toMatch(/before migration|durable guardian/i);
    expect(readFileSync(path.join(fixture.remoteDirectory, ".atlas-release"), "utf8").trim()).toBe(
      releaseCommit,
    );
  });

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
    const stagedSync = readFileSync(path.join(fixture.logDirectory, "rsync-1.args"), "utf8");
    expect(stagedSync).toContain("atlas-release.tar\n");
    expect(stagedSync).toContain("atlas.env\n");
    expect(stagedSync).not.toContain(`${realpathSync(fixture.environmentFile)}\n`);
    expect(stagedSync).not.toContain(`${fixture.remoteDirectory}/.env\n`);
    expect(readFileSync(path.join(fixture.remoteDirectory, ".env"), "utf8")).toBe(
      productionEnvironment(),
    );
    expect(readFileSync(path.join(fixture.logDirectory, "curl.log"), "utf8")).toMatch(
      /--noproxy \* .*--resolve atlas\.rangeway\.app:443:127\.0\.0\.1/,
    );
  });

  it("rejects a remote release symlink before backup or synchronization", () => {
    const fixture = createDeployFixture();
    const releaseAlias = path.join(fixture.root, "release-alias");
    symlinkSync(fixture.remoteDirectory, releaseAlias);
    const result = deploy(fixture, { ATLAS_DIR: releaseAlias });

    expect(result.status).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toMatch(/canonical path/i);
    expect(readFileSync(path.join(fixture.logDirectory, "ssh.log"), "utf8").trim().split("\n")).toHaveLength(3);
    expect(existsSync(path.join(fixture.logDirectory, "docker.log"))).toBe(false);
    expect(readFileSync(path.join(fixture.logDirectory, "rsync-counter"), "utf8").trim()).toBe("1");
  });

  it("restarts the exact prior-active containers after a failure before migration begins", () => {
    const fixture = createDeployFixture();
    const exactBackup = installRemoteBackup(fixture);
    const result = deploy(fixture, { FAKE_HAS_DB: "1", FAKE_SYNC_RELEASE_FAIL: "1" });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(`Previous Git commit: ${releaseCommit}`);
    expect(result.stderr).toContain(`Exact pre-deploy backup: ${exactBackup}`);
    expect(result.stderr).toMatch(/restores only the exact prior-active writers/i);
    const dockerLog = readFileSync(path.join(fixture.logDirectory, "docker.log"), "utf8");
    expect(dockerLog).toContain("start worker-container");
    expect(dockerLog).toContain("start web-container");
    expect(readFileSync(path.join(fixture.remoteDirectory, ".atlas-release"), "utf8").trim()).toBe(releaseCommit);
  });

  it("fails closed after migration begins and never restarts incompatible old containers", () => {
    const fixture = createDeployFixture();
    const exactBackup = installRemoteBackup(fixture);
    const result = deploy(fixture, { FAKE_HAS_DB: "1", FAKE_MIGRATION_FAIL: "1" });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(`Exact pre-deploy backup: ${exactBackup}`);
    expect(result.stderr).toMatch(/migration compatibility boundary crossed|fail closed/i);
    const dockerLog = readFileSync(path.join(fixture.logDirectory, "docker.log"), "utf8");
    expect(dockerLog).not.toContain("start worker-container");
    expect(dockerLog).not.toContain("start web-container");
  });

  it("crosses the fail-closed boundary before role rotation and never restarts old writers on a partial role failure", () => {
    const fixture = createDeployFixture();
    installRemoteBackup(fixture);
    const result = deploy(fixture, {
      FAKE_HAS_DB: "1",
      FAKE_ROLE_ROTATION_FAIL: "1",
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/compatibility boundary crossed|fail closed/i);
    const dockerLog = readFileSync(path.join(fixture.logDirectory, "docker.log"), "utf8");
    expect(dockerLog).toContain("db bash -s --");
    expect(dockerLog).toContain("PGAPPNAME=atlas-deploy-");
    expect(dockerLog).not.toContain("start worker-container");
    expect(dockerLog).not.toContain("start web-container");
  });

  it("keeps old writers stopped when a forced failure occurs after successful role rotation", () => {
    const fixture = createDeployFixture();
    installRemoteBackup(fixture);
    const result = deploy(fixture, {
      FAKE_HAS_DB: "1",
      FAKE_MIGRATION_FAIL: "1",
    });

    expect(result.status).not.toBe(0);
    const dockerLog = readFileSync(path.join(fixture.logDirectory, "docker.log"), "utf8");
    expect(dockerLog.indexOf("db bash -s --")).toBeGreaterThanOrEqual(0);
    expect(dockerLog.indexOf("--profile operations run --rm --label")).toBeGreaterThan(
      dockerLog.indexOf("db bash -s --"),
    );
    expect(dockerLog).not.toContain("start worker-container");
    expect(dockerLog).not.toContain("start web-container");
  });

  it("requests one quiesced backup for an existing deployment", () => {
    const fixture = createDeployFixture();
    installRemoteBackup(fixture);
    const result = deploy(fixture, { FAKE_HAS_DB: "1" });

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(readFileSync(path.join(fixture.logDirectory, "backup-quiesced.log"), "utf8").trim()).toBe("1");
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
  fakeTool(binDirectory, "date", `
case "$*" in
  "-u +%Y-%m-%dT%H:%M:%SZ") printf '%s\\n' "2026-08-02T20:00:00Z" ;;
  "-u +%Y%m%dT%H%M%SZ") printf '%s\\n' "20260802T200000Z" ;;
  *) exit 61 ;;
esac`);
  fakeTool(binDirectory, "mktemp", `
last_argument=""
for argument in "$@"; do last_argument="$argument"; done
pending_directory="$(/usr/bin/ruby -e 'puts ARGV.fetch(0).sub(/XXXXXX$/, "COLLIDE")' "$last_argument")"
mkdir -p -- "$pending_directory"
printf '%s\\n' "$pending_directory"`);
  fakeTool(binDirectory, "sha256sum", `
[[ "\${FAKE_FAIL_STAGE:-}" == "checksum" ]] && exit 51
/usr/bin/shasum -a 256 "$@"`);
  fakeTool(binDirectory, "docker", `
printf '%s\\n' "$*" >> "\${FAKE_LOG_DIR}/docker.log"
last_argument=""
for argument in "$@"; do last_argument="\${argument}"; done
if [[ "$*" == "compose ps -q db" ]]; then printf '%s\\n' db-container; exit 0; fi
if [[ "$*" == *"compose ps --all --format"* ]]; then
  [[ "\${FAKE_SNAPSHOT_FAIL:-0}" == "1" ]] && exit 55
  if [[ -n "\${FAKE_COMPOSE_SNAPSHOT:-}" ]]; then
    printf '%b' "$FAKE_COMPOSE_SNAPSHOT"
  else
    web_state="\${FAKE_WEB_STATE:-running}"
    worker_state="\${FAKE_WORKER_STATE:-running}"
    [[ "$web_state" == "absent" ]] || printf 'web|%s\\n' "$web_state"
    [[ "$worker_state" == "absent" ]] || printf 'worker|%s\\n' "$worker_state"
  fi
  exit 0
fi
if [[ "$*" == *"compose ps"* && ( "\${last_argument}" == "web" || "\${last_argument}" == "worker" ) ]]; then
  requested_status=""
  previous_argument=""
  for argument in "$@"; do
    [[ "\${previous_argument}" == "--status" ]] && requested_status="\${argument}"
    previous_argument="\${argument}"
  done
  [[ "\${FAKE_PROBE_FAIL:-}" == "\${last_argument}:\${requested_status}" ]] && exit 55
  if [[ "\${FAKE_TRANSITION_RACE:-0}" == "1" && "$last_argument" == "web" ]]; then
    exit 0
  fi
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
if [[ "$*" == *"label=com.docker.compose.project=atlas-v2"* && "$*" == *"label=com.docker.compose.service=migrator"* ]]; then
  if [[ "\${FAKE_ACTIVE_MIGRATOR:-0}" == "1" && ! -f "\${FAKE_LOG_DIR}/migrator-stopped" ]]; then
    if [[ "$*" == *"--format"* ]]; then
      printf '%s\n' 'migrator-active|atlas-v2|migrator'
    else
      printf '%s\n' 'migrator-active'
    fi
  fi
  exit 0
fi
if [[ "\${1:-}" == "stop" && "$*" == *"migrator-active"* ]]; then
  : > "\${FAKE_LOG_DIR}/migrator-stopped"
  exit 0
fi
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
  it("fences an active exact-label migrator before pg_dump without adding it to the restorable set", () => {
    const fixture = createBackupFixture();
    const result = backup(fixture, { FAKE_ACTIVE_MIGRATOR: "1" });

    expect(result.status, result.stderr).toBe(0);
    const log = readFileSync(path.join(fixture.logDirectory, "docker.log"), "utf8");
    const migratorProbe = log.indexOf("label=com.docker.compose.service=migrator");
    const migratorStop = log.indexOf("stop -- migrator-active");
    const dump = log.indexOf("pg_dump");
    expect(migratorProbe).toBeGreaterThanOrEqual(0);
    expect(migratorStop).toBeGreaterThan(migratorProbe);
    expect(dump).toBeGreaterThan(migratorStop);
    expect(log).not.toContain("start migrator");
  });

  it("supports a deploy-only quiesced success mode without changing standalone restart behavior", () => {
    const fixture = createBackupFixture();
    const result = backup(fixture, { ATLAS_KEEP_QUIESCED: "1" });

    expect(result.status, result.stderr).toBe(0);
    const log = readFileSync(path.join(fixture.logDirectory, "docker.log"), "utf8");
    expect(log).toContain("compose stop web");
    expect(log).toContain("compose stop worker");
    expect(log).not.toContain("compose start web");
    expect(log).not.toContain("compose start worker");
  });

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

  it("uses one snapshot so a restarting-to-running transition cannot disappear between probes", () => {
    const fixture = createBackupFixture();
    const result = backup(fixture, {
      FAKE_TRANSITION_RACE: "1",
      FAKE_COMPOSE_SNAPSHOT: "web|restarting\nworker|exited\n",
      FAKE_WORKER_STATE: "exited",
    });

    expect(result.status, result.stderr).toBe(0);
    const log = readFileSync(path.join(fixture.logDirectory, "docker.log"), "utf8");
    expect(log.match(/compose ps --all --format/g)).toHaveLength(1);
    expect(log).not.toContain("compose ps --status");
    expect(log).toContain("compose stop web");
    expect(log).toContain("compose start web");
    expect(log).not.toContain("compose stop worker");
    expect(log).not.toContain("compose start worker");
  });

  it("aborts on a service-state probe failure before stopping or backing up", () => {
    const fixture = createBackupFixture();
    const result = backup(fixture, { FAKE_SNAPSHOT_FAIL: "1" });

    expect(result.status).not.toBe(0);
    expect(result.stdout).not.toContain("ATLAS_BACKUP_PATH=");
    const log = readFileSync(path.join(fixture.logDirectory, "docker.log"), "utf8");
    expect(log.match(/compose ps --all --format/g)).toHaveLength(1);
    expect(log).not.toMatch(/compose stop|pg_dump|compose start/);
    expect(existsSync(fixture.backupRoot) ? readdirSync(fixture.backupRoot) : []).toEqual([]);
  });

  it.each([
    ["duplicate", "web|running\nweb|restarting\nworker|exited\n"],
    ["unknown", "web|running\ncaddy|running\n"],
    ["malformed", "web running\nworker|exited\n"],
  ])("rejects %s service-state snapshot output before backup", (_label, snapshot) => {
    const fixture = createBackupFixture();
    const result = backup(fixture, { FAKE_COMPOSE_SNAPSHOT: snapshot });

    expect(result.status).not.toBe(0);
    expect(result.stdout).not.toContain("ATLAS_BACKUP_PATH=");
    const log = readFileSync(path.join(fixture.logDirectory, "docker.log"), "utf8");
    expect(log.match(/compose ps --all --format/g)).toHaveLength(1);
    expect(log).not.toMatch(/compose stop|pg_dump|compose start/);
    expect(existsSync(fixture.backupRoot) ? readdirSync(fixture.backupRoot) : []).toEqual([]);
  });

  it("cleans the pending directory when the final backup name already exists", () => {
    const fixture = createBackupFixture();
    mkdirSync(fixture.backupRoot, { recursive: true });
    const collisionName = "20260802T200000Z-COLLIDE";
    mkdirSync(path.join(fixture.backupRoot, collisionName));
    const result = backup(fixture);

    expect(result.status).not.toBe(0);
    expect(result.stdout).not.toContain("ATLAS_BACKUP_PATH=");
    expect(readdirSync(fixture.backupRoot)).toEqual([collisionName]);
    const log = readFileSync(path.join(fixture.logDirectory, "docker.log"), "utf8");
    expect(log).not.toMatch(/compose stop|pg_dump|compose start/);
  });

  it("treats restarting as active, restores only that service after failure, and removes partial output", () => {
    const fixture = createBackupFixture();
    const result = backup(fixture, {
      FAKE_WEB_STATE: "exited",
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
    const result = backup(fixture, { FAKE_WORKER_STATE: "exited" });

    expect(result.status, result.stderr).toBe(0);
    const log = readFileSync(path.join(fixture.logDirectory, "docker.log"), "utf8");
    expect(log).toContain("compose stop web");
    expect(log).toContain("compose start web");
    expect(log).not.toContain("compose stop worker");
    expect(log).not.toContain("compose start worker");
  });
});
