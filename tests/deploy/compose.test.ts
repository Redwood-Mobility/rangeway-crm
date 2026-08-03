import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const repositoryRoot = path.resolve(import.meta.dirname, "../..");

function readRepositoryFile(relativePath: string): string {
  const absolutePath = path.join(repositoryRoot, relativePath);
  return existsSync(absolutePath) ? readFileSync(absolutePath, "utf8") : "";
}

function commandIncludes(command: unknown, expected: string): boolean {
  if (Array.isArray(command)) return command.join(" ").includes(expected);
  return typeof command === "string" && command.includes(expected);
}

function mountedSources(service: Record<string, unknown>): Map<string, string> {
  const mounts = Array.isArray(service.volumes) ? service.volumes : [];
  return new Map(
    mounts
      .filter((mount): mount is Record<string, unknown> => Boolean(mount) && typeof mount === "object")
      .map((mount) => [String(mount.source), String(mount.target)]),
  );
}

const composeProbe = spawnSync("docker", ["compose", "version"], {
  cwd: repositoryRoot,
  encoding: "utf8",
});
const hasDockerCompose = composeProbe.status === 0;
// The migrator sits behind the `operations` profile so it never runs as part of
// the default runtime. Resolving without that profile would correctly omit it,
// and these cases assert the complete topology including it.
function resolve(profiles: string[]) {
  return JSON.parse(
    execFileSync(
      "docker",
      ["compose", ...profiles.flatMap((profile) => ["--profile", profile]), "config", "--format", "json"],
      { cwd: repositoryRoot, encoding: "utf8" },
    ),
  ) as {
    services: Record<string, Record<string, unknown>>;
    volumes?: Record<string, unknown>;
  };
}

// The default topology is co-tenant: no Caddy, web on loopback for an existing
// reverse proxy. `edge` adds Caddy for a host Atlas owns outright.
const coTenantCompose = hasDockerCompose ? resolve(["operations"]) : undefined;
const resolvedCompose = hasDockerCompose
  ? (resolve(["operations", "edge"]) as {
      services: Record<string, Record<string, unknown>>;
      volumes?: Record<string, unknown>;
    })
  : undefined;

