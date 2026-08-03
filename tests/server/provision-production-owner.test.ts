import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { Pool, PoolClient } from "pg";
import { describe, expect, it, vi } from "vitest";
import type {
  CreatedHumanActorRecord,
  CreateHumanUserInput,
  IdentityRepositoryPort,
} from "../../src/server/modules/identity/identity.repository.js";
import {
  provisionProductionOwnerWithPool,
  readProductionOwnerProvisionInput,
  type ProductionOwnerProvisionDependencies,
} from "../../src/server/platform/db/provision-production-owner.js";

const organizationId = "00000000-0000-4000-8000-000000000001";
const productionEnvironment = {
  NODE_ENV: "production",
  AUTH_MODE: "google",
  DATABASE_URL:
    "postgresql://atlas_web:production-web-password-01@db:5432/atlas",
  GOOGLE_ALLOWED_DOMAIN: "rangeway.energy",
  ATLAS_PRODUCTION_OWNER_EMAIL: " owner@rangeway.energy ",
  ATLAS_PRODUCTION_OWNER_NAME: " Rangeway Owner ",
  ATLAS_PRODUCTION_OWNER_CONFIRM: "PROVISION_ATLAS_PRODUCTION_OWNER",
};

interface ProvisionState {
  owners: CreatedHumanActorRecord[];
  humansByEmail: Map<string, CreatedHumanActorRecord>;
  audits: Array<Record<string, unknown>>;
  events: Array<Record<string, unknown>>;
}

function cloneState(state: ProvisionState): ProvisionState {
  return {
    owners: state.owners.map((owner) => ({ ...owner })),
    humansByEmail: new Map(
      [...state.humansByEmail].map(([email, human]) => [email, { ...human }]),
    ),
    audits: state.audits.map((audit) => ({ ...audit })),
    events: state.events.map((event) => ({ ...event })),
  };
}

function harness(initial: Partial<ProvisionState> = {}) {
  const committed: ProvisionState = {
    owners: [],
    humansByEmail: new Map(),
    audits: [],
    events: [],
    ...initial,
  };
  let transaction: ProvisionState | null = null;
  const queries: string[] = [];
  const current = () => transaction ?? committed;
  const client = {
    async query(sql: string) {
      const command = sql.trim();
      queries.push(command);
      if (command === "BEGIN") transaction = cloneState(committed);
      if (command === "COMMIT") {
        if (!transaction) throw new Error("missing transaction");
        committed.owners = transaction.owners;
        committed.humansByEmail = transaction.humansByEmail;
        committed.audits = transaction.audits;
        committed.events = transaction.events;
        transaction = null;
      }
      if (command === "ROLLBACK") transaction = null;
      return { rows: [], rowCount: 0 };
    },
    release() {},
  } as unknown as PoolClient;
  const pool = { connect: async () => client } as unknown as Pool;

  const repository = {
    async createHumanUser(input: CreateHumanUserInput) {
      const state = current();
      if (state.humansByEmail.has(input.email)) {
        throw Object.assign(new Error("duplicate"), { code: "23505" });
      }
      const created: CreatedHumanActorRecord = {
        actorId: randomUUID(),
        actorType: "human",
        actorName: input.displayName,
        organizationId: input.organizationId,
        role: input.role,
        userId: randomUUID(),
        email: input.email,
        googleSubject: null,
        actorDisabledAt: null,
        userDisabledAt: null,
      };
      state.owners.push(created);
      state.humansByEmail.set(input.email, created);
      return created;
    },
  } as unknown as IdentityRepositoryPort;
  const dependencies: ProductionOwnerProvisionDependencies = {
    repository,
    findOwners: async () => current().owners,
    findHumanByEmail: async (_organization, email) =>
      current().humansByEmail.get(email) ?? null,
    recordAudit: async (input) => {
      current().audits.push(input as unknown as Record<string, unknown>);
    },
    enqueueEvent: async (input) => {
      current().events.push(input as unknown as Record<string, unknown>);
    },
  };
  return { committed, pool, dependencies, queries };
}

