import type { QueryResultRow } from "pg";
import type { DbClient } from "../../platform/db/client.js";

export type ActorType = "human" | "agent" | "automation";
export type ServiceActorType = Exclude<ActorType, "human">;
export type OrganizationRole = "owner" | "admin" | "member" | "viewer";

export type QueryClient = Pick<DbClient, "query">;

export interface CreateHumanUserInput {
  organizationId: string;
  email: string;
  displayName: string;
  localPasswordHash?: string | null;
  role: OrganizationRole;
}

export interface CreateServiceActorInput {
  organizationId: string;
  actorType: ServiceActorType;
  displayName: string;
  role: OrganizationRole;
}

export interface HumanActorRecord {
  actorId: string;
  actorType: "human";
  actorName: string;
  organizationId: string;
  role: OrganizationRole;
  userId: string;
  email: string;
  localPasswordHash: string | null;
  actorDisabledAt: Date | null;
  userDisabledAt: Date | null;
}

export type CreatedHumanActorRecord = Omit<HumanActorRecord, "localPasswordHash">;

export interface ServiceActorRecord {
  actorId: string;
  actorType: ServiceActorType;
  actorName: string;
  organizationId: string;
  role: OrganizationRole;
  serviceKeyPrefix: string;
  serviceKeyHash: string;
  disabledAt: Date | null;
}

export interface IdentityRepositoryPort {
  createHumanUser(
    input: CreateHumanUserInput,
    client: QueryClient,
  ): Promise<CreatedHumanActorRecord>;
  findHumanActorByEmail(
    organizationId: string,
    email: string,
    client: QueryClient,
  ): Promise<HumanActorRecord | null>;
  createServiceActor(
    input: CreateServiceActorInput,
    serviceKeyPrefix: string,
    serviceKeyHash: string,
    client: QueryClient,
  ): Promise<ServiceActorRecord>;
  findServiceActorByPrefix(
    serviceKeyPrefix: string,
    client: QueryClient,
  ): Promise<ServiceActorRecord | null>;
  disableActor(
    organizationId: string,
    actorId: string,
    disabledAt: Date,
    client: QueryClient,
  ): Promise<boolean>;
}

interface HumanActorRow extends QueryResultRow {
  actor_id: string;
  actor_type: "human";
  actor_name: string;
  organization_id: string;
  role: OrganizationRole;
  user_id: string;
  email: string;
  local_password_hash: string | null;
  actor_disabled_at: Date | null;
  user_disabled_at: Date | null;
}

interface ServiceActorRow extends QueryResultRow {
  actor_id: string;
  actor_type: ServiceActorType;
  actor_name: string;
  organization_id: string;
  role: OrganizationRole;
  service_key_prefix: string;
  service_key_hash: string;
  disabled_at: Date | null;
}

function mapHumanActor(row: HumanActorRow): HumanActorRecord {
  return {
    actorId: row.actor_id,
    actorType: row.actor_type,
    actorName: row.actor_name,
    organizationId: row.organization_id,
    role: row.role,
    userId: row.user_id,
    email: row.email,
    localPasswordHash: row.local_password_hash,
    actorDisabledAt: row.actor_disabled_at,
    userDisabledAt: row.user_disabled_at,
  };
}

function mapServiceActor(row: ServiceActorRow): ServiceActorRecord {
  return {
    actorId: row.actor_id,
    actorType: row.actor_type,
    actorName: row.actor_name,
    organizationId: row.organization_id,
    role: row.role,
    serviceKeyPrefix: row.service_key_prefix,
    serviceKeyHash: row.service_key_hash,
    disabledAt: row.disabled_at,
  };
}

