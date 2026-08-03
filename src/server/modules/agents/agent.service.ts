import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { Pool, QueryResultRow } from "pg";
import type { ActorContext } from "../../../shared/identity.js";
import { atlasEventTypes } from "../../../shared/events.js";
import {
  decideAuthority,
  type AgentScope,
  type AuthorityDecision,
  type CredentialAuthority,
  type DelegationAuthority,
  type OperationRequest,
} from "../../../shared/agent-authority.js";
import { ApiError } from "../../platform/http/api-error.js";
import type { DbClient } from "../../platform/db/client.js";
import { mutateIdempotentlyWithAuditAndEvent } from "../events/outbox.service.js";

type Input = Record<string, unknown>;
type Result = Record<string, unknown>;
type Row = QueryResultRow & Record<string, unknown>;

function camelize(row: Row): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(row).map(([key, value]) => [
      key.replace(/_([a-z])/g, (_m, c: string) => c.toUpperCase()),
      value instanceof Date ? value.toISOString() : value,
    ]),
  );
}

const notFound = () => new ApiError(404, "NOT_FOUND", "Resource not found.");
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function requiredId(input: Input, field: string): string {
  const value = input[field];
  if (typeof value !== "string" || !uuidPattern.test(value)) {
    throw new ApiError(400, "INVALID_INPUT", `A valid ${field} is required.`);
  }
  return value;
}

function requestHash(operation: string, input: Input): string {
  return createHash("sha256").update(JSON.stringify({ operation, input })).digest("hex");
}

export function hashServiceKey(serviceKey: string): string {
  return createHash("sha256").update(serviceKey).digest("hex");
}

/**
 * `agent_scope[]` is a custom enum array, and node-postgres has no parser for
 * it, so it arrives as the raw literal `{read,work.write}`. Authority decisions
 * run over real arrays, so the value is normalized on the way in.
 */
function toScopeArray(value: unknown): AgentScope[] {
  if (Array.isArray(value)) return value as AgentScope[];
  if (typeof value !== "string") return [];
  const inner = value.replace(/^\{/, "").replace(/\}$/, "").trim();
  if (inner.length === 0) return [];
  return inner
    .split(",")
    .map((scope) => scope.trim().replace(/^"(.*)"$/, "$1"))
    .filter((scope) => scope.length > 0) as AgentScope[];
}

/** Administration of agents is an owner/admin activity, never an agent one. */
function requireHumanAdministrator(actor: ActorContext): void {
  if (actor.actorType !== "human" || !["owner", "admin"].includes(actor.role)) {
    throw new ApiError(403, "FORBIDDEN", "Agent administration requires an organization owner or administrator.");
  }
}

export interface AgentPort {
  query(actor: ActorContext, operation: string, input: Input): Promise<Result>;
  mutate(actor: ActorContext, operation: string, input: Input, key: string): Promise<Result>;
  authorize(actor: ActorContext, request: OperationRequest): Promise<AuthorityDecision>;
}

export class AgentService implements AgentPort {
  constructor(private readonly pool: Pool) {}

  async query(actor: ActorContext, operation: string, input: Input): Promise<Result> {
    switch (operation) {
      case "agent.list":
        return this.listAgents(actor);
      case "agent.delegations":
        return this.listDelegations(actor);
      case "agent.approvals":
        return this.listApprovals(actor);
      case "agent.invocations":
        return this.listInvocations(actor, input);
      default:
        throw notFound();
    }
  }

  async mutate(actor: ActorContext, operation: string, input: Input, key: string): Promise<Result> {
    return mutateIdempotentlyWithAuditAndEvent(
      this.pool,
      actor,
      { operation: `${operation}.v1`, key, requestHash: requestHash(operation, input) },
      (client) => this.performMutation(client, actor, operation, input),
    );
  }

  private async performMutation(client: DbClient, actor: ActorContext, operation: string, input: Input) {
    switch (operation) {
      case "agent.credential.issue":
        return this.issueCredential(client, actor, input);
      case "agent.credential.rotate":
        return this.rotateCredential(client, actor, input);
      case "agent.credential.disable":
        return this.disableCredential(client, actor, input);
      case "agent.delegation.create":
        return this.createDelegation(client, actor, input);
      case "agent.delegation.revoke":
        return this.revokeDelegation(client, actor, input);
      case "agent.approval.decide":
        return this.decideApproval(client, actor, input);
      default:
        throw notFound();
    }
  }

  // ----------------------------------------------------------- credentials --