describe("one-time production owner provisioning", () => {
  it("relies on the organization lock without locking membership rows", async () => {
    const source = await readFile(
      new URL("../../src/server/platform/db/provision-production-owner.ts", import.meta.url),
      "utf8",
    );
    expect(source).toContain("SELECT id FROM organizations WHERE id = $1 FOR UPDATE");
    expect(source).toMatch(/FOR UPDATE OF a, u`/);
    expect(source).not.toMatch(/FOR UPDATE OF a, u, m/);
  });

  it("is an explicit command and is never part of web or worker startup", async () => {
    const packageJson = JSON.parse(await readFile("package.json", "utf8")) as {
      scripts: Record<string, string>;
    };

    expect(packageJson.scripts["db:provision:production-owner"]).toBe(
      "node dist/server/platform/db/provision-production-owner.js",
    );
    expect(packageJson.scripts.start).not.toMatch(/provision|seed/i);
    expect(packageJson.scripts["start:worker"]).not.toMatch(/provision|seed/i);
  });

  it.each([
    [{ ...productionEnvironment, NODE_ENV: "development" }, "NODE_ENV=production"],
    [{ ...productionEnvironment, AUTH_MODE: "local" }, "AUTH_MODE=google"],
    [
      { ...productionEnvironment, ATLAS_PRODUCTION_OWNER_CONFIRM: "yes" },
      "PROVISION_ATLAS_PRODUCTION_OWNER",
    ],
  ])("fails closed without an explicit production ceremony", (environment, message) => {
    expect(() => readProductionOwnerProvisionInput(environment)).toThrow(message);
  });

  it("normalizes metadata, validates the Workspace domain, and never accepts a Google subject", () => {
    expect(readProductionOwnerProvisionInput(productionEnvironment)).toEqual({
      databaseUrl: productionEnvironment.DATABASE_URL,
      email: "owner@rangeway.energy",
      displayName: "Rangeway Owner",
      allowedDomain: "rangeway.energy",
    });
    expect(() =>
      readProductionOwnerProvisionInput({
        ...productionEnvironment,
        ATLAS_PRODUCTION_OWNER_EMAIL: "owner@example.com",
      }),
    ).toThrow(/allowed Workspace domain/i);
    expect(() =>
      readProductionOwnerProvisionInput({
        ...productionEnvironment,
        ATLAS_PRODUCTION_OWNER_GOOGLE_SUBJECT: "unverified-subject",
      }),
    ).toThrow(/Google subject.*verified login/i);
  });

  it("atomically creates one owner plus attributable private audit and minimal outbox evidence", async () => {
    const state = harness();
    const input = readProductionOwnerProvisionInput(productionEnvironment);

    await expect(
      provisionProductionOwnerWithPool(state.pool, input, state.dependencies),
    ).resolves.toBe("created");

    expect(state.committed.owners).toHaveLength(1);
    const owner = state.committed.owners[0]!;
    expect(owner).toMatchObject({
      email: "owner@rangeway.energy",
      actorName: "Rangeway Owner",
      role: "owner",
      googleSubject: null,
    });
    expect(state.committed.audits).toEqual([
      expect.objectContaining({
        organizationId,
        actorId: owner.actorId,
        action: "identity.owner.provisioned",
        resourceType: "user",
        resourceId: owner.userId,
        after: {
          email: "owner@rangeway.energy",
          displayName: "Rangeway Owner",
          role: "owner",
          googleLinked: false,
        },
      }),
    ]);
    expect(state.committed.events).toEqual([
      expect.objectContaining({
        organizationId,
        actorId: owner.actorId,
        eventType: "identity.owner-provisioned.v1",
        aggregateType: "user",
        aggregateId: owner.userId,
        payload: {
          organizationId,
          actorId: owner.actorId,
          userId: owner.userId,
          role: "owner",
        },
      }),
    ]);
    expect(JSON.stringify(state.committed.events)).not.toContain(owner.email);
    expect(state.queries).toEqual(["BEGIN", "COMMIT"]);
  });

  it("is idempotent only for the exact already-provisioned owner identity", async () => {
    const state = harness();
    const input = readProductionOwnerProvisionInput(productionEnvironment);
    await provisionProductionOwnerWithPool(state.pool, input, state.dependencies);

    await expect(
      provisionProductionOwnerWithPool(state.pool, input, state.dependencies),
    ).resolves.toBe("existing");
    expect(state.committed.owners).toHaveLength(1);
    expect(state.committed.audits).toHaveLength(1);
    expect(state.committed.events).toHaveLength(1);

    await expect(
      provisionProductionOwnerWithPool(
        state.pool,
        { ...input, displayName: "Different Owner" },
        state.dependencies,
      ),
    ).rejects.toThrow(/conflicting owner/i);
  });

  it("rejects another owner or a conflicting email identity", async () => {
    const owner = {
      actorId: randomUUID(),
      actorType: "human" as const,
      actorName: "Another Owner",
      organizationId,
      role: "owner" as const,
      userId: randomUUID(),
      email: "another@rangeway.energy",
      googleSubject: null,
      actorDisabledAt: null,
      userDisabledAt: null,
    };
    const existingOwner = harness({
      owners: [owner],
      humansByEmail: new Map([[owner.email, owner]]),
    });
    await expect(
      provisionProductionOwnerWithPool(
        existingOwner.pool,
        readProductionOwnerProvisionInput(productionEnvironment),
        existingOwner.dependencies,
      ),
    ).rejects.toThrow(/conflicting owner/i);

    const conflicting = { ...owner, role: "member" as const, email: "owner@rangeway.energy" };
    const emailConflict = harness({
      humansByEmail: new Map([[conflicting.email, conflicting]]),
    });
    await expect(
      provisionProductionOwnerWithPool(
        emailConflict.pool,
        readProductionOwnerProvisionInput(productionEnvironment),
        emailConflict.dependencies,
      ),
    ).rejects.toThrow(/conflicting identity/i);
  });

  it("rolls back the owner and both evidence rows when the transaction fails", async () => {
    const state = harness();
    state.dependencies.precommitHook = vi.fn(async () => {
      throw new Error("forced provisioning failure");
    });

    await expect(
      provisionProductionOwnerWithPool(
        state.pool,
        readProductionOwnerProvisionInput(productionEnvironment),
        state.dependencies,
      ),
    ).rejects.toThrow("forced provisioning failure");

    expect(state.committed.owners).toEqual([]);
    expect(state.committed.audits).toEqual([]);
    expect(state.committed.events).toEqual([]);
    expect(state.queries).toEqual(["BEGIN", "ROLLBACK"]);
  });
});