export class IdentityRepository implements IdentityRepositoryPort {
  async createHumanUser(
    input: CreateHumanUserInput,
    client: QueryClient,
  ): Promise<CreatedHumanActorRecord> {
    const userResult = await client.query<{
      id: string;
      email: string;
      display_name: string;
      disabled_at: Date | null;
    }>(
      `INSERT INTO users (email, display_name, local_password_hash)
       VALUES ($1, $2, $3)
       RETURNING id, email::text AS email, display_name, disabled_at`,
      [input.email, input.displayName, input.localPasswordHash ?? null],
    );
    const user = userResult.rows[0];

    const actorResult = await client.query<{
      id: string;
      type: "human";
      display_name: string;
      organization_id: string;
      role: OrganizationRole;
      disabled_at: Date | null;
    }>(
      `INSERT INTO actors (organization_id, type, role, user_id, display_name)
       VALUES ($1, 'human', $2, $3, $4)
       RETURNING id, type, display_name, organization_id, role, disabled_at`,
      [input.organizationId, input.role, user.id, input.displayName],
    );
    const actor = actorResult.rows[0];

    await client.query(
      `INSERT INTO organization_memberships (organization_id, user_id, role)
       VALUES ($1, $2, $3)`,
      [input.organizationId, user.id, input.role],
    );

    return {
      actorId: actor.id,
      actorType: actor.type,
      actorName: actor.display_name,
      organizationId: actor.organization_id,
      role: actor.role,
      userId: user.id,
      email: user.email,
      actorDisabledAt: actor.disabled_at,
      userDisabledAt: user.disabled_at,
    };
  }

  async findHumanActorByEmail(
    organizationId: string,
    email: string,
    client: QueryClient,
  ): Promise<HumanActorRecord | null> {
    const result = await client.query<HumanActorRow>(
      `SELECT a.id AS actor_id,
              a.type AS actor_type,
              a.display_name AS actor_name,
              a.organization_id,
              a.role,
              u.id AS user_id,
              u.email::text AS email,
              u.local_password_hash,
              a.disabled_at AS actor_disabled_at,
              u.disabled_at AS user_disabled_at
         FROM actors a
         JOIN users u ON u.id = a.user_id
         JOIN organization_memberships m
           ON m.organization_id = a.organization_id
          AND m.user_id = u.id
          AND m.role = a.role
        WHERE a.organization_id = $1
          AND m.organization_id = $1
          AND a.type = 'human'
          AND u.email = $2`,
      [organizationId, email],
    );
    return result.rows[0] ? mapHumanActor(result.rows[0]) : null;
  }

  async createServiceActor(
    input: CreateServiceActorInput,
    serviceKeyPrefix: string,
    serviceKeyHash: string,
    client: QueryClient,
  ): Promise<ServiceActorRecord> {
    const result = await client.query<ServiceActorRow>(
      `INSERT INTO actors
         (organization_id, type, role, service_key_prefix, service_key_hash, display_name)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id AS actor_id,
                 type AS actor_type,
                 display_name AS actor_name,
                 organization_id,
                 role,
                 service_key_prefix,
                 service_key_hash,
                 disabled_at`,
      [
        input.organizationId,
        input.actorType,
        input.role,
        serviceKeyPrefix,
        serviceKeyHash,
        input.displayName,
      ],
    );
    return mapServiceActor(result.rows[0]);
  }

  async findServiceActorByPrefix(
    serviceKeyPrefix: string,
    client: QueryClient,
  ): Promise<ServiceActorRecord | null> {
    const result = await client.query<ServiceActorRow>(
      `WITH prefix_match AS (
         SELECT organization_id, id
           FROM actors
          WHERE service_key_prefix = $1
       )
       SELECT a.id AS actor_id,
              a.type AS actor_type,
              a.display_name AS actor_name,
              a.organization_id,
              a.role,
              a.service_key_prefix,
              a.service_key_hash,
              a.disabled_at
         FROM actors a
         JOIN prefix_match p
           ON p.organization_id = a.organization_id
          AND p.id = a.id
        WHERE a.organization_id = p.organization_id
          AND a.id = p.id
          AND a.service_key_prefix = $1
          AND a.type IN ('agent', 'automation')`,
      [serviceKeyPrefix],
    );
    return result.rows[0] ? mapServiceActor(result.rows[0]) : null;
  }

  async disableActor(
    organizationId: string,
    actorId: string,
    disabledAt: Date,
    client: QueryClient,
  ): Promise<boolean> {
    const result = await client.query<{ id: string }>(
      `UPDATE actors
          SET disabled_at = $3, updated_at = now()
        WHERE organization_id = $1
          AND id = $2
        RETURNING id`,
      [organizationId, actorId, disabledAt],
    );
    return result.rows.length === 1;
  }
}
