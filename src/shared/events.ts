export const atlasEventTypes = {
  organizationUpdated: "organization.updated.v1",
  identityOwnerProvisioned: "identity.owner-provisioned.v1",
  identityGoogleLinked: "identity.google-linked.v1",
  identityGoogleProfileUpdated: "identity.google-profile-updated.v1",
  identityServiceActorCreated: "identity.service-actor-created.v1",
  identityServiceActorDisabled: "identity.service-actor-disabled.v1",
  projectChanged: "project.changed.v1",
  projectMembershipChanged: "project.membership-changed.v1",
  projectHealthChanged: "project.health-changed.v1",
  workstreamChanged: "workstream.changed.v1",
  workItemChanged: "work-item.changed.v1",
  workItemDependencyChanged: "work-item.dependency-changed.v1",
  labelChanged: "label.changed.v1",
  decisionChanged: "decision.changed.v1",
  riskChanged: "risk.changed.v1",
  blockerChanged: "blocker.changed.v1",
  milestoneChanged: "milestone.changed.v1",
  activityRecorded: "activity.recorded.v1",
  personChanged: "person.changed.v1",
  counterpartyChanged: "counterparty.changed.v1",
  projectRelationshipChanged: "project.relationship-changed.v1",
  savedViewChanged: "saved-view.changed.v1",
} as const;

export type AtlasEventType =
  (typeof atlasEventTypes)[keyof typeof atlasEventTypes];