  private async issueCredential(client: DbClient, actor: ActorContext, input: Input) {
    requireHumanAdministrator(actor);
    const agentActorId = requiredId(input, "actorId");
    const target = await client.query<Row>(
      "SELECT id, type FROM actors WHERE organization_id = $1 AND id = $2",
      [actor.organizationId, agentActorId],
    );
    if (!target.rows[0]) throw notFound();
    if (target.rows[0].type === "human") {
      throw new ApiError(409, "CONFLICT", "Credentials are issued to agents and automations.");
    }

    const secret = randomBytes(32).toString("base64url");
    const prefix = secret.slice(0, 12);
    const serviceKey = `atlas_${prefix}.${secret}`;
    const id = randomUUID();

    const created = await client.query<Row>(
      `INSERT INTO agent_credentials
         (id, organization_id, actor_id, service_key_prefix, service_key_hash,
          scopes, external_delivery_authorized, created_by_actor_id, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6::agent_scope[], $7, $8, $9)
       RETURNING *`,
      [
        id,
        actor.organizationId,
        agentActorId,
        prefix,
        hashServiceKey(serviceKey),
        input.scopes ?? [],
        input.externalDeliveryAuthorized ?? false,
        actor.actorId,
        input.expiresAt ?? null,
      ],
    );

    const credential = this.publicCredential(created.rows[0]);
    return {
      // The key is returned exactly once, at creation, and never stored in clear.
      ...this.record(actor, "agent.credential.issued", "agent_credential", id, { credential, serviceKey }, null, credential),
    };
  }

  private async rotateCredential(client: DbClient, actor: ActorContext, input: Input) {
    requireHumanAdministrator(actor);
    const credentialId = requiredId(input, "credentialId");
    const before = await client.query<Row>(
      "SELECT * FROM agent_credentials WHERE organization_id = $1 AND id = $2 FOR UPDATE",
      [actor.organizationId, credentialId],
    );
    if (!before.rows[0] || before.rows[0].disabled_at) throw notFound();

    const secret = randomBytes(32).toString("base64url");
    const prefix = secret.slice(0, 12);
    const serviceKey = `atlas_${prefix}.${secret}`;

    // Rotation replaces the secret but keeps the same actor, so every past and
    // future action stays attributed to the same identity.
    const updated = await client.query<Row>(
      `UPDATE agent_credentials
          SET service_key_prefix = $3, service_key_hash = $4, rotated_at = now()
        WHERE organization_id = $1 AND id = $2 RETURNING *`,
      [actor.organizationId, credentialId, prefix, hashServiceKey(serviceKey)],
    );
    const credential = this.publicCredential(updated.rows[0]);
    return this.record(actor, "agent.credential.rotated", "agent_credential", credentialId, { credential, serviceKey }, this.publicCredential(before.rows[0]), credential);
  }

  private async disableCredential(client: DbClient, actor: ActorContext, input: Input) {
    requireHumanAdministrator(actor);
    const credentialId = requiredId(input, "credentialId");
    const updated = await client.query<Row>(
      `UPDATE agent_credentials SET disabled_at = now()
        WHERE organization_id = $1 AND id = $2 AND disabled_at IS NULL RETURNING *`,
      [actor.organizationId, credentialId],
    );
    if (!updated.rows[0]) throw notFound();
    const credential = this.publicCredential(updated.rows[0]);
    return this.record(actor, "agent.credential.disabled", "agent_credential", credentialId, { credential }, null, credential);
  }

  private publicCredential(row: Row): Record<string, unknown> {
    const { service_key_hash, ...rest } = row;
    void service_key_hash;
    return camelize(rest as Row);
  }

  // ----------------------------------------------------------- delegations --

  private async createDelegation(client: DbClient, actor: ActorContext, input: Input) {
    if (actor.actorType !== "human") {
      throw new ApiError(403, "FORBIDDEN", "An agent cannot delegate authority to itself.");
    }
    const agentActorId = requiredId(input, "actorId");
    const id = randomUUID();
    const created = await client.query<Row>(
      `INSERT INTO agent_delegations
         (id, organization_id, actor_id, delegated_by_actor_id, task_source, purpose,
          permitted_scopes, project_id, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7::agent_scope[], $8, $9)
       RETURNING *`,
      [
        id,
        actor.organizationId,
        agentActorId,
        actor.actorId,
        input.taskSource,
        input.purpose ?? "",
        input.permittedScopes ?? [],
        input.projectId ?? null,
        input.expiresAt,
      ],
    );
    const delegation = camelize(created.rows[0]);
    return this.record(actor, "agent.delegation.created", "agent_delegation", id, { delegation }, null, delegation);
  }

