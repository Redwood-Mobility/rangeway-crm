import { randomUUID } from "node:crypto";
import process from "node:process";
import { pathToFileURL } from "node:url";
import type { Pool } from "pg";
import { z } from "zod";
import { atlasEventTypes } from "../../../shared/events.js";
import { validateProductionPostgresUrl } from "../../../shared/postgres-url.js";
import {
  recordAudit,
  type AuditInput,
} from "../../modules/audit/audit.repository.js";
import {
  enqueueEvent,
  type OutboxInput,
} from "../../modules/events/outbox.repository.js";
import {
  IdentityRepository,
  type CreatedHumanActorRecord,
  type HumanActorRecord,
  type IdentityRepositoryPort,
  type QueryClient,
} from "../../modules/identity/identity.repository.js";
import { createPool, type DbClient, withTransaction } from "./client.js";

const rangewayOrganizationId = "00000000-0000-4000-8000-000000000001";
const confirmationPhrase = "PROVISION_ATLAS_PRODUCTION_OWNER";

export interface ProductionOwnerProvisionInput {
  databaseUrl: string;
  email: string;
  displayName: string;
  allowedDomain: string;
}

type EvidenceWriter<T> = (input: T, client: DbClient) => Promise<void>;

export interface ProductionOwnerProvisionDependencies {
  repository: IdentityRepositoryPort;
  lockOrganization?: (
    organizationId: string,
    client: QueryClient,
  ) => Promise<boolean>;
  findOwners: (
    organizationId: string,
    client: QueryClient,
  ) => Promise<CreatedHumanActorRecord[]>;
  findHumanByEmail: (
    organizationId: string,
    email: string,
    client: QueryClient,
  ) => Promise<HumanActorRecord | CreatedHumanActorRecord | null>;
  recordAudit: EvidenceWriter<AuditInput>;
  enqueueEvent: EvidenceWriter<OutboxInput>;
  precommitHook?: (client: DbClient) => void | Promise<void>;
}

function required(env: NodeJS.ProcessEnv, field: string): string {
  const value = env[field]?.trim();
  if (!value) throw new Error(`Production owner provisioning requires explicit ${field}.`);
  return value;
}

export function readProductionOwnerProvisionInput(
  env: NodeJS.ProcessEnv,
): ProductionOwnerProvisionInput {
  if (env.NODE_ENV !== "production") {
    throw new Error("Production owner provisioning requires NODE_ENV=production.");
  }
  if (env.AUTH_MODE !== "google") {
    throw new Error("Production owner provisioning requires AUTH_MODE=google.");
  }
  if (env.ATLAS_PRODUCTION_OWNER_CONFIRM !== confirmationPhrase) {
    throw new Error(
      `Production owner provisioning requires ATLAS_PRODUCTION_OWNER_CONFIRM=${confirmationPhrase}.`,
    );
  }
  if (env.ATLAS_PRODUCTION_OWNER_GOOGLE_SUBJECT !== undefined) {
    throw new Error(
      "A Google subject may be linked only by the verified login callback, not owner provisioning.",
    );
  }

  const databaseUrl = required(env, "DATABASE_URL");
  const databaseIssue = validateProductionPostgresUrl(databaseUrl, {
    username: "atlas_web",
    hostname: "db",
    database: "atlas",
  });
  if (databaseIssue) {
    throw new Error(`Production owner DATABASE_URL ${databaseIssue}.`);
  }

  const allowedDomain = required(env, "GOOGLE_ALLOWED_DOMAIN").toLowerCase();
  if (!/^[a-z0-9.-]+$/.test(allowedDomain)) {
    throw new Error("Production owner provisioning requires a valid allowed Workspace domain.");
  }
  const email = required(env, "ATLAS_PRODUCTION_OWNER_EMAIL").toLowerCase();
  if (!z.email().safeParse(email).success || !email.endsWith(`@${allowedDomain}`)) {
    throw new Error("Production owner email must belong to the allowed Workspace domain.");
  }
  const displayName = required(env, "ATLAS_PRODUCTION_OWNER_NAME");
  return { databaseUrl, email, displayName, allowedDomain };
}

async function lockRangewayOrganization(
  organizationId: string,
  client: QueryClient,
): Promise<boolean> {
  const result = await client.query(
    "SELECT id FROM organizations WHERE id = $1 FOR UPDATE",
    [organizationId],
  );
  return result.rowCount === 1;
}

