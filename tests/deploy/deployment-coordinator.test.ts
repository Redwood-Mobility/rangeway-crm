import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
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
const coordinatorSource = path.join(sourceRoot, "deploy/deployment-coordinator.sh");
const roots: string[] = [];
const tokenOne = "10000000-0000-4000-8000-000000000001";
const tokenTwo = "20000000-0000-4000-8000-000000000001";
const release = "a".repeat(40);
const realFlockPath = spawnSync("/bin/sh", ["-c", "command -v flock"], { encoding: "utf8" })
  .stdout.trim();
const hasSystemdManager = process.getuid?.() === 0 &&
  spawnSync("/bin/sh", ["-c", "command -v systemd-run >/dev/null && systemctl show-environment >/dev/null"], {
    encoding: "utf8",
  }).status === 0;

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function executable(filename: string, source: string): void {
  writeFileSync(filename, source, { mode: 0o755 });
  chmodSync(filename, 0o755);
}

function sha256(filename: string): string {
  return createHash("sha256").update(readFileSync(filename)).digest("hex");
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitForMutation(filename: string): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    if (existsSync(filename) && readFileSync(filename).length >= 3) return;
    await delay(20);
  }
  throw new Error(`Timed out waiting for guarded mutation evidence at ${filename}`);
}

async function waitForExit(child: ReturnType<typeof spawn>): Promise<number | null> {
  if (child.exitCode !== null) return child.exitCode;
  return await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => resolve(code));
  });
}

async function expectMutationStopped(filename: string): Promise<void> {
  const before = readFileSync(filename).length;
  await delay(250);
  expect(readFileSync(filename).length).toBe(before);
}

