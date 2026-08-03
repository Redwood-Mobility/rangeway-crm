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
const resolvedCompose = hasDockerCompose
  ? (JSON.parse(
      execFileSync("docker", ["compose", "config", "--format", "json"], {
        cwd: repositoryRoot,
        encoding: "utf8",
      }),
    ) as {
      services: Record<string, Record<string, unknown>>;
      volumes?: Record<string, unknown>;
    })
  : undefined;

describe.skipIf(!hasDockerCompose)("resolved Docker Compose topology", () => {
  const compose = resolvedCompose!;

  it("contains exactly the four Atlas V2 services", () => {
    expect(Object.keys(compose.services).sort()).toEqual(["caddy", "db", "web", "worker"]);
  });

  it("runs web and worker from one image with different commands", () => {
    expect(compose.services.web.image).toBe(compose.services.worker.image);
    expect(commandIncludes(compose.services.web.command, "npm run db:migrate && npm start")).toBe(true);
    expect(commandIncludes(compose.services.worker.command, "npm run db:migrate && npm run start:worker")).toBe(true);
    expect(compose.services.web.command).not.toEqual(compose.services.worker.command);
  });

  it("keeps PostgreSQL 17 private on the dedicated database volume", () => {
    expect(compose.services.db.image).toBe("postgres:17-bookworm");
    expect(mountedSources(compose.services.db).get("atlas-db")).toBe("/var/lib/postgresql/data");
    expect(compose.services.db.ports ?? []).toEqual([]);
  });

  it("shares the artifact volume with web and worker", () => {
    expect(mountedSources(compose.services.web).get("atlas-artifacts")).toBe("/app/artifacts");
    expect(mountedSources(compose.services.worker).get("atlas-artifacts")).toBe("/app/artifacts");
  });

  it("publishes ports from Caddy only", () => {
    for (const [serviceName, service] of Object.entries(compose.services)) {
      if (serviceName === "caddy") {
        expect(Array.isArray(service.ports) && service.ports.length > 0).toBe(true);
      } else {
        expect(service.ports ?? []).toEqual([]);
      }
    }
  });

  it("gates app processes on database health and exposes web health", () => {
    expect(compose.services.web.depends_on).toMatchObject({ db: { condition: "service_healthy" } });
    expect(compose.services.worker.depends_on).toMatchObject({ db: { condition: "service_healthy" } });
    expect(commandIncludes((compose.services.web.healthcheck as { test?: unknown }).test, "/api/v2/health")).toBe(true);
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
  const backupScript = readRepositoryFile("deploy/backup.sh");
  const restoreScript = readRepositoryFile("deploy/restore-test.sh");
  const packageJson = JSON.parse(readRepositoryFile("package.json")) as {
    scripts: Record<string, string>;
  };
  const productionEnvironment = readRepositoryFile("deploy/env.production.example");

  it("defines the exact V2 services, images, commands, mounts, and health dependencies", () => {
    expect(composeSource).toMatch(/^name: atlas-v2$/m);
    expect(composeSource.match(/^  (web|worker|db|caddy):$/gm)?.map((line) => line.trim()).sort()).toEqual([
      "caddy:",
      "db:",
      "web:",
      "worker:",
    ]);
    expect(composeSource).toContain("postgres:17-bookworm");
    expect(composeSource).toContain("npm run db:migrate && npm start");
    expect(composeSource).toContain("npm run db:migrate && npm run start:worker");
    expect(composeSource).toContain("atlas-db:/var/lib/postgresql/data");
    expect(composeSource.match(/atlas-artifacts:\/app\/artifacts/g)).toHaveLength(2);
    expect(composeSource.match(/condition: service_healthy/g)?.length).toBeGreaterThanOrEqual(3);
    expect(composeSource).toContain("pg_isready");
    expect(composeSource).toContain("/api/v2/health");
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
    expect(productionEnvironment).toContain("@db:5432/atlas");
    expect(productionEnvironment).toMatch(/^POSTGRES_PASSWORD=.+$/m);
  });

  it("proxies the production domain to the V2 web service", () => {
    expect(caddyfile).toMatch(/^atlas\.rangeway\.app \{$/m);
    expect(caddyfile).toContain("encode gzip zstd");
    expect(caddyfile).toContain("reverse_proxy web:8080");
    expect(caddyfile).toContain("Strict-Transport-Security");
    expect(caddyfile).toContain("X-Content-Type-Options");
  });

  it("backs up before replacement and verifies migration, startup, and live V2 health", () => {
    const backupPosition = deployScript.indexOf("deploy/backup.sh");
    const syncPosition = deployScript.indexOf('rsync "${RSYNC_TREE_ARGS[@]}"');
    expect(backupPosition).toBeGreaterThan(0);
    expect(syncPosition).toBeGreaterThan(backupPosition);
    expect(deployScript).toContain("npm test");
    expect(deployScript).toContain("npm run typecheck");
    expect(deployScript).toContain("npm run build");
    expect(deployScript).toContain("@redocly/cli lint openapi/atlas-v2.yaml");
    expect(deployScript).toContain("docker compose up -d db");
    expect(deployScript).toContain("docker compose run --rm web npm run db:migrate");
    expect(deployScript).toContain("docker compose up -d web worker caddy");
    expect(deployScript).toContain("https://atlas.rangeway.app/api/v2/health");
    expect(deployScript).toContain("apiVersion");
    expect(deployScript).toContain("PREVIOUS_COMMIT");
    expect(deployScript).not.toMatch(/git reset|git checkout|docker volume rm|docker compose down -v/);
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
    expect(backupScript).toContain("atlas-artifacts:/artifacts:ro");
    expect(backupScript).toContain("sha256sum");
    expect(backupScript).toMatch(/-s .*atlas-postgres\.dump/);
    expect(backupScript).toMatch(/-s .*atlas-artifacts\.tgz/);
    expect(backupScript).not.toMatch(/(^|\s)rm\s|docker volume rm|find .*delete/);
  });

  it("restore testing verifies integrity and uses explicit unique temporary resources", () => {
    expect(restoreScript).toContain("sha256sum --check manifest.sha256");
    expect(restoreScript).toContain("pg_restore");
    expect(restoreScript).toContain("schema_migrations");
    expect(restoreScript).toContain("Rangeway");
    expect(restoreScript).toContain("mktemp -d");
    expect(restoreScript).toContain("atlas_restore_");
    expect(restoreScript).toContain("docker volume create");
    expect(restoreScript).toContain("docker volume rm");
    expect(restoreScript).not.toMatch(/docker compose down|docker system prune/);
  });

  it("reports restore success only after temporary resources are removed", () => {
    const finalCleanupPosition = restoreScript.lastIndexOf("cleanup_resources");
    const successPosition = restoreScript.indexOf("Restore test passed");
    expect(finalCleanupPosition).toBeGreaterThan(0);
    expect(successPosition).toBeGreaterThan(finalCleanupPosition);
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