describe.skipIf(!hasDockerCompose)("resolved Docker Compose topology", () => {
  const compose = resolvedCompose!;

  it("contains the four runtime services plus the operations-only migrator", () => {
    expect(Object.keys(compose.services).sort()).toEqual(["caddy", "db", "migrator", "web", "worker"]);
  });

  it("leaves Caddy out of the default co-tenant topology", () => {
    // Starting Caddy on a host whose web server already owns 80/443 would
    // contend with every other site on it.
    expect(Object.keys(coTenantCompose!.services).sort()).toEqual([
      "db",
      "migrator",
      "web",
      "worker",
    ]);
  });

  it("publishes web on loopback only so a reverse proxy fronts it", () => {
    const published = coTenantCompose!.services.web.ports as Array<Record<string, unknown>>;
    expect(published).toHaveLength(1);
    expect(String(published[0].host_ip)).toBe("127.0.0.1");
    expect(Number(published[0].target)).toBe(8080);
    for (const [name, service] of Object.entries(coTenantCompose!.services)) {
      if (name === "web") continue;
      expect(service.ports ?? []).toEqual([]);
    }
  });

  it("runs web and worker without schema-owner credentials or startup migrations", () => {
    expect(compose.services.web.image).toBe(compose.services.worker.image);
    expect(commandIncludes(compose.services.web.command, "npm start")).toBe(true);
    expect(commandIncludes(compose.services.worker.command, "npm run start:worker")).toBe(true);
    expect(commandIncludes(compose.services.web.command, "db:migrate")).toBe(false);
    expect(commandIncludes(compose.services.worker.command, "db:migrate")).toBe(false);
    expect(compose.services.web.command).not.toEqual(compose.services.worker.command);
    expect(String((compose.services.web.environment as Record<string, unknown>).DATABASE_URL)).toContain("atlas_web:");
    expect(String((compose.services.worker.environment as Record<string, unknown>).DATABASE_URL)).toContain("atlas_worker:");
    expect(String((compose.services.migrator.environment as Record<string, unknown>).DATABASE_URL)).toContain("atlas_migrator:");
  });

  it("keeps PostgreSQL 17 private on the dedicated database volume", () => {
    expect(compose.services.db.image).toBe("postgres:17-bookworm");
    expect(mountedSources(compose.services.db).get("atlas-db")).toBe("/var/lib/postgresql/data");
    expect(compose.services.db.ports ?? []).toEqual([]);
  });

  it("uses no release-tree bind mount for privileged configuration", () => {
    const dbMounts = mountedSources(compose.services.db);
    const caddyMounts = mountedSources(compose.services.caddy);
    expect([...dbMounts.keys()]).not.toContain("./deploy/postgres/init-roles.sh");
    expect(caddyMounts.get("/usr/local/libexec/atlas-v2/Caddyfile")).toBe("/etc/caddy/Caddyfile");
  });

  it("shares the artifact volume with web and worker", () => {
    expect(mountedSources(compose.services.web).get("atlas-artifacts")).toBe("/app/artifacts");
    expect(mountedSources(compose.services.worker).get("atlas-artifacts")).toBe("/app/artifacts");
  });

  it("publishes the public ports from Caddy alone in the edge topology", () => {
    const caddyPorts = compose.services.caddy.ports as Array<Record<string, unknown>>;
    expect(caddyPorts.map((port) => Number(port.target)).sort((a, b) => a - b)).toEqual([80, 443]);
    for (const [serviceName, service] of Object.entries(compose.services)) {
      if (serviceName === "caddy") continue;
      // Web still binds loopback; nothing else reaches the public interface.
      for (const port of (service.ports ?? []) as Array<Record<string, unknown>>) {
        expect(String(port.host_ip)).toBe("127.0.0.1");
      }
    }
  });

  it("gates app processes on database health and exposes web health", () => {
    expect(compose.services.web.depends_on).toMatchObject({ db: { condition: "service_healthy" } });
    expect(compose.services.worker.depends_on).toMatchObject({ db: { condition: "service_healthy" } });
    expect(compose.services.migrator.depends_on).toMatchObject({ db: { condition: "service_healthy" } });
    expect(commandIncludes((compose.services.web.healthcheck as { test?: unknown }).test, "/api/v2/ready")).toBe(true);
    expect(commandIncludes((compose.services.worker.healthcheck as { test?: unknown }).test, "readiness.js")).toBe(true);
  });

  it("declares only V2 data and Caddy state volumes", () => {
    expect(Object.keys(compose.volumes ?? {}).sort()).toEqual([
      "atlas-artifacts",
      "atlas-db",
      "caddy-config",
      "caddy-data",
    ]);
  });
});