  private async revokeDelegation(client: DbClient, actor: ActorContext, input: Input) {
    if (actor.actorType !== "human") {
      throw new ApiError(403, "FORBIDDEN", "Only a person may revoke a delegation.");
    }
    const delegationId = requiredId(input, "delegationId");
    const updated = await client.query<Row>(
      `UPDATE agent_delegations SET revoked_at = now()
        WHERE organization_id = $1 AND id = $2 AND revoked_at IS NULL RETURNING *`,
      [actor.organizationId, delegationId],
    );
    if (!updated.rows[0]) throw notFound();
    const delegation = camelize(updated.rows[0]);
    return this.record(actor, "agent.delegation.revoked", "agent_delegation", delegationId, { delegation }, null, delegation);
  }

  // ------------------------------------------------------------- authority --

  /**
   * Decides whether an agent may perform an operation, records the attempt, and
   * opens an approval request when the operation needs a human.
   */
  async authorize(actor: ActorContext, request: OperationRequest): Promise<AuthorityDecision> {
    if (actor.actorType === "human") {
      return { allowed: true, requiresApproval: false, reason: "human_actor", effectiveScopes: [] };
    }

    const credentialResult = await this.pool.query<Row>(
      `SELECT * FROM agent_credentials
        WHERE organization_id = $1 AND actor_id = $2
        ORDER BY disabled_at NULLS FIRST, created_at DESC LIMIT 1`,
      [actor.organizationId, actor.actorId],
    );
    const credentialRow = credentialResult.rows[0];
    if (!credentialRow) {
      await this.recordInvocation(actor, null, request, "rejected", "no_credential", null);
      return { allowed: false, requiresApproval: false, reason: "no_credential", effectiveScopes: [] };
    }

    const delegationResult = await this.pool.query<Row>(
      `SELECT * FROM agent_delegations
        WHERE organization_id = $1 AND actor_id = $2 AND revoked_at IS NULL
          AND expires_at > now()
        ORDER BY created_at DESC LIMIT 1`,
      [actor.organizationId, actor.actorId],
    );
    const delegationRow = delegationResult.rows[0] ?? null;

    const credential: CredentialAuthority = {
      scopes: toScopeArray(credentialRow.scopes),
      externalDeliveryAuthorized: Boolean(credentialRow.external_delivery_authorized),
      expiresAt:
        credentialRow.expires_at instanceof Date ? credentialRow.expires_at.toISOString() : null,
      disabledAt:
        credentialRow.disabled_at instanceof Date ? credentialRow.disabled_at.toISOString() : null,
    };
    const delegation: DelegationAuthority | null = delegationRow
      ? {
          permittedScopes: toScopeArray(delegationRow.permitted_scopes),
          projectId: delegationRow.project_id ? String(delegationRow.project_id) : null,
          expiresAt: (delegationRow.expires_at as Date).toISOString(),
          revokedAt: null,
        }
      : null;

    const decision = decideAuthority(credential, delegation, request, new Date());
    const delegationId = delegationRow ? String(delegationRow.id) : null;

    if (decision.requiresApproval) {
      const approvalId = await this.openApproval(actor, delegationId, request, decision.reason);
      await this.recordInvocation(actor, delegationId, request, "awaiting_approval", decision.reason, approvalId);
      return decision;
    }

    await this.recordInvocation(
      actor,
      delegationId,
      request,
      decision.allowed ? "succeeded" : "rejected",
      decision.reason,
      null,
    );
    return decision;
  }

