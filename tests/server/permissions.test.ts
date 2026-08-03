import { describe, expect, it } from "vitest";
import { ApiError } from "../../src/server/platform/http/api-error.js";
import { assertMinimumRole } from "../../src/server/modules/identity/identity.service.js";
import { actorTypes, organizationRoles } from "../../src/shared/identity.js";

describe("identity contracts and organization permissions", () => {
  it("publishes the exact actor and organization role vocabularies", () => {
    expect(actorTypes).toEqual(["human", "agent", "automation"]);
    expect(organizationRoles).toEqual(["owner", "admin", "member", "viewer"]);
  });

  it("rejects a viewer performing a member operation", () => {
    expect(() => assertMinimumRole("viewer", "member")).toThrowError(
      expect.objectContaining<ApiError>({
        status: 403,
        code: "FORBIDDEN",
      }),
    );
  });

  it("allows an owner to perform every organization operation", () => {
    for (const required of organizationRoles) {
      expect(() => assertMinimumRole("owner", required)).not.toThrow();
    }
  });
});
