export const atlasEventTypes = {
  organizationUpdated: "organization.updated.v1",
  identityOwnerProvisioned: "identity.owner-provisioned.v1",
  identityGoogleLinked: "identity.google-linked.v1",
  identityGoogleProfileUpdated: "identity.google-profile-updated.v1",
} as const;

export type AtlasEventType =
  (typeof atlasEventTypes)[keyof typeof atlasEventTypes];
