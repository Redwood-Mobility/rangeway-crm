import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { Pool, PoolClient } from "pg";
import { describe, expect, it, type TestContext } from "vitest";
import { ApiError } from "../../src/server/platform/http/api-error.js";
import { createPool } from "../../src/server/platform/db/client.js";
import { runMigrations } from "../../src/server/platform/db/migrate.js";
import {
  IdentityRepository,
  type CreateHumanUserInput,
  type CreateServiceActorInput,
  type HumanActorRecord,
  type IdentityRepositoryPort,
  type ServiceActorRecord,
} from "../../src/server/modules/identity/identity.repository.js";
import { IdentityService } from "../../src/server/modules/identity/identity.service.js";
import {
  createTemporaryDatabase,
  PostgreSqlUnavailableError,
} from "../helpers/database.js";

const organizationId = "00000000-0000-4000-8000-000000000001";

function fakePool(transactionStatements: string[] = []): Pool {
  const client = {
    query: async (sql: string) => {
      transactionStatements.push(sql);
      return { rows: [], rowCount: 0 };
    },
    release: () => undefined,
  } as unknown as PoolClient;

  return { connect: async () => client } as unknown as Pool;
}

function humanRecord(overrides: Partial<HumanActorRecord> = {}): HumanActorRecord {
  return {
    actorId: randomUUID(),
    actorType: "human",
    actorName: "Zak Winnick",
    organizationId,
    role: "owner",
    userId: randomUUID(),
    email: "zak@winnick.io",
    localPasswordHash: null,
    actorDisabledAt: null,
    userDisabledAt: null,
    ...overrides,
  };
}

class MemoryIdentityRepository implements IdentityRepositoryPort {
  human = humanRecord();
  service: ServiceActorRecord | null = null;
  createHumanInput: CreateHumanUserInput | null = null;
  createServiceInput: CreateServiceActorInput | null = null;
  storedPrefix: string | null = null;
  storedHash: string | null = null;
  duplicateHuman = false;

  async createHumanUser(input: CreateHumanUserInput): Promise<HumanActorRecord> {
    this.createHumanInput = input;
    if (this.duplicateHuman) {
      throw Object.assign(new Error("duplicate key value violates unique constraint"), {
        code: "23505",
        constraint: "users_email_key",
      });
    }
    this.human = humanRecord({
      organizationId: input.organizationId,
      email: input.email,
      actorName: input.displayName,
      role: input.role,
      localPasswordHash: input.localPasswordHash ?? null,
    });
    return this.human;
  }

  async findHumanActorByEmail(): Promise<HumanActorRecord | null> {
    return this.human;
  }

  async createServiceActor(
    input: CreateServiceActorInput,
    serviceKeyPrefix: string,
    serviceKeyHash: string,
  ): Promise<ServiceActorRecord> {
    this.createServiceInput = input;
    this.storedPrefix = serviceKeyPrefix;
    this.storedHash = serviceKeyHash;
    this.service = {
      actorId: randomUUID(),
      actorType: input.actorType,
      actorName: input.displayName,
      organizationId: input.organizationId,
      role: input.role,
      serviceKeyPrefix,
      serviceKeyHash,
      disabledAt: null,
    };
    return this.service;
  }

  async findServiceActorByPrefix(prefix: string): Promise<ServiceActorRecord | null> {
    return this.service?.serviceKeyPrefix === prefix ? this.service : null;
  }

  async disableActor(
    scopedOrganizationId: string,
    actorId: string,
    disabledAt: Date,
  ): Promise<boolean> {
    if (
      this.service?.organizationId === scopedOrganizationId &&
      this.service.actorId === actorId
    ) {
      this.service = { ...this.service, disabledAt };
      return true;
    }
    return false;
  }
}

async function withTemporaryPostgreSql(
  context: TestContext,
  operation: (pool: Pool) => Promise<void>,
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
    await runMigrations(pool);
    await operation(pool);
  } finally {
    await pool.end();
    await temporaryDatabase.cleanup();
  }
}