async function findOwners(
  organizationId: string,
  client: QueryClient,
): Promise<CreatedHumanActorRecord[]> {
  const result = await client.query<{
    actor_id: string;
    actor_name: string;
    organization_id: string;
    user_id: string;
    email: string;
    google_subject: string | null;
    actor_disabled_at: Date | null;
    user_disabled_at: Date | null;
  }>(
    `SELECT a.id AS actor_id,
            a.display_name AS actor_name,
            a.organization_id,
            u.id AS user_id,
            u.email::text AS email,
            u.google_subject,
            a.disabled_at AS actor_disabled_at,
            u.disabled_at AS user_disabled_at
       FROM actors a
       JOIN users u ON u.id = a.user_id
       JOIN organization_memberships m
         ON m.organization_id = a.organization_id
        AND m.user_id = u.id
        AND m.role = a.role
      WHERE a.organization_id = $1
        AND a.type = 'human'
        AND a.role = 'owner'
      ORDER BY a.created_at, a.id
      FOR UPDATE OF a, u`,
    [organizationId],
  );
  return result.rows.map((row) => ({
    actorId: row.actor_id,
    actorType: "human",
    actorName: row.actor_name,
    organizationId: row.organization_id,
    role: "owner",
    userId: row.user_id,
    email: row.email,
    googleSubject: row.google_subject,
    actorDisabledAt: row.actor_disabled_at,
    userDisabledAt: row.user_disabled_at,
  }));
}

function defaultDependencies(): ProductionOwnerProvisionDependencies {
  const repository = new IdentityRepository();
  return {
    repository,
    lockOrganization: lockRangewayOrganization,
    findOwners,
    findHumanByEmail: (organizationId, email, client) =>
      repository.findHumanActorByEmail(organizationId, email, client, {
        forUpdate: true,
      }),
    recordAudit,
    enqueueEvent,
  };
}

function isExactOwner(
  owner: CreatedHumanActorRecord,
  input: ProductionOwnerProvisionInput,
): boolean {
  return (
    owner.organizationId === rangewayOrganizationId &&
    owner.actorType === "human" &&
    owner.role === "owner" &&
    owner.email === input.email &&
    owner.actorName === input.displayName &&
    owner.actorDisabledAt === null &&
    owner.userDisabledAt === null
  );
}

export async function provisionProductionOwnerWithPool(
  pool: Pool,
  input: ProductionOwnerProvisionInput,
  dependencies: ProductionOwnerProvisionDependencies = defaultDependencies(),
): Promise<"created" | "existing"> {
  return withTransaction(pool, async (client) => {
    if (
      dependencies.lockOrganization &&
      !(await dependencies.lockOrganization(rangewayOrganizationId, client))
    ) {
      throw new Error("The Rangeway organization is not migrated and ready.");
    }

    const owners = await dependencies.findOwners(rangewayOrganizationId, client);
    if (owners.length === 1 && isExactOwner(owners[0]!, input)) return "existing";
    if (owners.length > 0) {
      throw new Error("A conflicting owner already exists; no changes were made.");
    }

    const emailIdentity = await dependencies.findHumanByEmail(
      rangewayOrganizationId,
      input.email,
      client,
    );
    if (emailIdentity) {
      throw new Error("A conflicting identity already uses the requested owner email.");
    }

    const created = await dependencies.repository.createHumanUser(
      {
        organizationId: rangewayOrganizationId,
        email: input.email,
        displayName: input.displayName,
        localPasswordHash: null,
        role: "owner",
      },
      client,
    );
    const requestId = randomUUID();
    await dependencies.recordAudit(
      {
        organizationId: rangewayOrganizationId,
        actorId: created.actorId,
        requestId,
        action: "identity.owner.provisioned",
        resourceType: "user",
        resourceId: created.userId,
        before: null,
        after: {
          email: created.email,
          displayName: created.actorName,
          role: created.role,
          googleLinked: false,
        },
        metadata: { source: "explicit-production-cli" },
      },
      client,
    );
    await dependencies.enqueueEvent(
      {
        organizationId: rangewayOrganizationId,
        actorId: created.actorId,
        requestId,
        eventType: atlasEventTypes.identityOwnerProvisioned,
        aggregateType: "user",
        aggregateId: created.userId,
        schemaVersion: 1,
        payload: {
          organizationId: rangewayOrganizationId,
          actorId: created.actorId,
          userId: created.userId,
          role: "owner",
        },
      },
      client,
    );
    await dependencies.precommitHook?.(client);
    return "created";
  });
}

export async function provisionProductionOwner(
  input: ProductionOwnerProvisionInput,
): Promise<"created" | "existing"> {
  const pool = createPool(input.databaseUrl);
  try {
    return await provisionProductionOwnerWithPool(pool, input);
  } finally {
    await pool.end();
  }
}

async function main(): Promise<void> {
  const result = await provisionProductionOwner(
    readProductionOwnerProvisionInput(process.env),
  );
  console.log(
    result === "created"
      ? "Atlas production owner provisioned. Google identity remains unlinked until verified sign-in."
      : "The exact Atlas production owner is already provisioned; no changes made.",
  );
}

const entrypoint = process.argv[1];
if (entrypoint && import.meta.url === pathToFileURL(entrypoint).href) {
  main().catch((error: unknown) => {
    console.error(
      error instanceof Error
        ? error.message
        : "Atlas production owner provisioning failed.",
    );
    process.exitCode = 1;
  });
}
