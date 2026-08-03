import path from "node:path";
import process from "node:process";
import "dotenv/config";
import { z } from "zod";
import { validateProductionPostgresUrl } from "../shared/postgres-url.js";

const developmentSessionSecret = "development-session-secret-change-me-please";
const defaultDatabasePath = path.join(process.cwd(), "data", "rangeway-crm.sqlite");
const defaultUploadDir = path.join(process.cwd(), "uploads");

const optionalString = z.preprocess(
  (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
  z.string().trim().min(1).optional()
);

const configSchema = z
  .object({
    nodeEnv: z.enum(["development", "test", "production"]).default("development"),
    port: z.coerce.number().int().min(1).max(65535).default(8080),
    databaseUrl: z.string().trim().default(""),
    sessionSecret: z.string().trim().min(32).default(developmentSessionSecret),
    atlasOrigin: z.string().trim().url().default("http://localhost:5173"),
    artifactDir: z.string().trim().min(1).default("./artifacts"),
    authMode: z.enum(["google", "local"]).default("local"),
    googleClientId: optionalString,
    googleClientSecret: optionalString,
    googleRedirectUri: optionalString,
    workerPollMs: z.coerce.number().int().positive().default(1000),
    // V1 compatibility fields remain until the V2 identity and persistence work replaces them.
    adminEmail: z.string().trim().email().default("admin@rangeway.energy"),
    adminPassword: z.string().default("rangeway-dev"),
    googleAllowedDomain: z.string().trim().min(1).default("rangeway.energy"),
    databasePath: z.string().trim().min(1).default(defaultDatabasePath),
    uploadDir: z.string().trim().min(1).default(defaultUploadDir),
    maxUploadBytes: z.coerce.number().int().positive().default(30 * 1024 * 1024)
  })
  .superRefine((value, context) => {
    if (value.nodeEnv !== "production") return;

    if (value.authMode !== "google") {
      context.addIssue({ code: "custom", path: ["authMode"], message: "AUTH_MODE must be google in production." });
    }
    if (!value.databaseUrl) {
      context.addIssue({ code: "custom", path: ["databaseUrl"], message: "DATABASE_URL is required in production." });
    } else {
      const issue = validateProductionPostgresUrl(value.databaseUrl, {
        username: "atlas_web",
        hostname: "db",
        database: "atlas",
      });
      if (issue) {
        context.addIssue({ code: "custom", path: ["databaseUrl"], message: `DATABASE_URL ${issue}.` });
      }
    }
    if (value.sessionSecret === developmentSessionSecret) {
      context.addIssue({ code: "custom", path: ["sessionSecret"], message: "SESSION_SECRET is required in production." });
    }
    if (value.atlasOrigin === "http://localhost:5173") {
      context.addIssue({ code: "custom", path: ["atlasOrigin"], message: "ATLAS_ORIGIN is required in production." });
    } else if (new URL(value.atlasOrigin).protocol !== "https:") {
      context.addIssue({ code: "custom", path: ["atlasOrigin"], message: "ATLAS_ORIGIN must use HTTPS in production." });
    } else if (value.atlasOrigin !== new URL(value.atlasOrigin).origin) {
      context.addIssue({ code: "custom", path: ["atlasOrigin"], message: "ATLAS_ORIGIN must contain only the browser origin." });
    }

    for (const [field, name] of [
      ["googleClientId", "GOOGLE_CLIENT_ID"],
      ["googleClientSecret", "GOOGLE_CLIENT_SECRET"],
      ["googleRedirectUri", "GOOGLE_REDIRECT_URI"]
    ] as const) {
      if (!value[field]) {
        context.addIssue({ code: "custom", path: [field], message: `${name} is required in production.` });
      }
    }

    if (value.googleRedirectUri) {
      try {
        const redirect = new URL(value.googleRedirectUri);
        if (redirect.protocol !== "https:") {
          context.addIssue({ code: "custom", path: ["googleRedirectUri"], message: "GOOGLE_REDIRECT_URI must use HTTPS in production." });
        } else if (redirect.origin !== new URL(value.atlasOrigin).origin) {
          context.addIssue({ code: "custom", path: ["googleRedirectUri"], message: "GOOGLE_REDIRECT_URI must use the same origin as ATLAS_ORIGIN." });
        } else if (
          redirect.pathname !== "/api/auth/google/callback" ||
          redirect.search ||
          redirect.hash
        ) {
          context.addIssue({ code: "custom", path: ["googleRedirectUri"], message: "GOOGLE_REDIRECT_URI must use the Atlas Google callback path." });
        }
      } catch {
        context.addIssue({ code: "custom", path: ["googleRedirectUri"], message: "GOOGLE_REDIRECT_URI must be a valid URL." });
      }
    }
  });

export type Config = z.infer<typeof configSchema> & {
  isProduction: boolean;
};

export function parseConfig(env: NodeJS.ProcessEnv): Config {
  const parsed = configSchema.parse({
    nodeEnv: env.NODE_ENV,
    port: env.PORT,
    databaseUrl: env.DATABASE_URL,
    sessionSecret: env.SESSION_SECRET,
    atlasOrigin: env.ATLAS_ORIGIN,
    artifactDir: env.ARTIFACT_DIR,
    authMode: env.AUTH_MODE,
    googleClientId: env.GOOGLE_CLIENT_ID,
    googleClientSecret: env.GOOGLE_CLIENT_SECRET,
    googleRedirectUri: env.GOOGLE_REDIRECT_URI,
    workerPollMs: env.WORKER_POLL_MS,
    adminEmail: env.ADMIN_EMAIL,
    adminPassword: env.ADMIN_PASSWORD,
    googleAllowedDomain: env.GOOGLE_ALLOWED_DOMAIN,
    databasePath: env.DATABASE_PATH,
    uploadDir: env.UPLOAD_DIR,
    maxUploadBytes: env.MAX_UPLOAD_MB === undefined ? undefined : Number(env.MAX_UPLOAD_MB) * 1024 * 1024
  });

  return { ...parsed, isProduction: parsed.nodeEnv === "production" };
}

// The preserved V1 OAuth handlers expect empty strings for unset credentials.
// `parseConfig` keeps the V2 contract optional so callers can distinguish absent values.
const parsedConfig = parseConfig(process.env);

export const config: Config & {
  googleClientId: string;
  googleClientSecret: string;
  googleRedirectUri: string;
} = {
  ...parsedConfig,
  googleClientId: parsedConfig.googleClientId ?? "",
  googleClientSecret: parsedConfig.googleClientSecret ?? "",
  googleRedirectUri: parsedConfig.googleRedirectUri ?? ""
};
