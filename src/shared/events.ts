export const atlasEventTypes = {
  organizationUpdated: "organization.updated.v1",
} as const;

export type AtlasEventType =
  (typeof atlasEventTypes)[keyof typeof atlasEventTypes];
