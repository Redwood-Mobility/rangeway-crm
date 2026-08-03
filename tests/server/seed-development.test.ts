import argon2 from "argon2";
import { readFile, readdir } from "node:fs/promises";
import type { Pool } from "pg";
import { describe, expect, it, type TestContext } from "vitest";
import { createPool } from "../../src/server/platform/db/client.js";
import {
  readDevelopmentSeedInput,
  seedDevelopmentOwner,
} from "../../src/server/platform/db/seed-development.js";
import {
  createTemporaryDatabase,
  PostgreSqlUnavailableError,
} from "../helpers/database.js";

const validEnvironment = {
  NODE_ENV: "development",
  AUTH_MODE: "local",
  DATABASE_URL: "postgresql://atlas:atlas@localhost:5432/atlas",
  ATLAS_DEV_OWNER_EMAIL: " owner@rangeway.energy ",
  ATLAS_DEV_OWNER_NAME: " Rangeway Owner ",
  ATLAS_DEV_OWNER_PASSWORD: "development-owner-password",
};

async function equippedMigrationCount(): Promise<string> {
  const entries = await readdir("db/migrations", { withFileTypes: true });
  return String(
    entries.filter(
      (entry) => entry.isFile() && /^\d{4}_.+\.sql$/.test(entry.name),
    ).length,
  );
}

async function withTemporaryPostgreSql(
  context: TestContext,
  operation: (pool: Pool, databaseUrl: string) => Promise<void>,
): Promise<void> {
  let temporaryDatabase;
  try {
    temporaryDatabase = await createTemporaryDatabase();
  } catch (error) {
    if (error instanceof PostgreSqlUnavailableError) {
      context.skip(error.message);
      return;
    }
    throw error;
  }

  const pool = createPool(temporaryDatabase.databaseUrl);
  try {
    await operation(pool, temporaryDatabase.databaseUrl);
  } finally {
    await pool.end();
    await temporaryDatabase.cleanup();
  }
}

describe("development owner seed", () => {
  it("exposes only an explicit compiled development seed command", async () => {
    const packageJson = JSON.parse(await readFile("package.json", "utf8")) as {
      scripts: Record<string, string>;
    };
    const environmentExample = await readFile(".env.example", "utf8");

    expect(packageJson.scripts["db:seed:development"]).toBe(
      "node dist/server/platform/db/seed-development.js",
    );
    expect(packageJson.scripts.start).not.toContain("seed");
    expect(packageJson.scripts["start:worker"]).not.toContain("seed");
    expect(environmentExample).toContain("ATLAS_DEV_OWNER_EMAIL=");
    expect(environmentExample).toContain("ATLAS_DEV_OWNER_NAME=");
    expect(environmentExample).toContain("ATLAS_DEV_OWNER_PASSWORD=");
  });

  it("provides an explicit seed module instead of seeding during application startup", async () => {
    const seedModule = await import(
      "../../src/server/platform/db/seed-development.js"
    ).catch(() => null);

    expect(seedModule).not.toBeNull();
    expect(seedModule?.readDevelopmentSeedInput).toEqual(expect.any(Function));
    expect(seedModule?.seedDevelopmentOwner).toEqual(expect.any(Function));
  });

  it.each([
    [{ ...validEnvironment, NODE_ENV: "production" }, "NODE_ENV=development"],
    [{ ...validEnvironment, NODE_ENV: "test" }, "NODE_ENV=development"],
    [{ ...validEnvironment, AUTH_MODE: "google" }, "AUTH_MODE=local"],
  ])("refuses production, test, and non-local authentication environments", (environment, message) => {
    expect(() => readDevelopmentSeedInput(environment)).toThrow(message);
  });

  it.each([
    "DATABASE_URL",
    "ATLAS_DEV_OWNER_EMAIL",
    "ATLAS_DEV_OWNER_NAME",
    "ATLAS_DEV_OWNER_PASSWORD",
  ])("requires an explicit %s value", (field) => {
    expect(() =>
      readDevelopmentSeedInput({ ...validEnvironment, [field]: "" }),
    ).toThrow(field);
  });

  it("normalizes only non-secret owner metadata", () => {
    expect(readDevelopmentSeedInput(validEnvironment)).toEqual({
      databaseUrl: validEnvironment.DATABASE_URL,
      email: "owner@rangeway.energy",
      displayName: "Rangeway Owner",
      password: validEnvironment.ATLAS_DEV_OWNER_PASSWORD,
    });
  });

  it("migrates first and idempotently creates one Argon2id Rangeway owner", async (context) => {
    await withTemporaryPostgreSql(context, async (pool, databaseUrl) => {
      const expectedMigrationCount = await equippedMigrationCount();
      const input = readDevelopmentSeedInput({
        ...validEnvironment,
        DATABASE_URL: databaseUrl,
      });

      await expect(seedDevelopmentOwner(input)).resolves.toBe("created");
      await expect(seedDevelopmentOwner(input)).resolves.toBe("existing");

      const result = await pool.query<{
        email: string;
        display_name: string;
        local_password_hash: string;
        actor_type: string;
        actor_role: string;
        membership_role: string;
        migration_count: string;
      }>(
        `SELECT u.email::text AS email,
                u.display_name,
                u.local_password_hash,
                a.type::text AS actor_type,
                a.role::text AS actor_role,
                m.role::text AS membership_role,
                (SELECT COUNT(*)::text FROM schema_migrations) AS migration_count
           FROM users u
           JOIN actors a ON a.user_id = u.id
           JOIN organization_memberships m
             ON m.organization_id = a.organization_id
            AND m.user_id = u.id
          WHERE a.organization_id = '00000000-0000-4000-8000-000000000001'`,
      );

      expect(result.rows).toHaveLength(1);
      expect(result.rows[0]).toMatchObject({
        email: "owner@rangeway.energy",
        display_name: "Rangeway Owner",
        actor_type: "human",
        actor_role: "owner",
        membership_role: "owner",
        migration_count: expectedMigrationCount,
      });
      expect(result.rows[0]?.local_password_hash).toMatch(/^\$argon2id\$/);
      await expect(
        argon2.verify(
          result.rows[0]!.local_password_hash,
          validEnvironment.ATLAS_DEV_OWNER_PASSWORD,
        ),
      ).resolves.toBe(true);

      await expect(
        seedDevelopmentOwner({ ...input, password: "different-owner-password" }),
      ).rejects.toThrow("already exists with different credentials or role");
      expect(JSON.stringify(result.rows)).not.toContain(
        validEnvironment.ATLAS_DEV_OWNER_PASSWORD,
      );
    });
  });
});
