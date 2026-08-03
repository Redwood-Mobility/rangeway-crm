import type { WorkItemStatus } from "../../../shared/operating-core.js";
import { ApiError } from "../../platform/http/api-error.js";

const allowedTransitions: Readonly<Record<WorkItemStatus, readonly WorkItemStatus[]>> = {
  inbox: ["next", "canceled"],
  next: ["inbox", "in_progress", "waiting", "canceled"],
  in_progress: ["waiting", "done", "canceled"],
  waiting: ["next", "in_progress", "canceled"],
  done: ["next", "in_progress"],
  canceled: ["inbox"],
};

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
