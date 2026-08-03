import { describe, expect, it } from "vitest";
import {
  decodeCursor,
  encodeCursor,
  workItemStatuses,
  workItemTypes,
} from "../../src/shared/operating-core.js";
import {
  assertAcyclicDependencyGraph,
  assertStatusTransition,
} from "../../src/server/modules/operating-core/operating-core.policy.js";
import { ApiError } from "../../src/server/platform/http/api-error.js";

describe("Operating Core domain policy", () => {
  it("defines the five approved work types and six approved statuses once", () => {
    expect(workItemTypes).toEqual([
      "action",
      "deliverable",
      "follow_up",
      "approval",
      "research",
    ]);
    expect(workItemStatuses).toEqual([
      "inbox",
      "next",
      "in_progress",
      "waiting",
      "done",
      "canceled",
    ]);
  });

  it("permits an approved status transition and rejects a skipped transition", () => {
    expect(() => assertStatusTransition("next", "in_progress")).not.toThrow();
    expect(() => assertStatusTransition("inbox", "done")).toThrowError(
      expect.objectContaining<ApiError>({
        status: 409,
        code: "CONFLICT",
        publicMessage: "Invalid work item status transition.",
      }),
    );
  });

  it("round-trips an opaque stable cursor and rejects malformed pagination", () => {
    const cursor = encodeCursor({
      sortValue: "2026-08-03T12:00:00.000Z",
      id: "00000000-0000-4000-8000-000000000111",
    });
    expect(decodeCursor(cursor)).toEqual({
      sortValue: "2026-08-03T12:00:00.000Z",
      id: "00000000-0000-4000-8000-000000000111",
    });
    expect(() => decodeCursor("not-a-valid-cursor")).toThrowError(
      expect.objectContaining<ApiError>({
        status: 400,
        code: "INVALID_INPUT",
        publicMessage: "Invalid pagination cursor.",
      }),
    );
  });

  it("rejects self, direct, and transitive work dependency cycles", () => {
    const edges: ReadonlyArray<readonly [string, string]> = [
      ["a", "b"],
      ["b", "c"],
    ];
    expect(() => assertAcyclicDependencyGraph(edges, "d", "a")).not.toThrow();
    expect(() => assertAcyclicDependencyGraph(edges, "a", "a")).toThrowError(
      "Work item dependencies cannot contain a cycle.",
    );
    expect(() => assertAcyclicDependencyGraph(edges, "c", "a")).toThrowError(
      "Work item dependencies cannot contain a cycle.",
    );
  });
});