  private async openApproval(
    actor: ActorContext,
    delegationId: string | null,
    request: OperationRequest,
    reason: string,
  ): Promise<string> {
    const id = randomUUID();
    await this.pool.query(
      `INSERT INTO approval_requests
         (id, organization_id, requested_by_actor_id, delegation_id, operation, reason, request_payload)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        id,
        actor.organizationId,
        actor.actorId,
        delegationId,
        request.requiredScope,
        reason,
        JSON.stringify({
          guarded: request.guarded ?? null,
          projectId: request.projectId ?? null,
          affectedRecordCount: request.affectedRecordCount ?? 0,
        }),
      ],
    );
    return id;
  }

  private async recordInvocation(
    actor: ActorContext,
    delegationId: string | null,
    request: OperationRequest,
    outcome: string,
    detail: string,
    approvalRequestId: string | null,
  ): Promise<void> {
    await this.pool.query(
      `INSERT INTO agent_invocations
         (id, organization_id, actor_id, delegation_id, request_id, operation, outcome, detail, approval_request_id)
       VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6::invocation_outcome, $7, $8)`,
      [
        actor.organizationId,
        actor.actorId,
        delegationId,
        actor.requestId,
        request.guarded ? `${request.requiredScope}:${request.guarded}` : request.requiredScope,
        outcome,
        detail,
        approvalRequestId,
      ],
    );
  }

  private async decideApproval(client: DbClient, actor: ActorContext, input: Input) {
    requireHumanAdministrator(actor);
    const approvalId = requiredId(input, "approvalId");
    const state = String(input.state);
    if (!["approved", "rejected"].includes(state)) {
      throw new ApiError(400, "INVALID_INPUT", "An approval is approved or rejected.");
    }
    const updated = await client.query<Row>(
      `UPDATE approval_requests
          SET state = $3::approval_state, decided_by_actor_id = $4, decided_at = now(),
              decision_rationale = $5
        WHERE organization_id = $1 AND id = $2 AND state = 'pending'
        RETURNING *`,
      [actor.organizationId, approvalId, state, actor.actorId, input.rationale ?? ""],
    );
    if (!updated.rows[0]) throw notFound();
    const approval = camelize(updated.rows[0]);
    return this.record(actor, `agent.approval.${state}`, "approval_request", approvalId, { approval }, null, approval);
  }

  // ---------------------------------------------------------------- reads --

  private async listAgents(actor: ActorContext): Promise<Result> {
    requireHumanAdministrator(actor);
    const result = await this.pool.query<Row>(
      `SELECT a.id AS actor_id, a.display_name, a.type, a.role, a.disabled_at,
              c.id AS credential_id, c.service_key_prefix, c.scopes,
              c.external_delivery_authorized, c.expires_at, c.rotated_at,
              c.disabled_at AS credential_disabled_at
         FROM actors a
         LEFT JOIN agent_credentials c
           ON c.organization_id = a.organization_id AND c.actor_id = a.id
        WHERE a.organization_id = $1 AND a.type IN ('agent', 'automation')
        ORDER BY a.display_name`,
      [actor.organizationId],
    );
    return { agents: result.rows.map(camelize) };
  }

  private async listDelegations(actor: ActorContext): Promise<Result> {
    requireHumanAdministrator(actor);
    const result = await this.pool.query<Row>(
      `SELECT d.*, a.display_name AS actor_display_name
         FROM agent_delegations d
         JOIN actors a ON a.organization_id = d.organization_id AND a.id = d.actor_id
        WHERE d.organization_id = $1
        ORDER BY d.created_at DESC LIMIT 100`,
      [actor.organizationId],
    );
    return { delegations: result.rows.map(camelize) };
  }

  private async listApprovals(actor: ActorContext): Promise<Result> {
    requireHumanAdministrator(actor);
    const result = await this.pool.query<Row>(
      `SELECT r.*, a.display_name AS requested_by_display_name
         FROM approval_requests r
         JOIN actors a ON a.organization_id = r.organization_id AND a.id = r.requested_by_actor_id
        WHERE r.organization_id = $1
        ORDER BY r.state = 'pending' DESC, r.created_at DESC LIMIT 100`,
      [actor.organizationId],
    );
    return { approvals: result.rows.map(camelize) };
  }

  private async listInvocations(actor: ActorContext, input: Input): Promise<Result> {
    requireHumanAdministrator(actor);
    const result = await this.pool.query<Row>(
      `SELECT i.*, a.display_name AS actor_display_name,
              d.task_source, d.delegated_by_actor_id
         FROM agent_invocations i
         JOIN actors a ON a.organization_id = i.organization_id AND a.id = i.actor_id
         LEFT JOIN agent_delegations d
           ON d.organization_id = i.organization_id AND d.id = i.delegation_id
        WHERE i.organization_id = $1
          AND ($2::uuid IS NULL OR i.actor_id = $2::uuid)
        ORDER BY i.created_at DESC LIMIT 200`,
      [actor.organizationId, input.actorId ?? null],
    );
    return { invocations: result.rows.map(camelize) };
  }

  private record(
    actor: ActorContext,
    operation: string,
    resourceType: string,
    resourceId: string,
    value: Result,
    before: Record<string, unknown> | null,
    after: Record<string, unknown> | null,
  ) {
    return {
      value,
      audit: {
        organizationId: actor.organizationId,
        actorId: actor.actorId,
        requestId: actor.requestId,
        action: operation,
        resourceType,
        resourceId,
        before,
        after,
      },
      event: {
        organizationId: actor.organizationId,
        actorId: actor.actorId,
        requestId: actor.requestId,
        eventType: atlasEventTypes.agentChanged,
        aggregateType: resourceType,
        aggregateId: resourceId,
        schemaVersion: 1,
        // A service key never enters an event payload.
        payload: { operation, resourceId },
      },
    };
  }
}
