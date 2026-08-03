/**
 * Client view models. These mirror the `/api/v2` contract and the shared server
 * vocabularies; they are not hand-shaped V1 types.
 */

export const workItemTypes = ["action", "deliverable", "follow_up", "approval", "research"] as const;
export type WorkItemType = (typeof workItemTypes)[number];

export const workItemStatuses = ["inbox", "next", "in_progress", "waiting", "done", "canceled"] as const;
export type WorkItemStatus = (typeof workItemStatuses)[number];

export const projectStatuses = ["planned", "active", "on_hold", "completed", "canceled"] as const;
export type ProjectStatus = (typeof projectStatuses)[number];

export const projectHealthValues = ["unknown", "on_track", "at_risk", "off_track"] as const;
export type ProjectHealth = (typeof projectHealthValues)[number];

export const priorityValues = ["low", "medium", "high", "urgent"] as const;
export type Priority = (typeof priorityValues)[number];

export const projectRoles = ["owner", "editor", "viewer"] as const;
export type ProjectRole = (typeof projectRoles)[number];

export const searchRecordTypes = ["project", "work_item", "person", "counterparty"] as const;
export type SearchRecordType = (typeof searchRecordTypes)[number];

export const workItemStatusLabels: Record<WorkItemStatus, string> = {
  inbox: "Inbox",
  next: "Next",
  in_progress: "In Progress",
  waiting: "Waiting",
  done: "Done",
  canceled: "Canceled",
};

export const workItemTypeLabels: Record<WorkItemType, string> = {
  action: "Action",
  deliverable: "Deliverable",
  follow_up: "Follow-up",
  approval: "Approval",
  research: "Research",
};

export const projectHealthLabels: Record<ProjectHealth, string> = {
  unknown: "Unknown",
  on_track: "On track",
  at_risk: "At risk",
  off_track: "Off track",
};

export const projectStatusLabels: Record<ProjectStatus, string> = {
  planned: "Planned",
  active: "Active",
  on_hold: "On hold",
  completed: "Completed",
  canceled: "Canceled",
};

export const priorityLabels: Record<Priority, string> = {
  low: "Low",
  medium: "Medium",
  high: "High",
  urgent: "Urgent",
};

/** Board lanes. `canceled` is reachable but is not a lane on the board. */
export const boardLanes: WorkItemStatus[] = ["inbox", "next", "in_progress", "waiting", "done"];

export interface Actor {
  actorId: string;
  actorType: "human" | "agent" | "automation";
  actorName: string;
  organizationId: string;
  role: "owner" | "admin" | "member" | "viewer";
  userId: string | null;
}

export interface Project {
  id: string;
  organizationId: string;
  name: string;
  objective: string;
  templateType: string;
  status: ProjectStatus;
  health: ProjectHealth;
  priority: Priority;
  strategicArea: string;
  ownerUserId: string | null;
  currentFocus: string;
  blockerSummary: string;
  nextDecision: string;
  nextAction: string;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
}

export interface PortfolioProject extends Project {
  workStatusCounts: Partial<Record<WorkItemStatus, number>>;
  recentActivityAt: string | null;
}

export interface WorkItem {
  id: string;
  organizationId: string;
  projectId: string;
  workstreamId: string | null;
  parentId: string | null;
  type: WorkItemType;
  title: string;
  description: string;
  ownerUserId: string | null;
  status: WorkItemStatus;
  priority: Priority;
  dueAt: string | null;
  position: string;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
  labels: Array<{ id: string; name: string; color: string }>;
  dependencies: string[];
}

export interface Workstream {
  id: string;
  projectId: string;
  name: string;
  description: string;
  status: string;
  position: string;
}

export interface Decision {
  id: string;
  primaryProjectId: string;
  question: string;
  state: "proposed" | "final";
  outcome: string;
  rationale: string;
  ownerUserId: string | null;
  decisionAt: string | null;
  createdAt: string;
}

export interface Risk {
  id: string;
  projectId: string;
  title: string;
  description: string;
  likelihood: "low" | "medium" | "high";
  impact: "low" | "medium" | "high" | "critical";
  mitigation: string;
  state: "open" | "mitigating" | "accepted" | "closed";
}

export interface Blocker {
  id: string;
  projectId: string;
  condition: string;
  targetType: "project" | "workstream" | "work_item";
  targetId: string;
  resolvedAt: string | null;
}

export interface Milestone {
  id: string;
  projectId: string;
  outcome: string;
  targetAt: string | null;
  state: "planned" | "completed" | "canceled";
  completedAt: string | null;
}

export interface ActivityEntry {
  id: string;
  projectId: string;
  summary: string;
  occurredAt: string;
  createdByActorId: string;
}

export interface Person {
  id: string;
  displayName: string;
  givenName: string;
  familyName: string;
  email: string | null;
  phone: string;
  title: string;
  notes: string;
  createdAt: string;
}

export interface Counterparty {
  id: string;
  name: string;
  kind: string;
  website: string;
  notes: string;
  createdAt: string;
}

export interface HealthUpdate {
  id: string;
  projectId: string;
  health: ProjectHealth;
  rationale: string;
  createdAt: string;
}

export interface SectionMeta {
  count: number;
  truncated: boolean;
  nextCursor: string | null;
}

export interface ProjectContext {
  project: Project;
  sectionLimit: number;
  sections: Record<string, SectionMeta>;
  workstreams: Workstream[];
  workItems: WorkItem[];
  decisions: Decision[];
  risks: Risk[];
  blockers: Blocker[];
  milestones: Milestone[];
  activities: ActivityEntry[];
  people: Array<Person & { projectRole: string; visibility: string; relationshipNotes: string }>;
  counterparties: Array<Counterparty & { projectRole: string; visibility: string }>;
  healthUpdates: HealthUpdate[];
}

export interface TodayBriefing {
  date: string;
  workItems: WorkItem[];
  decisionsNeeded: Decision[];
  healthChanges: HealthUpdate[];
  agentActivity: ActivityEntry[];
  upcomingMilestones: Milestone[];
}

export interface SearchResult {
  type: SearchRecordType;
  id: string;
  title: string;
  summary: string | null;
  updatedAt: string;
}
