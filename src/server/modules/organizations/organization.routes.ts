import { Router } from "express";
import { z } from "zod";
import { requireActor } from "../../platform/http/request-context.js";
import type { OrganizationMutationPort } from "./organization.service.js";

const organizationParamsSchema = z.object({
  organizationId: z.uuid(),
});

const organizationNameSchema = z.strictObject({
  name: z.string().trim().min(1).max(200),
});

export function createOrganizationRouter(
  organizations: OrganizationMutationPort,
): Router {
  const router = Router();

  router.patch("/organizations/:organizationId", requireActor, async (req, res) => {
    const { organizationId } = organizationParamsSchema.parse(req.params);
    const { name } = organizationNameSchema.parse(req.body);
    const organization = await organizations.rename(
      req.actor!,
      organizationId,
      name,
    );
    res.json({ organization });
  });

  return router;
}
