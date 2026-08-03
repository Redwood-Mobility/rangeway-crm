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
const coordinatorSource = path.join(sourceRoot, "deploy/deployment-coordinator.sh");
const roots: string[] = [];
const tokenOne = "10000000-0000-4000-8000-000000000001";
const tokenTwo = "20000000-0000-4000-8000-000000000001";
const release = "a".repeat(40);

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function executable(filename: string, source: string): void {
  writeFileSync(filename, source, { mode: 0o755 });
  chmodSync(filename, 0o755);
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
  mkdirSync(bin, { recursive: true });
  mkdirSync(remote, { recursive: true });
  mkdirSync(backups, { recursive: true });
  copyFileSync(coordinatorSource, coordinator);
  chmodSync(coordinator, 0o755);

  executable(path.join(bin, "docker"), `#!/usr/bin/env bash
set -euo pipefail
printf 'docker %s\n' "$*" >> "${log}"
if [[ "$*" == *"compose ps --all --format"* ]]; then
  printf '%b' "\${FAKE_WRITER_SNAPSHOT:-web|running|web-container\\nworker|running|worker-container\\n}"
  exit 0
fi
if [[ "\${1:-}" == "start" && "\${FAKE_RESTART_FAIL:-0}" == "1" ]]; then exit 70; fi
exit 0
`);
  executable(path.join(bin, "systemctl"), `#!/usr/bin/env bash
set -euo pipefail
printf 'systemctl %s\n' "$*" >> "${log}"
case "$*" in
  "enable --now atlas-v2-deployment-guardian.service"|"restart atlas-v2-deployment-guardian.service")
    "${coordinator}" guardian-once
    ;;
  "is-active --quiet atlas-v2-deployment-guardian.service") exit 0 ;;
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
    ATLAS_COORDINATOR_NOW_EPOCH: "100",
  };
  const run = (args: string[], overrides: NodeJS.ProcessEnv = {}) =>
    spawnSync("/bin/bash", [coordinator, ...args], {
      encoding: "utf8",
      env: { ...environment, ...overrides },
    });
  const begin = (token = tokenOne, overrides: NodeJS.ProcessEnv = {}) =>
    run(["begin", token, remote, backups, "10"], overrides);
  const state = () => readFileSync(path.join(stateRoot, "active.state"), "utf8");
  const events = () => existsSync(log) ? readFileSync(log, "utf8") : "";
  return { root, remote, backups, stateRoot, config, run, begin, state, events };
}

describe("host-wide durable deployment coordinator", () => {
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
    expect(f.run(["transition", tokenOne, "quiesced", "boundary"]).status).toBe(0);
    expect(f.run(["guardian-once"], { ATLAS_COORDINATOR_NOW_EPOCH: "111" }).status).toBe(0);
    expect(f.state()).toContain("status=failed_closed");
    expect(f.events()).toContain("docker compose stop web worker");

    const beforeBoot = f.events().match(/docker compose stop web worker/g)?.length ?? 0;
    expect(f.run(["guardian-once"], { ATLAS_COORDINATOR_NOW_EPOCH: "200" }).status).toBe(0);
    const afterBoot = f.events().match(/docker compose stop web worker/g)?.length ?? 0;
    expect(afterBoot).toBeGreaterThan(beforeBoot);
  });

  it("fails closed on malformed durable state without broad cleanup", () => {
    const f = fixture();
    expect(f.begin().status).toBe(0);
    writeFileSync(path.join(f.stateRoot, "active.state"), "not-valid-state\n", { mode: 0o600 });

    const reconciliation = f.run(["guardian-once"]);
    expect(reconciliation.status).not.toBe(0);
    expect(f.events()).toContain("docker compose stop web worker");
    expect(existsSync(f.remote)).toBe(true);
    expect(existsSync(f.backups)).toBe(true);
  });

  it("atomically records a healthy release, completes the exact token, and retires its guardian state", () => {
    const f = fixture();
    expect(f.begin().status).toBe(0);
    expect(f.run(["transition", tokenOne, "prepared", "quiesced"]).status).toBe(0);
    expect(f.run(["transition", tokenOne, "quiesced", "boundary"]).status).toBe(0);
    expect(f.run(["complete", tokenOne, release]).status).toBe(0);

    expect(readFileSync(path.join(f.remote, ".atlas-release"), "utf8")).toBe(`${release}\n`);
    expect(existsSync(path.join(f.stateRoot, "active.state"))).toBe(false);
    const completed = readdirSync(path.join(f.stateRoot, "history"));
    expect(completed).toEqual([`${tokenOne}.complete.state`]);
    expect(readFileSync(path.join(f.stateRoot, "history", completed[0]!), "utf8"))
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
});