describe("deterministic deployment source contract", () => {
  const composeSource = readRepositoryFile("docker-compose.yml");
  const dockerfile = readRepositoryFile("Dockerfile");
  const caddyfile = readRepositoryFile("deploy/Caddyfile");
  const deployScript = readRepositoryFile("deploy/deploy.sh");
  const deploymentCoordinator = readRepositoryFile("deploy/deployment-coordinator.sh");
  const deploymentGuardianUnit = readRepositoryFile(
    "deploy/systemd/atlas-v2-deployment-guardian.service",
  );
  const backupScript = readRepositoryFile("deploy/backup.sh");
  const restoreScript = readRepositoryFile("deploy/restore-test.sh");
  const roleInitializationScript = readRepositoryFile("deploy/postgres/init-roles.sh");
  const packageJson = JSON.parse(readRepositoryFile("package.json")) as {
    scripts: Record<string, string>;
  };
  const productionEnvironment = readRepositoryFile("deploy/env.production.example");
  const dockerIgnore = readRepositoryFile(".dockerignore");

  it("defines the exact V2 services, images, commands, mounts, and health dependencies", () => {
    expect(composeSource).toMatch(/^name: atlas-v2$/m);
    expect(composeSource.match(/^  (web|worker|migrator|db|caddy):$/gm)?.map((line) => line.trim()).sort()).toEqual([
      "caddy:",
      "db:",
      "migrator:",
      "web:",
      "worker:",
    ]);
    expect(composeSource).toContain("postgres:17-bookworm");
    expect(composeSource).toContain('command: ["npm", "start"]');
    expect(composeSource).toContain('command: ["npm", "run", "start:worker"]');
    expect(composeSource).toContain('command: ["npm", "run", "db:migrate"]');
    expect(composeSource).toContain("profiles: [operations]");
    expect(composeSource).toContain("postgresql://atlas_web:");
    expect(composeSource).toContain("postgresql://atlas_worker:");
    expect(composeSource).toContain("postgresql://atlas_migrator:");
    expect(composeSource).toContain("atlas-db:/var/lib/postgresql/data");
    expect(composeSource.match(/atlas-artifacts:\/app\/artifacts/g)).toHaveLength(2);
    expect(composeSource.match(/condition: service_healthy/g)?.length).toBeGreaterThanOrEqual(3);
    expect(composeSource).toContain("pg_isready");
    expect(composeSource).toContain("/api/v2/ready");
    expect(composeSource).toContain("dist/worker/readiness.js");
  });

  it("never names or declares either preserved V1 application volume", () => {
    const deploymentSources = [
      composeSource,
      dockerfile,
      caddyfile,
      deployScript,
      backupScript,
      restoreScript,
    ].join("\n");
    expect(deploymentSources).not.toMatch(/(?:^|[_-])crm-data(?:$|[_-])/m);
    expect(deploymentSources).not.toMatch(/(?:^|[_-])crm-uploads(?:$|[_-])/m);
  });

  it("builds and runs a two-stage, non-root Node 22 production image", () => {
    expect(dockerfile.match(/^FROM node:22-bookworm(?:-slim)?/gm)).toHaveLength(2);
    expect(dockerfile).toContain("RUN npm ci");
    expect(dockerfile).toContain("RUN npm run typecheck");
    expect(dockerfile).toContain("RUN npm run build");
    expect(dockerfile).toContain("npm ci --omit=dev");
    expect(dockerfile).toContain("/app/artifacts");
    expect(dockerfile).not.toContain("mkdir -p /app/data");
    expect(dockerfile).not.toContain("mkdir -p /app/uploads");
    expect(dockerfile).toMatch(/^USER node$/m);
    for (const runtimePath of ["./dist", "./db/migrations", "./openapi"]) {
      expect(dockerfile).toContain(runtimePath);
    }
  });

  it("uses the compiled migration entrypoint and the Compose database hostname", () => {
    expect(packageJson.scripts["db:migrate"]).toBe("node dist/server/platform/db/migrate.js");
    expect(composeSource).toContain("@db:5432/atlas");
    for (const variable of [
      "POSTGRES_BOOTSTRAP_PASSWORD",
      "ATLAS_MIGRATOR_PASSWORD",
      "ATLAS_WEB_PASSWORD",
      "ATLAS_WORKER_PASSWORD",
    ]) {
      expect(productionEnvironment).toMatch(new RegExp(`^${variable}=.+$`, "m"));
    }
    expect(productionEnvironment).not.toMatch(/^DATABASE_URL=/m);
    expect(productionEnvironment).not.toMatch(/^POSTGRES_PASSWORD=/m);
  });

  it("constrains interpolated role passwords to one documented URL-safe alphabet", () => {
    expect(productionEnvironment).toMatch(/letters, numbers, underscore, or hyphen/i);
    expect(deployScript).toContain("^[A-Za-z0-9_-]{24,128}$");
    expect(roleInitializationScript).toContain("^[A-Za-z0-9_-]{24,128}$");
    for (const role of ["atlas_web", "atlas_worker", "atlas_migrator"] ) {
      expect(composeSource).toMatch(
        new RegExp(`postgresql://${role}:\\$\\{ATLAS_[A-Z_]+_PASSWORD:-\\}@db:5432/atlas`),
      );
    }
  });

  it("rotates every database role password in one PostgreSQL transaction", () => {
    const begin = roleInitializationScript.indexOf("BEGIN;");
    const firstPassword = roleInitializationScript.indexOf("ALTER ROLE atlas PASSWORD");
    const lastPassword = roleInitializationScript.indexOf("ALTER ROLE atlas_worker PASSWORD");
    const commit = roleInitializationScript.lastIndexOf("COMMIT;");
    expect(begin).toBeGreaterThan(0);
    expect(firstPassword).toBeGreaterThan(begin);
    expect(lastPassword).toBeGreaterThan(firstPassword);
    expect(commit).toBeGreaterThan(lastPassword);
  });

  it("proxies the production domain to the V2 web service", () => {
    expect(caddyfile).toMatch(/^atlas\.rangeway\.app \{$/m);
    expect(caddyfile).toContain("encode gzip zstd");
    expect(caddyfile).toContain("reverse_proxy web:8080");
    expect(caddyfile).toContain("Strict-Transport-Security");
    expect(caddyfile).toContain("X-Content-Type-Options");
    expect(caddyfile).toContain("/api/v2/health /api/v2/ready");
    expect(caddyfile).toContain('Cache-Control "no-store"');
  });

  it("stages immutable inputs, backs up before atomic promotion, and verifies the live V2 release", () => {
    const stagePosition = deployScript.indexOf("rsync -az --chmod=F600");
    const backupPosition = deployScript.indexOf('guard "${DEPLOYMENT_TOKEN}" prepared backup');
    const restorePosition = deployScript.indexOf('guard "${DEPLOYMENT_TOKEN}" prepared restore-backup');
    const syncPosition = deployScript.indexOf('guard "${DEPLOYMENT_TOKEN}" syncing sync-release');
    expect(stagePosition).toBeGreaterThan(0);
    expect(backupPosition).toBeGreaterThan(0);
    expect(backupPosition).toBeGreaterThan(stagePosition);
    expect(restorePosition).toBeGreaterThan(backupPosition);
    expect(syncPosition).toBeGreaterThan(restorePosition);
    expect(deployScript).toContain("npm test");
    expect(deployScript).toContain("npm run typecheck");
    expect(deployScript).toContain("npm run build");
    expect(deployScript).toContain("@redocly/cli lint openapi/atlas-v2.yaml");
    expect(deploymentCoordinator).toContain("BACKUP_TOOL_PATH");
    expect(deploymentCoordinator).toContain("RESTORE_TOOL_PATH");
    expect(deploymentCoordinator).not.toMatch(/\.\/deploy\/(?:backup|restore-test)\.sh/);
    expect(deploymentCoordinator).toContain("docker compose up -d db");
    expect(deploymentCoordinator).toContain("ROLE_INITIALIZER_PATH");
    expect(deploymentCoordinator).toMatch(/PGAPPNAME=atlas-deploy-\$\{token\}[\s\S]*db bash -s --/);
    expect(deploymentCoordinator).not.toContain("/docker-entrypoint-initdb.d/001-atlas-roles.sh");
    expect(deploymentCoordinator).toContain("docker compose --profile operations run --rm --label");
    expect(deploymentCoordinator).toContain("docker compose up -d --force-recreate caddy");
    expect(deploymentCoordinator.indexOf("docker compose build web worker")).toBeLessThan(
      deploymentCoordinator.indexOf("import('./dist/server/config.js')"),
    );
    expect(deploymentCoordinator).toContain("https://atlas.rangeway.app/api/v2/ready");
    expect(deploymentCoordinator).toContain("contractVersion");
    expect(deployScript).toContain("LOCAL_COMMIT");
    expect(deploymentCoordinator).toMatch(/worker.*healthy|healthy.*worker/s);
    expect(deployScript).toContain("verify-contract");
    expect(deployScript).toContain('guard "${DEPLOYMENT_TOKEN}" boundary verify-release');
    expect(deployScript).not.toMatch(/TARGET_HEALTH_RESPONSE|PUBLIC_HEALTH_RESPONSE|REMOTE_WORKER_HEALTH/);
    expect(deployScript).toContain("PREVIOUS_COMMIT");
    expect(deployScript).not.toMatch(/git reset|git checkout|docker volume rm|docker compose down -v/);
  });

  it("uses one durable, boot-reconciled coordinator around the compatibility boundary", () => {
    expect(deployScript).toContain("atlas-v2-deployment-coordinator");
    expect(deployScript).toMatch(/ATLAS_COORDINATOR_INSTALL_LOCK_HELD=1 exec[^\n]*coordinator[^\n]*begin/);
    expect(deployScript).toContain('run_coordinator transition "${DEPLOYMENT_TOKEN}" quiesced syncing');
    expect(deployScript).toContain('run_coordinator transition "${DEPLOYMENT_TOKEN}" syncing synced');
    expect(deployScript).toContain('run_coordinator transition "${DEPLOYMENT_TOKEN}" synced boundary');
    expect(deployScript).toContain('run_coordinator complete "${DEPLOYMENT_TOKEN}" "${LOCAL_COMMIT}"');
    expect(deployScript).not.toMatch(/setsid|\.lease\.sh|\.atlas-preflight-handoffs/);
    expect(deploymentCoordinator).toContain("flock -n 9");
    expect(deploymentCoordinator).toContain('status="failed_closed"');
    expect(deploymentCoordinator).toContain("restore_exact_writers");
    expect(deploymentCoordinator).toContain("for service in web worker migrator");
    expect(deploymentCoordinator).toContain('label=com.docker.compose.service=${service}');
    expect(deploymentCoordinator).toContain('label=com.docker.compose.project=${COMPOSE_PROJECT}');
    expect(deploymentCoordinator).toContain('COMPOSE_PROJECT="atlas-v2"');
    expect(deploymentCoordinator).toContain('label=atlas.deployment-token=${requested_token}');
    expect(deploymentCoordinator).not.toMatch(/docker compose down/);
    expect(deploymentGuardianUnit).toContain("WantedBy=multi-user.target");
    expect(deploymentGuardianUnit).toContain("Restart=on-failure");
    expect(deployScript.indexOf("synced boundary")).toBeLessThan(
      deployScript.indexOf('guard "${DEPLOYMENT_TOKEN}" boundary rotate-roles'),
    );
  });

  it("creates complete, checksummed PostgreSQL and artifact backups without retention deletion", () => {
    for (const filename of [
      "atlas-postgres.dump",
      "atlas-artifacts.tgz",
      "manifest.sha256",
      "metadata.txt",
    ]) {
      expect(backupScript).toContain(filename);
    }
    expect(backupScript).toContain("pg_dump --format=custom");
    expect(backupScript).toContain('ATLAS_BACKUP_FORMAT="atlas-v2-postgres-artifacts-v1"');
    expect(backupScript).toContain("ATLAS_REPOSITORY_ROOT");
    expect(backupScript).toContain("--repository-root");
    expect(backupScript).not.toMatch(/dirname -- "\$\{BASH_SOURCE\[0\]\}"/);
    expect(backupScript).toContain('ARTIFACT_VOLUME_NAME="${ATLAS_ARTIFACT_VOLUME_NAME:-atlas-artifacts}"');
    expect(backupScript).toContain('DB_VOLUME_NAME="${ATLAS_DB_VOLUME_NAME:-atlas-db}"');
    expect(backupScript).toContain("label=com.docker.compose.project=${COMPOSE_PROJECT_NAME}");
    expect(backupScript).toContain("label=com.docker.compose.service=${service}");
    expect(backupScript).toContain('docker exec "${DB_CONTAINER}"');
    expect(backupScript).toContain('docker stop -- "${WEB_CONTAINER}"');
    expect(backupScript).toContain('docker start -- "${WEB_CONTAINER}"');
    expect(backupScript).toContain("ATLAS_BACKUP_GLOBAL_LOCK");
    expect(backupScript).toContain("ATLAS_BACKUP_STATE_ROOT");
    expect(backupScript).toMatch(/flock -n -x 9|flock -n 9/);
    expect(backupScript).toContain("ATLAS_BACKUP_ACTION_PID");
    expect(backupScript).toContain("action_name");
    expect(backupScript).toContain("deadline_epoch");
    expect(backupScript).toMatch(/stat -c ['"]%U:%G:%a['"] ["']?\$\{ACTIVE_STATE\}/);
    expect(backupScript).toContain(".State.Paused");
    expect(backupScript).toContain(".State.Restarting");
    expect(deploymentCoordinator).toContain('ATLAS_BACKUP_ACTION_NAME="backup"');
    expect(deploymentCoordinator).toContain('ATLAS_BACKUP_ACTION_PHASE="prepared"');
    expect(deploymentCoordinator).toContain('ATLAS_BACKUP_ACTION_PID="${action_pid}"');
    expect(deploymentCoordinator).toContain('ATLAS_BACKUP_ACTION_UNIT="${action_unit}"');
    expect(backupScript).not.toMatch(/docker compose/);
    expect(backupScript).toContain("sha256sum");
    expect(backupScript).toMatch(/-s .*atlas-postgres\.dump/);
    expect(backupScript).toMatch(/-s .*atlas-artifacts\.tgz/);
    const exactPendingCleanup = 'rm -rf -- "${PENDING_DIR}"';
    expect(backupScript).toContain(exactPendingCleanup);
    expect(backupScript.replace(exactPendingCleanup, "")).not.toMatch(
      /(^|\s)rm\s|docker volume rm|find .*delete/,
    );
  });

  it("restore testing verifies integrity and uses explicit unique temporary resources", () => {
    expect(restoreScript).toContain("sha256sum --check manifest.sha256");
    expect(restoreScript).toContain("pg_restore");
    expect(restoreScript).toContain("schema_migrations");
    expect(restoreScript).toContain("Rangeway");
    expect(restoreScript).toContain("unreleased-v2-foundation");
    expect(restoreScript).toContain("migration_set_sha256");
    expect(restoreScript).toContain("mktemp -d");
    expect(restoreScript).toContain("atlas_restore_");
    expect(restoreScript).toContain("docker volume create");
    expect(restoreScript).toContain("docker volume rm");
    expect(restoreScript).not.toMatch(/docker compose|docker system prune/);
  });

  it("accepts a backup after the mutable Rangeway organization name has changed", () => {
    expect(restoreScript).toContain("00000000-0000-4000-8000-000000000001");
    expect(restoreScript).not.toMatch(/name\s*=\s*'Rangeway'/);
  });

  it("uses the same complete known relation set for zero-provenance backup and restore proof", () => {
    const knownRelations = [
      "organizations",
      "users",
      "actors",
      "organization_memberships",
      "audit_events",
      "outbox_events",
      "api_idempotency_keys",
    ];

    for (const relation of knownRelations) {
      expect(backupScript, `backup relation ${relation}`).toContain(`'${relation}'`);
      expect(restoreScript, `restore relation ${relation}`).toContain(`'${relation}'`);
    }
    expect(backupScript).toContain("to_regclass('public.schema_migrations') IS NULL");
    expect(restoreScript).toContain("to_regclass('public.schema_migrations') IS NULL");
  });

  it("reports restore success only after temporary resources are removed", () => {
    const finalCleanupPosition = restoreScript.lastIndexOf("cleanup_resources");
    const successPosition = restoreScript.indexOf("Restore test passed");
    expect(finalCleanupPosition).toBeGreaterThan(0);
    expect(successPosition).toBeGreaterThan(finalCleanupPosition);
  });

  it("excludes secrets and mutable state from the Docker build context", () => {
    for (const excluded of [
      ".env*",
      "deploy/env.production*",
      "/artifacts",
      "/data",
      "/uploads",
      "/backups",
      "/staging",
      "/.worktrees",
    ]) {
      expect(dockerIgnore).toContain(excluded);
    }
    expect(dockerIgnore).toContain("!/.env.example");
    expect(dockerIgnore).toContain("!deploy/env.production.example");
  });

  it.each(["deploy/deploy.sh", "deploy/backup.sh", "deploy/restore-test.sh"])(
    "%s has valid shell syntax",
    (scriptPath) => {
      expect(spawnSync("bash", ["-n", scriptPath], { cwd: repositoryRoot }).status).toBe(0);
    },
  );

  it.each([
    { argument: undefined, label: "an omitted path" },
    { argument: "", label: "an empty path" },
    { argument: "/", label: "the filesystem root" },
    { argument: process.env.HOME, label: "the user home" },
    { argument: "atlas-db", label: "the live database volume" },
    { argument: "atlas-artifacts", label: "the live artifact volume" },
    { argument: "backups/*", label: "an unresolved glob" },
  ])("restore testing refuses $label before invoking Docker", ({ argument }) => {
    const args = ["deploy/restore-test.sh", ...(argument === undefined ? [] : [argument])];
    const result = spawnSync("bash", args, {
      cwd: repositoryRoot,
      encoding: "utf8",
      env: { ...process.env, PATH: "/usr/bin:/bin", HOME: process.env.HOME ?? "/nonexistent" },
    });

    expect(result.status).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toMatch(/refus|required|unsafe/i);
    expect(`${result.stdout}${result.stderr}`).not.toMatch(/docker: command not found/i);
  });
});
