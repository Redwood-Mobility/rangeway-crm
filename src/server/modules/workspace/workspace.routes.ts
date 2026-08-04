import { Router, type RequestHandler } from "express";
import { z } from "zod";
import { randomBytes } from "node:crypto";
import { requireActor } from "../../platform/http/request-context.js";
import { buildConsentUrl, exchangeConsentCode, type GoogleOAuthConfig } from "./google-client.js";
import { newCredentialReference, storeGoogleTokens } from "./credential-store.js";
import { ApiError } from "../../platform/http/api-error.js";
import type { Pool } from "pg";
import type { WorkspacePort } from "./workspace.service.js";

const uuid = z.uuid();
const idempotencyKeySchema = z.string().min(8).max(128).regex(/^[A-Za-z0-9._:-]+$/);
const sourceKinds = ["gmail_thread", "gmail_message", "drive_item", "calendar_event"] as const;

function queryRoute(core: WorkspacePort, operation: string, schema: z.ZodType): RequestHandler {
  return async (req, res, next) => {
    try {
      const input = schema.parse({ ...req.params, ...req.query });
      res.json(await core.query(req.actor!, operation, input as Record<string, unknown>));
    } catch (error) {
      next(error);
    }
  };
}

function mutateRoute(
  core: WorkspacePort,
  operation: string,
  schema: z.ZodType,
  options: { status?: number; paramSchema?: z.ZodType } = {},
): RequestHandler {
  return async (req, res, next) => {
    try {
      const key = idempotencyKeySchema.parse(req.get("Idempotency-Key"));
      const params = options.paramSchema ? options.paramSchema.parse(req.params) : {};
      const body = schema.parse(req.body ?? {});
      res
        .status(options.status ?? 200)
        .json(
          await core.mutate(
            req.actor!,
            operation,
            { ...(params as object), ...(body as object) } as Record<string, unknown>,
            key,
          ),
        );
    } catch (error) {
      next(error);
    }
  };
}

export interface WorkspaceConsentOptions {
  pool: Pool;
  oauth: GoogleOAuthConfig | null;
  atlasOrigin: string;
  isProduction: boolean;
}

export function createWorkspaceRouter(
  core: WorkspacePort,
  consent?: WorkspaceConsentOptions,
): Router {
  const router = Router();
  router.use(requireActor);

  if (consent?.oauth) {
    const oauth = consent.oauth;
    const stateCookie = "rw_workspace_state";
    const cookiePath = "/api/v2/workspace/google";

    // Starts the Workspace consent. This is deliberately separate from sign-in:
    // signing in needs only identity, while indexing needs read scopes the user
    // grants explicitly and can decline without losing access to Atlas.
    router.get("/workspace/google/connect", (req, res) => {
      const actor = req.actor!;
      if (actor.actorType !== "human") {
        throw new ApiError(403, "FORBIDDEN", "A Workspace connection belongs to a person.");
      }
      const state = randomBytes(24).toString("base64url");
      res.cookie(stateCookie, state, {
        httpOnly: true,
        sameSite: "lax",
        secure: consent.isProduction,
        maxAge: 600_000,
        path: cookiePath,
      });
      res.redirect(buildConsentUrl(oauth, state, req.query.email ? String(req.query.email) : undefined));
    });

    router.get("/workspace/google/callback", async (req, res, next) => {
      try {
        const actor = req.actor!;
        const expected = String(req.cookies?.[stateCookie] ?? "");
        const provided = typeof req.query.state === "string" ? req.query.state : "";
        res.clearCookie(stateCookie, { path: cookiePath });

        // A mismatched or missing state means this callback did not originate
        // from a consent Atlas started.
        if (!expected || !provided || expected !== provided) {
          throw new ApiError(400, "INVALID_INPUT", "That authorization could not be verified.");
        }
        if (typeof req.query.error === "string" && req.query.error) {
          res.redirect(`${consent.atlasOrigin}/settings/workspace?connect=declined`);
          return;
        }
        const code = typeof req.query.code === "string" ? req.query.code : "";
        if (!code) throw new ApiError(400, "INVALID_INPUT", "Authorization code missing.");

        const tokens = await exchangeConsentCode(oauth, code);
        const credentialReference = newCredentialReference();
        await storeGoogleTokens(consent.pool, {
          organizationId: actor.organizationId,
          ownerUserId: actor.userId!,
          credentialReference,
          tokens,
        });

        await core.mutate(
          actor,
          "workspace.connect",
          {
            googleEmail: req.query.email ? String(req.query.email) : `${actor.userId}@${oauth.allowedDomain}`,
            scopes: tokens.grantedScopes,
            credentialReference,
          },
          `workspace-connect-${credentialReference}`.slice(0, 128),
        );
        res.redirect(`${consent.atlasOrigin}/settings/workspace?connect=ok`);
      } catch (error) {
        next(error);
      }
    });
  }

  router.get("/workspace/connections", queryRoute(core, "workspace.connections", z.object({})));
  router.post(
    "/workspace/connections",
    mutateRoute(
      core,
      "workspace.connect",
      z.strictObject({
        googleEmail: z.email(),
        scopes: z.array(z.string().trim().min(1)).default([]),
        credentialReference: z.string().trim().min(1).max(300),
      }),
      { status: 201 },
    ),
  );
  router.delete(
    "/workspace/connections/:connectionId",
    mutateRoute(core, "workspace.disconnect", z.strictObject({}).default({}), {
      paramSchema: z.object({ connectionId: uuid }),
    }),
  );
  router.post(
    "/workspace/connections/:connectionId/sync",
    mutateRoute(core, "workspace.sync", z.strictObject({}).default({}), {
      paramSchema: z.object({ connectionId: uuid }),
    }),
  );

  router.get(
    "/workspace/search",
    queryRoute(
      core,
      "workspace.search",
      z.object({
        q: z.string().trim().min(2).max(200),
        limit: z.coerce.number().int().min(1).max(100).default(25),
      }),
    ),
  );
  router.get(
    "/workspace/calendar",
    queryRoute(
      core,
      "workspace.calendar",
      z.object({
        from: z.iso.datetime({ offset: true }).optional(),
        to: z.iso.datetime({ offset: true }).optional(),
      }),
    ),
  );
  router.get("/workspace/suggestions", queryRoute(core, "workspace.suggestions", z.object({})));
  router.patch(
    "/workspace/suggestions/:suggestionId",
    mutateRoute(
      core,
      "workspace.suggestion.review",
      z.strictObject({ reviewState: z.enum(["accepted", "rejected", "superseded"]) }),
      { paramSchema: z.object({ suggestionId: uuid }) },
    ),
  );

  router.get(
    "/projects/:projectId/workspace-shares",
    queryRoute(core, "workspace.shares", z.object({ projectId: uuid })),
  );
  router.post(
    "/projects/:projectId/workspace-shares",
    mutateRoute(
      core,
      "workspace.share",
      z.strictObject({ sourceKind: z.enum(sourceKinds), sourceId: uuid }),
      { status: 201, paramSchema: z.object({ projectId: uuid }) },
    ),
  );
  router.delete(
    "/workspace-shares/:shareId",
    mutateRoute(core, "workspace.share.revoke", z.strictObject({}).default({}), {
      paramSchema: z.object({ shareId: uuid }),
    }),
  );

  return router;
}