describe("IdentityService", () => {
  it("lowercases human email, creates inside one transaction, and returns no password hash", async () => {
    const transactionStatements: string[] = [];
    const repository = new MemoryIdentityRepository();
    const service = new IdentityService(fakePool(transactionStatements), repository);

    const result = await service.createHumanUser({
      organizationId,
      email: "Zak@WINNICK.IO",
      displayName: "Zak Winnick",
      localPasswordHash: "argon2id-secret-hash",
      role: "owner",
    });

    expect(repository.createHumanInput?.email).toBe("zak@winnick.io");
    expect(transactionStatements).toEqual(["BEGIN", "COMMIT"]);
    expect(result).toEqual({
      actorId: repository.human.actorId,
      actorType: "human",
      actorName: "Zak Winnick",
      organizationId,
      role: "owner",
      userId: repository.human.userId,
      email: "zak@winnick.io",
    });
    expect(JSON.stringify(result)).not.toContain("argon2id-secret-hash");
    expect(result).not.toHaveProperty("localPasswordHash");
  });

  it("returns a stable conflict for the same human email twice", async () => {
    const repository = new MemoryIdentityRepository();
    repository.duplicateHuman = true;
    const service = new IdentityService(fakePool(), repository);
    const input = {
      organizationId,
      email: "zak@winnick.io",
      displayName: "Zak Winnick",
      role: "owner" as const,
    };

    const first = service.createHumanUser(input);
    const second = service.createHumanUser(input);

    await expect(first).rejects.toMatchObject({
      status: 409,
      code: "CONFLICT",
      message: "A user with that email already exists.",
    });
    await expect(second).rejects.toMatchObject({
      status: 409,
      code: "CONFLICT",
      message: "A user with that email already exists.",
    });
  });

  it("creates agent credentials with a lookup prefix and only a SHA-256 hash at rest", async () => {
    const repository = new MemoryIdentityRepository();
    const service = new IdentityService(fakePool(), repository);

    const result = await service.createServiceActor({
      organizationId,
      actorType: "agent",
      displayName: "Site diligence agent",
      role: "member",
    });

    const match = /^atlas_([A-Za-z0-9_-]{12})\.([A-Za-z0-9_-]{43})$/.exec(
      result.serviceKey,
    );
    expect(match).not.toBeNull();
    expect(result).toMatchObject({
      actorType: "agent",
      actorName: "Site diligence agent",
      organizationId,
      role: "member",
    });
    expect(repository.storedPrefix).toBe(match?.[1]);
    expect(repository.storedPrefix).toHaveLength(12);
    expect(repository.storedHash).toBe(
      createHash("sha256").update(result.serviceKey).digest("hex"),
    );
    expect(repository.storedHash).toHaveLength(64);
    expect(repository.storedHash).not.toContain(result.serviceKey);
    expect(result).not.toHaveProperty("serviceKeyHash");
  });

  it("rejects human actors from the service credential creation path", async () => {
    const repository = new MemoryIdentityRepository();
    const service = new IdentityService(fakePool(), repository);

    await expect(
      service.createServiceActor({
        organizationId,
        actorType: "human" as "agent",
        displayName: "Not a service actor",
        role: "member",
      }),
    ).rejects.toMatchObject({ status: 400, code: "INVALID_INPUT" });
    expect(repository.createServiceInput).toBeNull();
  });

  it("uses one indistinguishable error for missing, invalid, and disabled service credentials", async () => {
    const repository = new MemoryIdentityRepository();
    const service = new IdentityService(fakePool(), repository);
    const created = await service.createServiceActor({
      organizationId,
      actorType: "automation",
      displayName: "Report automation",
      role: "viewer",
    });

    const authenticated = await service.authenticateServiceKey(created.serviceKey);
    expect(authenticated).toEqual({
      actorId: repository.service?.actorId,
      actorType: "automation",
      actorName: "Report automation",
      organizationId,
      role: "viewer",
    });

    const expected = {
      status: 401,
      code: "UNAUTHENTICATED",
      message: "Authentication required.",
    };
    await expect(service.authenticateServiceKey()).rejects.toMatchObject(expected);
    await expect(
      service.authenticateServiceKey("atlas_abcdefghijkl.not-the-right-secret"),
    ).rejects.toMatchObject(expected);

    if (!repository.service) throw new Error("Expected service actor fixture");
    repository.service = { ...repository.service, disabledAt: new Date() };
    await expect(service.authenticateServiceKey(created.serviceKey)).rejects.toMatchObject(
      expected,
    );
  });

  it("rejects a disabled human actor with the same authentication error", async () => {
    const repository = new MemoryIdentityRepository();
    repository.human = humanRecord({ actorDisabledAt: new Date() });
    const service = new IdentityService(fakePool(), repository);

    await expect(
      service.authenticateHuman(organizationId, "zak@winnick.io"),
    ).rejects.toMatchObject({
      status: 401,
      code: "UNAUTHENTICATED",
      message: "Authentication required.",
    });
  });

  it("authenticates a human with only actor context fields", async () => {
    const repository = new MemoryIdentityRepository();
    const service = new IdentityService(fakePool(), repository);

    await expect(
      service.authenticateHuman(organizationId, "ZAK@WINNICK.IO"),
    ).resolves.toEqual({
      actorId: repository.human.actorId,
      actorType: "human",
      actorName: "Zak Winnick",
      organizationId,
      role: "owner",
      userId: repository.human.userId,
    });
  });
});