function fixture() {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "atlas-coordinator-test-")));
  roots.push(root);
  const bin = path.join(root, "bin");
  const stateRoot = path.join(root, "state");
  const remote = path.join(root, "remote");
  const backups = path.join(root, "backups");
  const log = path.join(root, "events.log");
  const config = path.join(root, "guardian.conf");
  const coordinator = path.join(root, "atlas-v2-deployment-coordinator");
  const guardianUnit = path.join(root, "atlas-v2-deployment-guardian.service");
  const backupTool = path.join(root, "backup.sh");
  const restoreTool = path.join(root, "restore-test.sh");
  const roleInitializer = path.join(root, "init-roles.sh");
  const caddyConfig = path.join(root, "Caddyfile");
  const candidateStage = path.join(root, "candidate-stage");
  mkdirSync(bin, { recursive: true });
  mkdirSync(remote, { recursive: true });
  mkdirSync(backups, { recursive: true });
  mkdirSync(candidateStage, { recursive: true });
  copyFileSync(coordinatorSource, coordinator);
  chmodSync(coordinator, 0o755);
  writeFileSync(guardianUnit, "[Unit]\nDescription=Atlas test guardian\n");
  executable(backupTool, '#!/usr/bin/env bash\nATLAS_BACKUP_FORMAT="atlas-v2-postgres-artifacts-v1"\nexit 0\n');
  executable(restoreTool, "#!/usr/bin/env bash\nexit 0\n");
  executable(roleInitializer, "#!/usr/bin/env bash\nexit 0\n");
  writeFileSync(caddyConfig, "atlas.rangeway.app { reverse_proxy web:8080 }\n");
  const archiveInput = path.join(root, "archive-input");
  mkdirSync(archiveInput);
  writeFileSync(path.join(archiveInput, "candidate.txt"), "exact candidate bytes\n");
  expect(spawnSync("tar", ["-cf", path.join(candidateStage, "atlas-release.tar"), "-C", archiveInput, "."]).status).toBe(0);
  writeFileSync(path.join(candidateStage, "atlas.env"), "NODE_ENV=production\n");
  const bundleArguments = [
    release,
    sha256(coordinator),
    sha256(guardianUnit),
    sha256(backupTool),
    sha256(restoreTool),
    sha256(roleInitializer),
    sha256(caddyConfig),
    candidateStage,
    sha256(path.join(candidateStage, "atlas-release.tar")),
    sha256(path.join(candidateStage, "atlas.env")),
  ];

  executable(path.join(bin, "docker"), `#!/usr/bin/env bash
set -euo pipefail
printf 'docker %s\n' "$*" >> "${log}"
if [[ "$*" == *"compose ps --all --format"* ]]; then
  printf '%b' "\${FAKE_WRITER_SNAPSHOT:-web|running|web-container\\nworker|running|worker-container\\n}"
  exit 0
fi
if [[ "$*" == *"label=com.docker.compose.project=atlas-v2"* && "$*" == *"label=com.docker.compose.service=web"* ]]; then
  printf 'web-guarded|atlas-v2|web\n'
  exit 0
fi
if [[ "$*" == *"label=com.docker.compose.project=atlas-v2"* && "$*" == *"label=com.docker.compose.service=worker"* ]]; then
  printf 'worker-guarded|atlas-v2|worker\n'
  exit 0
fi
if [[ "$*" == *"label=com.docker.compose.project=atlas-v2"* && "$*" == *"label=com.docker.compose.service=migrator"* ]]; then
  if [[ ! -f "${root}/migrator-stopped" ]]; then
    if [[ "$*" == *".Label"* ]]; then
      printf 'migrator-one-off|atlas-v2|migrator\n'
    else
      printf 'migrator-one-off\n'
    fi
  fi
  exit 0
fi
if [[ "$*" == "stop -- migrator-one-off" ]]; then
  : > "${root}/migrator-stopped"
  exit 0
fi
if [[ "$*" == *"compose --profile operations run --rm migrator"* \
  && -n "\${FAKE_GUARDED_ACTION_SECONDS:-}" ]]; then
  /bin/sleep "\${FAKE_GUARDED_ACTION_SECONDS}"
  exit 0
fi
if [[ "$*" == *"pg_stat_activity"* ]]; then printf '0\n'; exit 0; fi
if [[ "\${1:-}" == "start" && "\${FAKE_RESTART_FAIL:-0}" == "1" ]]; then exit 70; fi
exit 0
`);
  executable(path.join(bin, "systemctl"), `#!/usr/bin/env bash
set -euo pipefail
printf 'systemctl %s\n' "$*" >> "${log}"
case "$*" in
  "enable --now atlas-v2-deployment-guardian.service"|"restart atlas-v2-deployment-guardian.service")
    : > "${root}/guardian-active"
    "${coordinator}" guardian-once
    ;;
  "is-active --quiet atlas-v2-deployment-guardian.service") [[ -f "${root}/guardian-active" ]] ;;
  "disable --now atlas-v2-deployment-guardian.service") /bin/unlink "${root}/guardian-active" 2>/dev/null || true ;;
  *) exit 0 ;;
esac
`);
  executable(path.join(bin, "sleep"), "exit 0");
  executable(path.join(bin, "flock"), "exit 0");

  const environment = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    ATLAS_COORDINATOR_TEST_MODE: "1",
    ATLAS_COORDINATOR_STATE_ROOT: stateRoot,
    ATLAS_COORDINATOR_CONFIG_FILE: config,
    ATLAS_COORDINATOR_GLOBAL_LOCK: path.join(root, "global.lock"),
      ATLAS_COORDINATOR_INSTALL_LOCK: path.join(root, "install.lock"),
      ATLAS_COORDINATOR_ACTION_CLEANUP_LOCK: path.join(root, "action-cleanup.lock"),
    ATLAS_COORDINATOR_PATH: coordinator,
    ATLAS_GUARDIAN_UNIT_PATH: guardianUnit,
    ATLAS_BACKUP_TOOL_PATH: backupTool,
    ATLAS_RESTORE_TOOL_PATH: restoreTool,
    ATLAS_ROLE_INITIALIZER_PATH: roleInitializer,
    ATLAS_CADDY_CONFIG_PATH: caddyConfig,
    ATLAS_COORDINATOR_NOW_EPOCH: "100",
  };
  const run = (args: string[], overrides: NodeJS.ProcessEnv = {}) =>
    spawnSync("/bin/bash", [coordinator, ...args], {
      encoding: "utf8",
      env: { ...environment, ...overrides },
    });
  const begin = (token = tokenOne, overrides: NodeJS.ProcessEnv = {}) =>
    run(["begin", token, remote, backups, "10", ...bundleArguments], overrides);
  const state = () => readFileSync(path.join(stateRoot, "active.state"), "utf8");
  const events = () => existsSync(log) ? readFileSync(log, "utf8") : "";
  return {
    root,
    bin,
    remote,
    backups,
    stateRoot,
    config,
    coordinator,
    guardianUnit,
    backupTool,
    restoreTool,
    roleInitializer,
    caddyConfig,
    candidateStage,
    bundleArguments,
    environment,
    run,
    begin,
    state,
    events,
  };
}

