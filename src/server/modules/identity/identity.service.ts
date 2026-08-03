import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { Pool } from "pg";
import { withTransaction } from "../../platform/db/client.js";
import { ApiError } from "../../platform/http/api-error.js";
import {
  IdentityRepository,
  type ActorType,
  type CreatedHumanActorRecord,
  type CreateHumanUserInput,
  type CreateServiceActorInput,
  type HumanActorRecord,
  type IdentityRepositoryPort,
  type OrganizationRole,
  type ServiceActorRecord,
} from "./identity.repository.js";

const roleRank: Record<OrganizationRole, number> = {
  viewer: 10,
  member: 20,
  admin: 30,
  owner: 40,
};

const unauthenticatedError = () =>
  new ApiError(401, "UNAUTHENTICATED", "Authentication required.");

export interface ActorIdentity {
  actorId: string;
  actorType: ActorType;
  actorName: string;
  organizationId: string;
  role: OrganizationRole;
  userId?: string;
}

export interface CreatedHumanIdentity extends ActorIdentity {
  actorType: "human";
  userId: string;
  email: string;
}

export interface CreatedServiceIdentity extends ActorIdentity {
  actorType: "agent" | "automation";
  serviceKey: string;
}

function publicHumanIdentity(record: CreatedHumanActorRecord): CreatedHumanIdentity {
  return {
    actorId: record.actorId,
    actorType: record.actorType,
    actorName: record.actorName,
    organizationId: record.organizationId,
    role: record.role,
    userId: record.userId,
    email: record.email,
  };
}

function publicServiceIdentity(record: ServiceActorRecord): ActorIdentity {
  return {
    actorId: record.actorId,
    actorType: record.actorType,
    actorName: record.actorName,
    organizationId: record.organizationId,
    role: record.role,
  };
}

function authenticatedHumanIdentity(record: HumanActorRecord): ActorIdentity {
  return {
    actorId: record.actorId,
    actorType: record.actorType,
    actorName: record.actorName,
    organizationId: record.organizationId,
    role: record.role,
    userId: record.userId,
  };
}

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "23505";
}

function hashServiceKey(serviceKey: string): Buffer {
  return createHash("sha256").update(serviceKey).digest();
}

export function assertMinimumRole(
  actual: OrganizationRole,
  required: OrganizationRole,
): void {
  if (roleRank[actual] < roleRank[required]) {
    throw new ApiError(403, "FORBIDDEN", "Insufficient permission.");
  }
}

export class IdentityService {
  constructor(
    private readonly pool: Pool,
    private readonly repository: IdentityRepositoryPort = new IdentityRepository(),
  ) {}

  async createHumanUser(input: CreateHumanUserInput): Promise<CreatedHumanIdentity> {
    const normalizedInput = { ...input, email: input.email.toLowerCase() };
    try {
      const created = await withTransaction(this.pool, (client) =>
        this.repository.createHumanUser(normalizedInput, client),
      );
      return publicHumanIdentity(created);
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ApiError(409, "CONFLICT", "A user with that email already exists.");
      }
      throw error;
    }
  }

  async createServiceActor(input: CreateServiceActorInput): Promise<CreatedServiceIdentity> {
    if (input.actorType !== "agent" && input.actorType !== "automation") {
      throw new ApiError(400, "INVALID_INPUT", "Service actors must be agents or automations.");
    }

    const secret = randomBytes(32).toString("base64url");
    const serviceKeyPrefix = secret.slice(0, 12);
    const serviceKey = `atlas_${serviceKeyPrefix}.${secret}`;
    const serviceKeyHash = hashServiceKey(serviceKey).toString("hex");
    const created = await withTransaction(this.pool, (client) =>
      this.repository.createServiceActor(
        input,
        serviceKeyPrefix,
        serviceKeyHash,
        client,
      ),
    );

    return { ...publicServiceIdentity(created), actorType: created.actorType, serviceKey };
  }

  async authenticateHuman(organizationId: string, email: string): Promise<ActorIdentity> {
    const actor = await this.repository.findHumanActorByEmail(
      organizationId,
      email.toLowerCase(),
      this.pool,
    );
    if (!actor || actor.actorDisabledAt || actor.userDisabledAt) {
      throw unauthenticatedError();
    }
    return authenticatedHumanIdentity(actor);
  }

  async authenticateServiceKey(serviceKey?: string): Promise<ActorIdentity> {
    const match = serviceKey
      ? /^atlas_([A-Za-z0-9_-]{12})\.([A-Za-z0-9_-]+)$/.exec(serviceKey)
      : null;
    if (!serviceKey || !match) throw unauthenticatedError();

    const actor = await this.repository.findServiceActorByPrefix(match[1], this.pool);
    if (!actor || actor.disabledAt) throw unauthenticatedError();

    const presentedHash = hashServiceKey(serviceKey);
    const storedHash = Buffer.from(actor.serviceKeyHash, "hex");
    if (storedHash.length !== presentedHash.length || !timingSafeEqual(storedHash, presentedHash)) {
      throw unauthenticatedError();
    }

    return publicServiceIdentity(actor);
  }

  async disableActor(
    organizationId: string,
    actorId: string,
    disabledAt = new Date(),
  ): Promise<void> {
    const disabled = await this.repository.disableActor(
      organizationId,
      actorId,
      disabledAt,
      this.pool,
    );
    if (!disabled) throw new ApiError(404, "NOT_FOUND", "Actor not found.");
  }
}