describe("IdentityRepository organization scoping", () => {
  it("defines persisted actor roles and organization-role integrity constraints", async () => {
    const migration = await readFile(
      new URL("../../db/migrations/0001_platform.sql", import.meta.url),
      "utf8",
    );

    expect(migration).toContain("role organization_role NOT NULL");
    expect(migration).toContain("actors_human_membership_role_fk");
    expect(migration).toContain("organization_memberships_actor_role_fk");
    expect(migration).toContain("char_length(service_key_prefix) = 12");
    expect(migration).toContain("service_key_hash ~ '^[0-9a-f]{64}$'");
  });

  it("maps service rows explicitly after a prefix lookup scoped by organization", async () => {
    const rawRow = {
      actor_id: randomUUID(),
      actor_type: "agent",
      actor_name: "Diligence agent",
      organization_id: organizationId,
      role: "admin",
      service_key_prefix: "abcdefghijkl",
      service_key_hash: "a".repeat(64),
      disabled_at: null,
      ignored_database_column: "must not leak",
    };
    let observedSql = "";
    const client = {
      query: async (sql: string) => {
        observedSql = sql;
        return { rows: [rawRow], rowCount: 1 };
      },
    } as unknown as PoolClient;

    const result = await new IdentityRepository().findServiceActorByPrefix(
      "abcdefghijkl",
      client,
    );

    expect(observedSql).toMatch(/organization_id/);
    expect(observedSql).toMatch(/service_key_prefix/);
    expect(result).toEqual({
      actorId: rawRow.actor_id,
      actorType: "agent",
      actorName: "Diligence agent",
      organizationId,
      role: "admin",
      serviceKeyPrefix: "abcdefghijkl",
      serviceKeyHash: "a".repeat(64),
      disabledAt: null,
    });
    expect(result).not.toHaveProperty("ignored_database_column");
  });

  it("scopes actor disabling by organization and actor id", async () => {
    const actorId = randomUUID();
    const disabledAt = new Date();
    let observedSql = "";
    let observedValues: unknown[] | undefined;
    const client = {
      query: async (sql: string, values?: unknown[]) => {
        observedSql = sql;
        observedValues = values;
        return { rows: [{ id: actorId }], rowCount: 1 };
      },
    } as unknown as PoolClient;

    const result = await new IdentityRepository().disableActor(
      organizationId,
      actorId,
      disabledAt,
      client,
    );

    expect(observedSql).toMatch(/organization_id\s*=\s*\$1/);
    expect(observedSql).toMatch(/id\s*=\s*\$2/);
    expect(observedValues).toEqual([organizationId, actorId, disabledAt]);
    expect(result).toBe(true);
  });
});