describe("host-wide durable deployment coordinator", () => {
  it("records immutable bundle hashes and never invokes release-tree recovery scripts", () => {
    const source = readFileSync(coordinatorSource, "utf8");

    for (const stateField of [
      "bundle_version",
      "coordinator_hash",
      "guardian_unit_hash",
      "backup_tool_hash",
      "restore_tool_hash",
      "role_initializer_hash",
      "caddy_config_hash",
    ]) {
      expect(source).toContain(stateField);
    }
    expect(source).toContain("BACKUP_TOOL_PATH");
    expect(source).toContain("RESTORE_TOOL_PATH");
    expect(source).toContain("ROLE_INITIALIZER_PATH");
    expect(source).toContain("CADDY_CONFIG_PATH");
    expect(source).not.toMatch(/\.\/deploy\/(?:backup|restore-test)\.sh/);
  });

  it("records guarded process groups and uses TERM then bounded KILL for the entire group", () => {
    const source = readFileSync(coordinatorSource, "utf8");

    expect(source).toMatch(/os\.setsid\(\)/);
    expect(source).toContain("action_pid");
    expect(source).toMatch(/kill -TERM -- "-\$\{[^}]+\}"/);
    expect(source).toMatch(/kill -KILL -- "-\$\{[^}]+\}"/);
    expect(source).toMatch(/docker (?:rm -f|stop)[\s\S]*atlas\.deployment-token/);
    expect(source).toContain("pg_terminate_backend");
    expect(source).toContain("ACTION_CLEANUP_LOCK");
    expect(source).toMatch(/flock -x 6/);
  });

  it("uses a token-named systemd cgroup in production and a durable local reaper harness", () => {
    const source = readFileSync(coordinatorSource, "utf8");

    expect(source).toContain("systemd-run");
    expect(source).toContain("ExitType=cgroup");
    expect(source).toContain("KillMode=control-group");
    expect(source).toContain("action_unit");
    expect(source).toMatch(/systemctl stop[\s\S]*action_unit/);
    expect(source).toContain("action-reaper");
  });

  it("rejects a concurrent deploy or recovery owner while one exact token is active", () => {
    const f = fixture();
    expect(f.begin().status).toBe(0);
    const overlap = f.begin(tokenTwo);
    expect(overlap.status).not.toBe(0);
    expect(overlap.stderr).toMatch(/deployment already active/i);
    expect(f.state()).toContain(`token=${tokenOne}`);
  });

  it.each(["prepared", "quiesced"])(
    "restores the exact prior writer set when the owner disappears in %s",
    (status) => {
      const f = fixture();
      expect(f.begin(tokenOne, {
        FAKE_WRITER_SNAPSHOT: "web|running|web-exact\nworker|exited|worker-exact\n",
      }).status).toBe(0);
      if (status === "quiesced") {
        expect(f.run(["transition", tokenOne, "prepared", "quiesced"]).status).toBe(0);
      }
      expect(f.run(["guardian-once"], { ATLAS_COORDINATOR_NOW_EPOCH: "111" }).status).toBe(0);
      expect(f.events()).toContain("docker start web-exact");
      expect(f.events()).not.toContain("docker start worker-exact");
      expect(f.state()).toContain("status=recovered");
    },
  );

  it("fails closed after the boundary, including boot reconciliation after new writers start", () => {
    const f = fixture();
    expect(f.begin().status).toBe(0);
    expect(f.run(["transition", tokenOne, "prepared", "quiesced"]).status).toBe(0);
    expect(f.run(["transition", tokenOne, "quiesced", "syncing"]).status).toBe(0);
    expect(f.run(["guard", tokenOne, "syncing", "sync-release"]).status).toBe(0);
    expect(f.run(["transition", tokenOne, "syncing", "synced"]).status).toBe(0);
    expect(f.run(["candidate", tokenOne, release]).status).toBe(0);
    expect(f.run(["transition", tokenOne, "synced", "boundary"]).status).toBe(0);
    expect(f.run(["guardian-once"], { ATLAS_COORDINATOR_NOW_EPOCH: "111" }).status).toBe(0);
    expect(f.state()).toContain("status=failed_closed");
    expect(f.events()).toContain("label=com.docker.compose.project=atlas-v2");
    expect(f.events()).toContain("label=com.docker.compose.service=migrator");
    expect(f.events()).toMatch(/docker stop -- .*migrator-one-off/);

    const beforeBoot = f.events().match(/docker stop -- .*migrator-one-off/g)?.length ?? 0;
    expect(f.run(["guardian-once"], { ATLAS_COORDINATOR_NOW_EPOCH: "200" }).status).toBe(0);
    const afterBoot = f.events().match(/docker stop -- .*migrator-one-off/g)?.length ?? 0;
    expect(afterBoot).toBeGreaterThan(beforeBoot);
  });

  it("fails closed on malformed durable state without broad cleanup", () => {
    const f = fixture();
    expect(f.begin().status).toBe(0);
    writeFileSync(path.join(f.stateRoot, "active.state"), "not-valid-state\n", { mode: 0o600 });

    const reconciliation = f.run(["guardian-once"]);
    expect(reconciliation.status).not.toBe(0);
    expect(f.events()).toMatch(/docker stop -- .*migrator-one-off/);
    expect(existsSync(f.remote)).toBe(true);
    expect(existsSync(f.backups)).toBe(true);
  });

  it("atomically records a healthy release, completes the exact token, and retires its guardian state", () => {
    const f = fixture();
    expect(f.begin().status).toBe(0);
    expect(f.run(["transition", tokenOne, "prepared", "quiesced"]).status).toBe(0);
    expect(f.run(["transition", tokenOne, "quiesced", "syncing"]).status).toBe(0);
    expect(f.run(["guard", tokenOne, "syncing", "sync-release"]).status).toBe(0);
    expect(f.run(["transition", tokenOne, "syncing", "synced"]).status).toBe(0);
    expect(f.run(["candidate", tokenOne, release]).status).toBe(0);
    expect(f.run(["transition", tokenOne, "synced", "boundary"]).status).toBe(0);
    expect(f.run(["complete", tokenOne, release]).status).toBe(0);

    expect(readFileSync(path.join(f.remote, ".atlas-release"), "utf8")).toBe(`${release}\n`);
    expect(existsSync(path.join(f.stateRoot, "active.state"))).toBe(false);
    const completed = readdirSync(path.join(f.stateRoot, "history"));
    expect(completed).toEqual(expect.arrayContaining([
      `${tokenOne}.complete.state`,
      `${tokenOne}.previous-release`,
    ]));
    expect(readFileSync(path.join(f.stateRoot, "history", `${tokenOne}.complete.state`), "utf8"))
      .toContain("status=complete");
    expect(f.events()).toContain("systemctl disable --now atlas-v2-deployment-guardian.service");
  });

  it("handles stale completed state and blocks stale recovery failures explicitly", () => {
    const completed = fixture();
    expect(completed.begin().status).toBe(0);
    let state = completed.state().replace("status=prepared", "status=complete");
    writeFileSync(path.join(completed.stateRoot, "active.state"), state, { mode: 0o600 });
    expect(completed.begin(tokenTwo).status).toBe(0);
    expect(completed.state()).toContain(`token=${tokenTwo}`);

    const failed = fixture();
    expect(failed.begin(tokenOne, {
      FAKE_WRITER_SNAPSHOT: "web|running|web-exact\nworker|exited|worker-exact\n",
    }).status).toBe(0);
    expect(failed.run(["guardian-once"], {
      ATLAS_COORDINATOR_NOW_EPOCH: "111",
      FAKE_RESTART_FAIL: "1",
    }).status).not.toBe(0);
    expect(failed.state()).toContain("status=recovery_failed");
    expect(failed.begin(tokenTwo).stderr).toMatch(/operator resolution/i);
  });

  it("durably retires a trusted recovered state before admitting a replacement deployment", () => {
    const f = fixture();
    expect(f.begin().status).toBe(0);
    expect(f.run(["guardian-once"], { ATLAS_COORDINATOR_NOW_EPOCH: "111" }).status).toBe(0);
    expect(f.state()).toContain("status=recovered");

    expect(f.run(["retire-recovered"]).status).toBe(0);
    expect(existsSync(path.join(f.stateRoot, "active.state"))).toBe(false);
    expect(readdirSync(path.join(f.stateRoot, "history")))
      .toContain(`${tokenOne}.recovered.state`);
    expect(f.begin(tokenTwo).status).toBe(0);
    expect(f.state()).toContain(`token=${tokenTwo}`);
  });

  it("rejects expired ownership instead of resurrecting it through renew or assert", () => {
    const f = fixture();
    expect(f.begin().status).toBe(0);

    for (const command of [
      ["renew", tokenOne, "prepared"],
      ["assert", tokenOne, "prepared"],
    ]) {
      const result = f.run(command, { ATLAS_COORDINATOR_NOW_EPOCH: "111" });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toMatch(/expired/i);
    }
  });

  it.each(["build-db", "rotate-roles", "migrate", "start-writers", "verify-contract"])(
    "rejects a stale token before the %s guarded mutation",
    (action) => {
      const f = fixture();
      expect(f.begin().status).toBe(0);
      const before = f.events();
      const expectedPhase = action === "build-db" ? "quiesced" : "boundary";
      const result = f.run(["guard", tokenTwo, expectedPhase, action]);
      expect(result.status).not.toBe(0);
      expect(f.events()).toBe(before);
    },
  );

  it("heartbeats ownership through a guarded action longer than the minimum lease", () => {
    const f = fixture();
    const realTime = { ATLAS_COORDINATOR_NOW_EPOCH: "" };
    expect(f.run(["begin", tokenOne, f.remote, f.backups, "2", ...f.bundleArguments], realTime).status).toBe(0);
    expect(f.run(["transition", tokenOne, "prepared", "quiesced"], realTime).status).toBe(0);
    expect(f.run(["transition", tokenOne, "quiesced", "syncing"], realTime).status).toBe(0);
    expect(f.run(["transition", tokenOne, "syncing", "synced"], realTime).status).toBe(0);
    expect(f.run(["candidate", tokenOne, release], realTime).status).toBe(0);
    expect(f.run(["transition", tokenOne, "synced", "boundary"], realTime).status).toBe(0);

    const guarded = f.run(["guard", tokenOne, "boundary", "migrate"], {
      ...realTime,
      FAKE_GUARDED_ACTION_SECONDS: "3",
    });

    expect(guarded.status, guarded.stderr).toBe(0);
    expect(f.run(["assert", tokenOne, "boundary"], realTime).status).toBe(0);
  });

  it("expires a killed deployer mid-sync, kills its complete mutation group, and restores prior writers", async () => {
    const f = fixture();
    const realTime = { ATLAS_COORDINATOR_NOW_EPOCH: "" };
    expect(f.run(["begin", tokenOne, f.remote, f.backups, "2", ...f.bundleArguments], realTime).status).toBe(0);
    expect(f.run(["transition", tokenOne, "prepared", "quiesced"], realTime).status).toBe(0);
    expect(f.run(["transition", tokenOne, "quiesced", "syncing"], realTime).status).toBe(0);

    const mutationFile = path.join(f.root, "sync-mutations.log");
    const guarded = spawn("/bin/bash", [f.coordinator, "guard", tokenOne, "syncing", "sync-release"], {
      env: {
        ...f.environment,
        ...realTime,
        ATLAS_COORDINATOR_TEST_ACTION: "sync-release",
        ATLAS_COORDINATOR_TEST_MUTATION_FILE: mutationFile,
      },
      stdio: "ignore",
    });
    await waitForMutation(mutationFile);
    guarded.kill("SIGKILL");
    await waitForExit(guarded);

    await delay(2_200);
    const reconciliation = f.run(["guardian-once"], realTime);
    expect(reconciliation.status, reconciliation.stderr).toBe(0);
    expect(f.state()).toContain("status=recovered");
    expect(f.state()).toContain("action_name=none");
    expect(f.events()).toContain("docker start web-container");
    expect(f.events()).toContain("docker start worker-container");
    expect(f.events()).toContain(`application_name = 'atlas-deploy-${tokenOne}'`);
    await expectMutationStopped(mutationFile);
  });

  it("keeps a reaper leader alive and kills an orphan descendant after the direct action exits", async () => {
    const f = fixture();
    expect(f.begin().status).toBe(0);
    expect(f.run(["transition", tokenOne, "prepared", "quiesced"]).status).toBe(0);
    expect(f.run(["transition", tokenOne, "quiesced", "syncing"]).status).toBe(0);

    const mutationFile = path.join(f.root, "orphan-mutations.log");
    const guarded = spawn("/bin/bash", [f.coordinator, "guard", tokenOne, "syncing", "sync-release"], {
      env: {
        ...f.environment,
        ATLAS_COORDINATOR_TEST_ACTION: "sync-release",
        ATLAS_COORDINATOR_TEST_MUTATION_FILE: mutationFile,
        ATLAS_COORDINATOR_TEST_ORPHAN: "1",
      },
      stdio: "ignore",
    });
    await waitForMutation(mutationFile);
    const failed = f.run(["fail", tokenOne]);
    expect(failed.status, failed.stderr).toBe(0);

    expect(await waitForExit(guarded)).not.toBe(0);
    await expectMutationStopped(mutationFile);
  });

  it("restores the exact prior release tree and marker after a post-exchange failure", () => {
    const f = fixture();
    writeFileSync(path.join(f.remote, ".atlas-release"), `${release}\n`);
    writeFileSync(path.join(f.remote, "prior.txt"), "exact prior bytes\n");
    expect(f.begin().status).toBe(0);
    expect(f.run(["transition", tokenOne, "prepared", "quiesced"]).status).toBe(0);
    expect(f.run(["transition", tokenOne, "quiesced", "syncing"]).status).toBe(0);

    const promoted = f.run(["guard", tokenOne, "syncing", "sync-release"], {
      ATLAS_COORDINATOR_SYNC_FAULT: "after-exchange",
    });
    expect(promoted.status).not.toBe(0);
    expect(f.run(["guardian-once"], { ATLAS_COORDINATOR_NOW_EPOCH: "111" }).status).toBe(0);

    expect(f.state()).toContain("status=recovered");
    expect(readFileSync(path.join(f.remote, ".atlas-release"), "utf8")).toBe(`${release}\n`);
    expect(readFileSync(path.join(f.remote, "prior.txt"), "utf8")).toBe("exact prior bytes\n");
    expect(existsSync(path.join(f.remote, "candidate.txt"))).toBe(false);
  });

  it("archives the exact previous release tree only after successful completion", () => {
    const f = fixture();
    writeFileSync(path.join(f.remote, ".atlas-release"), `${release}\n`);
    writeFileSync(path.join(f.remote, "prior.txt"), "exact prior bytes\n");
    expect(f.begin().status).toBe(0);
    expect(f.run(["transition", tokenOne, "prepared", "quiesced"]).status).toBe(0);
    expect(f.run(["transition", tokenOne, "quiesced", "syncing"]).status).toBe(0);
    expect(f.run(["guard", tokenOne, "syncing", "sync-release"]).status).toBe(0);
    expect(f.run(["transition", tokenOne, "syncing", "synced"]).status).toBe(0);
    expect(f.run(["candidate", tokenOne, release]).status).toBe(0);
    expect(f.run(["transition", tokenOne, "synced", "boundary"]).status).toBe(0);
    expect(f.run(["complete", tokenOne, release]).status).toBe(0);

    const archivedTree = path.join(f.stateRoot, "history", `${tokenOne}.previous-release`);
    expect(readFileSync(path.join(archivedTree, "prior.txt"), "utf8")).toBe("exact prior bytes\n");
    expect(readFileSync(path.join(archivedTree, ".atlas-release"), "utf8")).toBe(`${release}\n`);
  });

  it("kills a TERM-resistant migration process tree when its durable phase changes", async () => {
    const f = fixture();
    expect(f.begin().status).toBe(0);
    expect(f.run(["transition", tokenOne, "prepared", "quiesced"]).status).toBe(0);
    expect(f.run(["transition", tokenOne, "quiesced", "syncing"]).status).toBe(0);
    expect(f.run(["transition", tokenOne, "syncing", "synced"]).status).toBe(0);
    expect(f.run(["candidate", tokenOne, release]).status).toBe(0);
    expect(f.run(["transition", tokenOne, "synced", "boundary"]).status).toBe(0);

    const mutationFile = path.join(f.root, "migration-mutations.log");
    const guarded = spawn("/bin/bash", [f.coordinator, "guard", tokenOne, "boundary", "migrate"], {
      env: {
        ...f.environment,
        ATLAS_COORDINATOR_TEST_ACTION: "migrate",
        ATLAS_COORDINATOR_TEST_MUTATION_FILE: mutationFile,
      },
      stdio: "ignore",
    });
    await waitForMutation(mutationFile);
    expect(f.run(["fail", tokenOne]).status).toBe(0);

    expect(await waitForExit(guarded)).not.toBe(0);
    expect(f.state()).toContain("status=failed_closed");
    expect(f.state()).toContain("action_name=none");
    await expectMutationStopped(mutationFile);
  });

  it("rejects tampered immutable recovery tools before executing them", () => {
    const backup = fixture();
    const backupMarker = path.join(backup.root, "tampered-backup-ran");
    expect(backup.begin().status).toBe(0);
    writeFileSync(
      backup.backupTool,
      `#!/usr/bin/env bash\nprintf ran > '${backupMarker}'\n`,
      { mode: 0o755 },
    );
    const guardedBackup = backup.run(["guard", tokenOne, "prepared", "backup"]);
    expect(guardedBackup.status).not.toBe(0);
    expect(guardedBackup.stderr).toMatch(/bundle hash mismatch/i);
    expect(existsSync(backupMarker)).toBe(false);
    expect(backup.events()).not.toContain("docker volume inspect atlas-db");
    expect(backup.events()).toContain(`label=atlas.deployment-token=${tokenOne}`);

    const restore = fixture();
    const marker = path.join(restore.root, "tampered-restore-ran");
    expect(restore.begin().status).toBe(0);
    writeFileSync(
      restore.restoreTool,
      `#!/usr/bin/env bash\nprintf ran > '${marker}'\n`,
      { mode: 0o755 },
    );
    const reconciliation = restore.run(["guardian-once"], { ATLAS_COORDINATOR_NOW_EPOCH: "111" });
    expect(reconciliation.status).not.toBe(0);
    expect(restore.state()).toContain("status=failed_closed");
    expect(existsSync(marker)).toBe(false);
  });

  it("uses durable fsync publication and never leaves a truncated transition on an injected crash", () => {
    const source = readFileSync(coordinatorSource, "utf8");
    expect(source).toMatch(/os\.fsync\(file_descriptor\)[\s\S]*os\.replace[\s\S]*os\.fsync\(directory_descriptor\)/);
    const f = fixture();
    expect(f.begin().status).toBe(0);
    const before = f.state();
    const crashed = f.run(
      ["transition", tokenOne, "prepared", "quiesced"],
      { ATLAS_COORDINATOR_FAULT: "after-file-fsync" },
    );
    expect(crashed.status).not.toBe(0);
    expect(f.state()).toBe(before);
    expect(f.run(["guardian-once"], { ATLAS_COORDINATOR_NOW_EPOCH: "111" }).status).toBe(0);
    expect(f.state()).not.toContain("status=prepared");
  });

  it("boot reconciliation never regresses a boundary published before a crash", () => {
    const f = fixture();
    expect(f.begin().status).toBe(0);
    expect(f.run(["transition", tokenOne, "prepared", "quiesced"]).status).toBe(0);
    expect(f.run(["transition", tokenOne, "quiesced", "syncing"]).status).toBe(0);
    expect(f.run(["transition", tokenOne, "syncing", "synced"]).status).toBe(0);
    const crashed = f.run(
      ["transition", tokenOne, "synced", "boundary"],
      { ATLAS_COORDINATOR_FAULT: "after-rename" },
    );
    expect(crashed.status).not.toBe(0);
    expect(f.state()).toContain("status=boundary");

    expect(f.run(["guardian-once"], { ATLAS_COORDINATOR_NOW_EPOCH: "111" }).status).toBe(0);
    expect(f.state()).toContain("status=failed_closed");
    expect(f.state()).not.toContain("status=quiesced");
  });

  it.skipIf(!realFlockPath)(
    "uses a real overlapping-process flock for guardian mutual exclusion",
    async () => {
      const f = fixture();
      const realPath = (process.env.PATH ?? "").split(":").filter((entry) => entry !== path.join(f.root, "bin")).join(":");
      const environment = {
        ...process.env,
        PATH: realPath,
        ATLAS_COORDINATOR_TEST_MODE: "1",
        ATLAS_COORDINATOR_STATE_ROOT: f.stateRoot,
        ATLAS_COORDINATOR_CONFIG_FILE: f.config,
        ATLAS_COORDINATOR_GLOBAL_LOCK: path.join(f.root, "real-global.lock"),
        ATLAS_COORDINATOR_INSTALL_LOCK: path.join(f.root, "real-install.lock"),
        ATLAS_COORDINATOR_PATH: f.coordinator,
        ATLAS_GUARDIAN_UNIT_PATH: path.join(f.root, "atlas-v2-deployment-guardian.service"),
        ATLAS_BACKUP_TOOL_PATH: f.backupTool,
        ATLAS_RESTORE_TOOL_PATH: f.restoreTool,
      };
      const guardian = spawn("/bin/bash", [path.join(f.root, "atlas-v2-deployment-coordinator"), "guardian"], {
        env: environment,
        stdio: "ignore",
      });
      await new Promise((resolve) => setTimeout(resolve, 150));
      try {
        const overlap = spawnSync(
          "/bin/bash",
          [path.join(f.root, "atlas-v2-deployment-coordinator"), "guardian-once"],
          { env: environment, encoding: "utf8" },
        );
        expect(overlap.status).not.toBe(0);
        expect(overlap.stderr).toMatch(/reconciliation lock/i);
      } finally {
        guardian.kill("SIGTERM");
        await new Promise((resolve) => guardian.once("exit", resolve));
      }
    },
  );

  it.skipIf(!hasSystemdManager)(
    "uses a real transient systemd cgroup that survives direct-leader exit and kills its descendants",
    async () => {
      const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "atlas-systemd-action-test-")));
      roots.push(root);
      const mutationFile = path.join(root, "mutations.log");
      const script = path.join(root, "orphan.sh");
      executable(script, `#!/usr/bin/env bash
(trap '' TERM; while true; do printf x >> '${mutationFile}'; /bin/sleep 0.02; done) &
exit 0
`);
      const unit = `atlas-v2-deploy-test-${randomUUID()}.service`;
      const started = spawnSync("systemd-run", [
        `--unit=${unit}`,
        "--service-type=exec",
        "--property=ExitType=cgroup",
        "--property=KillMode=control-group",
        "--property=TimeoutStopSec=2s",
        script,
      ], { encoding: "utf8" });
      expect(started.status, started.stderr).toBe(0);
      try {
        await waitForMutation(mutationFile);
        expect(spawnSync("systemctl", ["is-active", "--quiet", unit]).status).toBe(0);
        expect(spawnSync("systemctl", ["stop", unit]).status).toBe(0);
        expect(spawnSync("systemctl", ["is-active", "--quiet", unit]).status).not.toBe(0);
        await expectMutationStopped(mutationFile);
      } finally {
        spawnSync("systemctl", ["stop", unit]);
        spawnSync("systemctl", ["reset-failed", unit]);
      }
    },
  );

  it.skipIf(!realFlockPath)(
    "holds the real install lock through deployment ownership acquisition",
    async () => {
      const f = fixture();
      executable(path.join(f.bin, "flock"), `#!/usr/bin/env bash\nexec '${realFlockPath}' "$@"\n`);
      const held = path.join(f.root, "install-lock-held");
      const holder = spawn(
        "/bin/bash",
        ["-c", `exec 9>"$1"; '${realFlockPath}' -x 9; printf held > "$2"; /bin/sleep 0.5`, "_", path.join(f.root, "install.lock"), held],
        { env: f.environment, stdio: "ignore" },
      );
      await waitForMutation(held);
      const begin = spawn(
        "/bin/bash",
        [f.coordinator, "begin", tokenOne, f.remote, f.backups, "10", ...f.bundleArguments],
        { env: f.environment, stdio: "ignore" },
      );
      await delay(100);
      expect(existsSync(path.join(f.stateRoot, "active.state"))).toBe(false);
      expect(begin.exitCode).toBe(null);
      await waitForExit(holder);
      expect(await waitForExit(begin)).toBe(0);
      expect(f.state()).toContain(`token=${tokenOne}`);
    },
  );

  it.skipIf(!realFlockPath)(
    "serializes two real concurrent begin attempts and admits exactly one token",
    async () => {
      const f = fixture();
      executable(path.join(f.bin, "flock"), `#!/usr/bin/env bash\nexec '${realFlockPath}' "$@"\n`);
      const begin = (token: string) => spawn(
        "/bin/bash",
        [f.coordinator, "begin", token, f.remote, f.backups, "10", ...f.bundleArguments],
        { env: f.environment, stdio: "ignore" },
      );
      const first = begin(tokenOne);
      const second = begin(tokenTwo);
      const statuses = await Promise.all([waitForExit(first), waitForExit(second)]);
      expect(statuses.filter((status) => status === 0)).toHaveLength(1);
      expect(statuses.filter((status) => status !== 0)).toHaveLength(1);
      expect(f.state()).toMatch(new RegExp(`token=(${tokenOne}|${tokenTwo})`));
    },
  );
});
