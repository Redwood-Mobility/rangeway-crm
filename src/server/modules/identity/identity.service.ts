import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import argon2 from "argon2";
import type { Pool } from "pg";
import type {
  ActorContext,
  OrganizationRole,
} from "../../../shared/identity.js";
import { withTransaction } from "../../platform/db/client.js";
import { ApiError } from "../../platform/http/api-error.js";
import { atlasEventTypes } from "../../../shared/events.js";
import {
  recordAudit,
  type AuditInput,
} from "../audit/audit.repository.js";
import {
  enqueueEvent,
  type OutboxInput,
} from "../events/outbox.repository.js";
import {
  IdentityRepository,
  type CreatedHumanActorRecord,
  type CreateHumanUserInput,
  type CreateServiceActorInput,
  type HumanActorRecord,
  type IdentityRepositoryPort,
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

export type ActorIdentity = Omit<ActorContext, "requestId">;

export interface CreatedHumanIdentity extends ActorIdentity {
  actorType: "human";
  userId: string;
  email: string;
}

export interface CreatedServiceIdentity extends ActorIdentity {
  actorType: "agent" | "automation";
  serviceKey: string;
}

export interface IdentityEvidenceDependencies {
  recordAudit: (input: AuditInput, client: Parameters<typeof recordAudit>[1]) => Promise<void>;
  enqueueEvent: (input: OutboxInput, client: Parameters<typeof enqueueEvent>[1]) => Promise<void>;
  precommitHook?: (client: Parameters<typeof recordAudit>[1]) => void | Promise<void>;
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
    private readonly evidence: IdentityEvidenceDependencies = {
      recordAudit,
      enqueueEvent,
    },
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

  async authenticateGoogle(
    organizationId: string,
    googleSubject: string,
    email: string,
    displayName: string,
    requestId = randomUUID(),
  ): Promise<ActorIdentity> {
    const normalizedSubject = googleSubject.trim();
    const normalizedEmail = email.trim().toLowerCase();
    const normalizedDisplayName = displayName.trim() || normalizedEmail;
    if (!normalizedSubject || normalizedSubject.length > 255 || !normalizedEmail) {
      throw unauthenticatedError();
    }

    try {
      const actor = await withTransaction(this.pool, async (client) => {
        const subjectActor = await this.repository.findHumanActorByGoogleSubject(
          organizationId,
          normalizedSubject,
          client,
          { forUpdate: true },
        );
        if (subjectActor) {
          if (subjectActor.actorDisabledAt || subjectActor.userDisabledAt) {
            throw unauthenticatedError();
          }
          const emailActor = await this.repository.findHumanActorByEmail(
            organizationId,
            normalizedEmail,
            client,
            { forUpdate: true },
          );
          if (emailActor && emailActor.userId !== subjectActor.userId) {
            throw unauthenticatedError();
          }
          const changedFields = [
            ...(subjectActor.email === normalizedEmail ? [] : ["email"]),
            ...(subjectActor.actorName === normalizedDisplayName
              ? []
              : ["displayName"]),
          ];
          if (changedFields.length === 0) return subjectActor;
          const beforeProfile = {
            email: subjectActor.email,
            displayName: subjectActor.actorName,
          };
          const updated = await this.repository.updateHumanGoogleProfile(
            organizationId,
            subjectActor.userId,
            normalizedSubject,
            normalizedEmail,
            normalizedDisplayName,
            client,
          );
          if (!updated) throw unauthenticatedError();
          await this.recordGoogleIdentityEvidence(
            client,
            updated,
            requestId,
            "profile",
            changedFields,
            beforeProfile,
            { email: updated.email, displayName: updated.actorName },
            normalizedSubject,
          );
          return updated;
        }

        const emailActor = await this.repository.findHumanActorByEmail(
          organizationId,
          normalizedEmail,
          client,
          { forUpdate: true },
        );
        if (
          !emailActor ||
          emailActor.actorDisabledAt ||
          emailActor.userDisabledAt ||
          (emailActor.googleSubject !== null &&
            emailActor.googleSubject !== normalizedSubject)
        ) {
          throw unauthenticatedError();
        }

        const changedFields = [
          "googleSubject",
          ...(emailActor.email === normalizedEmail ? [] : ["email"]),
          ...(emailActor.actorName === normalizedDisplayName
            ? []
              : ["displayName"]),
        ];
        const beforeProfile = {
          email: emailActor.email,
          displayName: emailActor.actorName,
          googleLinked: false,
        };
        const linked = await this.repository.linkHumanActorToGoogle(
          organizationId,
          emailActor.userId,
          normalizedSubject,
          normalizedEmail,
          normalizedDisplayName,
          client,
        );
        if (!linked) throw unauthenticatedError();
        await this.recordGoogleIdentityEvidence(
          client,
          linked,
          requestId,
          "link",
          changedFields,
          beforeProfile,
          {
            email: linked.email,
            displayName: linked.actorName,
            googleLinked: true,
          },
          normalizedSubject,
        );
        return linked;
      });
      if (!actor || actor.actorDisabledAt || actor.userDisabledAt) {
        throw unauthenticatedError();
      }
      return authenticatedHumanIdentity(actor);
    } catch (error) {
      if (isUniqueViolation(error)) throw unauthenticatedError();
      throw error;
    }
  }

  private async recordGoogleIdentityEvidence(
    client: Parameters<typeof recordAudit>[1],
    actor: HumanActorRecord,
    requestId: string,
    change: "link" | "profile",
    changedFields: string[],
    before: Record<string, unknown>,
    after: Record<string, unknown>,
    googleSubject: string,
  ): Promise<void> {
    await this.evidence.recordAudit(
      {
        organizationId: actor.organizationId,
        actorId: actor.actorId,
        requestId,
        action:
          change === "link"
            ? "identity.google.linked"
            : "identity.google.profile_updated",
        resourceType: "user",
        resourceId: actor.userId,
        before,
        after,
        metadata: {
          changedFields,
          subjectFingerprint: createHash("sha256")
            .update(googleSubject)
            .digest("hex"),
          source: "verified-google-login",
        },
      },
      client,
    );
    await this.evidence.enqueueEvent(
      {
        organizationId: actor.organizationId,
        actorId: actor.actorId,
        requestId,
        eventType:
          change === "link"
            ? atlasEventTypes.identityGoogleLinked
            : atlasEventTypes.identityGoogleProfileUpdated,
        aggregateType: "user",
        aggregateId: actor.userId,
        schemaVersion: 1,
        payload: {
          organizationId: actor.organizationId,
          actorId: actor.actorId,
          userId: actor.userId,
          changedFields,
        },
      },
      client,
    );
    await this.evidence.precommitHook?.(client);
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

  async authenticateHumanSession(
    organizationId: string,
    userId: string,
  ): Promise<ActorIdentity> {
    const actor = await this.repository.findHumanActorByUserId(
      organizationId,
      userId,
      this.pool,
    );
    if (!actor || actor.actorDisabledAt || actor.userDisabledAt) {
      throw unauthenticatedError();
    }
    return authenticatedHumanIdentity(actor);
  }

  async authenticateLocal(
    organizationId: string,
    email: string,
    password: string,
  ): Promise<ActorIdentity> {
    const actor = await this.repository.findHumanActorByEmail(
      organizationId,
      email.toLowerCase(),
      this.pool,
    );
    if (
      !actor ||
      actor.actorDisabledAt ||
      actor.userDisabledAt ||
      !actor.localPasswordHash ||
      !actor.localPasswordHash.startsWith("$argon2id$")
    ) {
      throw unauthenticatedError();
    }

    let passwordMatches = false;
    try {
      passwordMatches = await argon2.verify(actor.localPasswordHash, password);
    } catch {
      throw unauthenticatedError();
    }
    if (!passwordMatches) throw unauthenticatedError();
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
