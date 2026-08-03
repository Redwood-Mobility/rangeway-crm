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

const idempotencyKeySchema = z
  .string()
  .min(8)
  .max(128)
  .regex(/^[A-Za-z0-9._:-]+$/);

export function createOrganizationRouter(
  organizations: OrganizationMutationPort,
): Router {
  const router = Router();

  router.patch("/organizations/:organizationId", requireActor, async (req, res) => {
    const { organizationId } = organizationParamsSchema.parse(req.params);
    const { name } = organizationNameSchema.parse(req.body);
    const idempotencyKey = idempotencyKeySchema.parse(req.get("Idempotency-Key"));
    const organization = await organizations.rename(
      req.actor!,
      organizationId,
      name,
      idempotencyKey,
    );
    res.json({ organization });
  });

  return router;
}
