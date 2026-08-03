/**
 * Agent authority.
 *
 * Effective authority is the intersection of what a credential carries and what
 * the active task delegation permits. A broad credential does not widen a narrow
 * task, and a broad task does not widen a narrow credential.
 */

export const agentScopes = [
  "read",
  "work.write",
  "project.write",
  "evidence.write",
  "report.prepare",
  "report.deliver",
  "admin",
] as const;
export type AgentScope = (typeof agentScopes)[number];

/** Operations that always require a human decision, whatever the scopes say. */
export const guardedOperations = {
  externalDelivery: "external-delivery",
  credentialChange: "credential-change",
  permissionChange: "permission-change",
  permanentDeletion: "permanent-deletion",
  bulkMutation: "bulk-mutation",
} as const;
export type GuardedOperation = (typeof guardedOperations)[keyof typeof guardedOperations];

/** A bulk change larger than this is outside routine task authority. */
export const bulkMutationThreshold = 25;

export interface CredentialAuthority {
  scopes: readonly AgentScope[];
  externalDeliveryAuthorized: boolean;
  expiresAt: string | null;
  disabledAt: string | null;
}

export interface DelegationAuthority {
  permittedScopes: readonly AgentScope[];
  projectId: string | null;
  expiresAt: string;
  revokedAt: string | null;
}

export interface AuthorityDecision {
  allowed: boolean;
  /** Set when the operation is not refused outright but needs a human. */
  requiresApproval: boolean;
  reason: string;
  effectiveScopes: AgentScope[];
}

export interface OperationRequest {
  requiredScope: AgentScope;
  /** Present when the operation is inherently guarded. */
  guarded?: GuardedOperation;
  projectId?: string | null;
  affectedRecordCount?: number;
  /** True when a human explicitly asked for this external message. */
  requestedByHuman?: boolean;
}

function intersect(
  credential: readonly AgentScope[],
  delegation: readonly AgentScope[],
): AgentScope[] {
  const permitted = new Set(delegation);
  return credential.filter((scope) => permitted.has(scope));
}

export function effectiveScopes(
  credential: CredentialAuthority,
  delegation: DelegationAuthority,
): AgentScope[] {
  return intersect(credential.scopes, delegation.permittedScopes);
}

export function decideAuthority(
  credential: CredentialAuthority,
  delegation: DelegationAuthority | null,
  request: OperationRequest,
  now: Date,
): AuthorityDecision {
  const nothing: AgentScope[] = [];

  if (credential.disabledAt) {
    return { allowed: false, requiresApproval: false, reason: "credential_disabled", effectiveScopes: nothing };
  }
  if (credential.expiresAt && new Date(credential.expiresAt).getTime() <= now.getTime()) {
    return { allowed: false, requiresApproval: false, reason: "credential_expired", effectiveScopes: nothing };
  }
  if (!delegation) {
    return { allowed: false, requiresApproval: false, reason: "no_active_delegation", effectiveScopes: nothing };
  }
  if (delegation.revokedAt) {
    return { allowed: false, requiresApproval: false, reason: "delegation_revoked", effectiveScopes: nothing };
  }
  if (new Date(delegation.expiresAt).getTime() <= now.getTime()) {
    return { allowed: false, requiresApproval: false, reason: "delegation_expired", effectiveScopes: nothing };
  }

  const scopes = effectiveScopes(credential, delegation);

  // A delegation scoped to one project cannot reach another.
  if (delegation.projectId && request.projectId && delegation.projectId !== request.projectId) {
    return { allowed: false, requiresApproval: false, reason: "outside_delegated_project", effectiveScopes: scopes };
  }

  if (!scopes.includes(request.requiredScope)) {
    return { allowed: false, requiresApproval: false, reason: "scope_not_granted", effectiveScopes: scopes };
  }

  // Guarded operations are never allowed by scope alone.
  if (request.guarded === guardedOperations.permanentDeletion) {
    return { allowed: false, requiresApproval: true, reason: "permanent_deletion_requires_approval", effectiveScopes: scopes };
  }
  if (
    request.guarded === guardedOperations.credentialChange ||
    request.guarded === guardedOperations.permissionChange
  ) {
    return { allowed: false, requiresApproval: true, reason: "permission_change_requires_approval", effectiveScopes: scopes };
  }
  if (request.guarded === guardedOperations.externalDelivery) {
    if (!credential.externalDeliveryAuthorized) {
      return { allowed: false, requiresApproval: true, reason: "external_delivery_not_authorized", effectiveScopes: scopes };
    }
    if (!request.requestedByHuman) {
      return { allowed: false, requiresApproval: true, reason: "unrequested_external_communication", effectiveScopes: scopes };
    }
  }
  if ((request.affectedRecordCount ?? 0) > bulkMutationThreshold) {
    return { allowed: false, requiresApproval: true, reason: "bulk_mutation_requires_approval", effectiveScopes: scopes };
  }

  return { allowed: true, requiresApproval: false, reason: "authorized", effectiveScopes: scopes };
}
