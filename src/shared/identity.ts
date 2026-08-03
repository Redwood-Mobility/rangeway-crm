export const actorTypes = ["human", "agent", "automation"] as const;
export type ActorType = (typeof actorTypes)[number];

export const organizationRoles = ["owner", "admin", "member", "viewer"] as const;
export type OrganizationRole = (typeof organizationRoles)[number];

export interface ActorContext {
  actorId: string;
  actorType: ActorType;
  actorName: string;
  organizationId: string;
  role: OrganizationRole;
  requestId: string;
  userId?: string;
}