describe("PostgreSQL identity lifecycle", () => {
  it("persists human identity and service credentials with consistent roles", async (context) => {
    await withTemporaryPostgreSql(context, async (pool) => {
      const service = new IdentityService(pool);
      const human = await service.createHumanUser({
        organizationId,
        email: "Zak@WINNICK.IO",
        displayName: "Zak Winnick",
        localPasswordHash: "argon2id-test-hash",
        role: "owner",
      });
      const agent = await service.createServiceActor({
        organizationId,
        actorType: "agent",
        displayName: "Diligence agent",
        role: "member",
      });

      const persisted = await pool.query(
        `SELECT u.email::text, u.local_password_hash, a.role::text AS actor_role,
                m.role::text AS membership_role
           FROM users u
           JOIN actors a ON a.user_id = u.id AND a.organization_id = $1
           JOIN organization_memberships m
             ON m.organization_id = a.organization_id AND m.user_id = u.id
          WHERE u.id = $2`,
        [organizationId, human.userId],
      );
      expect(persisted.rows).toEqual([
        {
          email: "zak@winnick.io",
          local_password_hash: "argon2id-test-hash",
          actor_role: "owner",
          membership_role: "owner",
        },
      ]);
      expect(human).not.toHaveProperty("localPasswordHash");

      const credential = await pool.query(
        `SELECT role::text, service_key_prefix, service_key_hash
           FROM actors
          WHERE organization_id = $1 AND id = $2`,
        [organizationId, agent.actorId],
      );
      expect(credential.rows[0]).toMatchObject({
        role: "member",
        service_key_prefix: expect.stringMatching(/^.{12}$/),
        service_key_hash: createHash("sha256").update(agent.serviceKey).digest("hex"),
      });
      expect(JSON.stringify(credential.rows[0])).not.toContain(agent.serviceKey);
      await expect(service.authenticateServiceKey(agent.serviceKey)).resolves.toMatchObject({
        actorId: agent.actorId,
        organizationId,
        role: "member",
      });
    });
  });

  it("enforces valid roles and role/organization-consistent human memberships", async (context) => {
    await withTemporaryPostgreSql(context, async (pool) => {
      const otherOrganizationId = randomUUID();
      const userId = randomUUID();
      const actorId = randomUUID();
      await pool.query("INSERT INTO organizations (id, slug, name) VALUES ($1, $2, $3)", [
        otherOrganizationId,
        `other-${otherOrganizationId}`,
        "Other organization",
      ]);
      await pool.query(
        "INSERT INTO users (id, email, display_name) VALUES ($1, $2, $3)",
        [userId, `test-${userId}@example.com`, "Test user"],
      );

      await expect(
        pool.query(
          `INSERT INTO actors (organization_id, type, role, service_key_prefix, service_key_hash, display_name)
           VALUES ($1, 'automation', 'superadmin', $2, $3, $4)`,
          [organizationId, "badrole00001", "bad-hash", "Bad role"],
        ),
      ).rejects.toMatchObject({ code: "22P02" });

      const mismatchedRoleUserId = randomUUID();
      const mismatchedRoleActorId = randomUUID();
      await pool.query(
        "INSERT INTO users (id, email, display_name) VALUES ($1, $2, $3)",
        [
          mismatchedRoleUserId,
          `test-${mismatchedRoleUserId}@example.com`,
          "Mismatched role user",
        ],
      );
      const roleClient = await pool.connect();
      try {
        await roleClient.query("BEGIN");
        await roleClient.query(
          `INSERT INTO actors (id, organization_id, type, role, user_id, display_name)
           VALUES ($1, $2, 'human', 'owner', $3, $4)`,
          [mismatchedRoleActorId, organizationId, mismatchedRoleUserId, "Mismatched role user"],
        );
        await roleClient.query(
          `INSERT INTO organization_memberships (organization_id, user_id, role)
           VALUES ($1, $2, 'admin')`,
          [organizationId, mismatchedRoleUserId],
        );
        await expect(roleClient.query("COMMIT")).rejects.toMatchObject({ code: "23503" });
      } finally {
        await roleClient.query("ROLLBACK").catch(() => undefined);
        roleClient.release();
      }

      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query(
          `INSERT INTO actors (id, organization_id, type, role, user_id, display_name)
           VALUES ($1, $2, 'human', 'owner', $3, $4)`,
          [actorId, organizationId, userId, "Test user"],
        );
        await client.query(
          `INSERT INTO organization_memberships (organization_id, user_id, role)
           VALUES ($1, $2, 'owner')`,
          [otherOrganizationId, userId],
        );
        await expect(client.query("COMMIT")).rejects.toMatchObject({ code: "23503" });
      } finally {
        await client.query("ROLLBACK").catch(() => undefined);
        client.release();
      }
    });
  });
});
