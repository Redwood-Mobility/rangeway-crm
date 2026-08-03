import { ApiError } from "../server/platform/http/api-error.js";

export const workItemTypes = [
  "action",
  "deliverable",
  "follow_up",
  "approval",
  "research",
] as const;
export type WorkItemType = (typeof workItemTypes)[number];

export const workItemStatuses = [
  "inbox",
  "next",
  "in_progress",
  "waiting",
  "done",
  "canceled",
] as const;
export type WorkItemStatus = (typeof workItemStatuses)[number];

export const projectStatuses = ["planned", "active", "on_hold", "completed", "canceled"] as const;
export type ProjectStatus = (typeof projectStatuses)[number];

export const projectHealthValues = ["unknown", "on_track", "at_risk", "off_track"] as const;
export type ProjectHealth = (typeof projectHealthValues)[number];

export const priorityValues = ["low", "medium", "high", "urgent"] as const;
export type Priority = (typeof priorityValues)[number];

export const projectRoles = ["owner", "editor", "viewer"] as const;
export type ProjectRole = (typeof projectRoles)[number];

export const decisionStates = ["proposed", "final"] as const;
export const riskLikelihoods = ["low", "medium", "high"] as const;
export const riskImpacts = ["low", "medium", "high", "critical"] as const;
export const riskStates = ["open", "mitigating", "accepted", "closed"] as const;
export const blockerTargetTypes = ["project", "workstream", "work_item", "requirement"] as const;
export const milestoneStates = ["planned", "completed", "canceled"] as const;
export const relationshipInfluences = ["low", "medium", "high"] as const;
export const relationshipSentiments = ["negative", "neutral", "positive", "unknown"] as const;

export interface PageCursor {
  sortValue: string;
  id: string;
}

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function encodeCursor(cursor: PageCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

export function decodeCursor(cursor: string): PageCursor {
  try {
    const decoded = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as unknown;
    if (
      typeof decoded !== "object" ||
      decoded === null ||
      !("sortValue" in decoded) ||
      typeof decoded.sortValue !== "string" ||
      decoded.sortValue.length === 0 ||
      !("id" in decoded) ||
      typeof decoded.id !== "string" ||
      !uuidPattern.test(decoded.id)
    ) {
      throw new Error("invalid cursor shape");
    }
    return { sortValue: decoded.sortValue, id: decoded.id };
  } catch {
    throw new ApiError(400, "INVALID_INPUT", "Invalid pagination cursor.");
  }
}
