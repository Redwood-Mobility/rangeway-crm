import type {
  CursorContract,
  CursorSortType,
  WorkItemStatus,
} from "../../../shared/operating-core.js";
import type { ActorContext } from "../../../shared/identity.js";
import { ApiError } from "../../platform/http/api-error.js";

/**
 * Organization roles allowed to act across records they do not personally own.
 * Merges rewrite relationships spanning many projects and private rows, so they
 * are restricted to these principals rather than to project write access.
 */
const privilegedRoles = new Set(["owner", "admin"]);

export function isPrivilegedActor(actor: ActorContext): boolean {
  return privilegedRoles.has(actor.role);
}

export function assertPrivilegedMergeActor(actor: ActorContext): void {
  if (!isPrivilegedActor(actor)) {
    throw new ApiError(
      403,
      "FORBIDDEN",
      "Merging records requires an organization owner or administrator.",
    );
  }
}

export interface RelationshipOwnership {
  visibility: string;
  createdByActorId: string | null;
}

/**
 * A `private` relationship belongs to the actor who created it. Project write
 * access is not sufficient to read, change, expose, or archive it; only its
 * creator or a privileged organization role may mutate it.
 */
export function canMutateProjectRelationship(
  actor: ActorContext,
  relationship: RelationshipOwnership,
): boolean {
  if (relationship.visibility !== "private") return true;
  if (relationship.createdByActorId === actor.actorId) return true;
  return isPrivilegedActor(actor);
}

const allowedTransitions: Readonly<Record<WorkItemStatus, readonly WorkItemStatus[]>> = {
  inbox: ["next", "canceled"],
  next: ["inbox", "in_progress", "waiting", "canceled"],
  in_progress: ["waiting", "done", "canceled"],
  waiting: ["next", "in_progress", "canceled"],
  done: ["next", "in_progress"],
  canceled: ["inbox"],
};

/** Binds a listing's cursor to that listing and to its ORDER BY column type. */
export function cursorContract(purpose: string, sortType: CursorSortType = "timestamp"): CursorContract {
  return { purpose, sortType };
}

export function assertStatusTransition(from: WorkItemStatus, to: WorkItemStatus): void {
  if (from === to) return;
  if (!allowedTransitions[from].includes(to)) {
    throw new ApiError(409, "CONFLICT", "Invalid work item status transition.");
  }
}

export function assertAcyclicDependencyGraph(
  edges: ReadonlyArray<readonly [blockedId: string, dependencyId: string]>,
  blockedId: string,
  dependencyId: string,
): void {
  const dependencies = new Map<string, string[]>();
  for (const [blocked, dependency] of edges) {
    const existing = dependencies.get(blocked) ?? [];
    existing.push(dependency);
    dependencies.set(blocked, existing);
  }
  const pending = [dependencyId];
  const visited = new Set<string>();
  while (pending.length > 0) {
    const candidate = pending.pop()!;
    if (candidate === blockedId) {
      throw new ApiError(409, "CONFLICT", "Work item dependencies cannot contain a cycle.");
    }
    if (visited.has(candidate)) continue;
    visited.add(candidate);
    pending.push(...(dependencies.get(candidate) ?? []));
  }
}
