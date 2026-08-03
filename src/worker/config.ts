import "dotenv/config";
import { z } from "zod";
import { validateProductionPostgresUrl } from "../shared/postgres-url.js";

const workerConfigSchema = z
  .object({
    nodeEnv: z.enum(["development", "test", "production"]).default("development"),
    databaseUrl: z.string().trim().min(1, "DATABASE_URL is required to run the outbox worker."),
    workerPollMilliseconds: z.coerce.number().int().positive().default(1000),
  })
  .superRefine((value, context) => {
    if (value.nodeEnv !== "production") return;
    const issue = validateProductionPostgresUrl(value.databaseUrl, {
      username: "atlas_worker",
      hostname: "db",
      database: "atlas",
    });
    if (issue) {
      context.addIssue({
        code: "custom",
        path: ["databaseUrl"],
        message: `Production worker DATABASE_URL ${issue}.`,
      });
    }
  });

export interface WorkerConfig {
  databaseUrl: string;
  workerPollMilliseconds: number;
}

export function parseWorkerConfig(env: NodeJS.ProcessEnv): WorkerConfig {
  const parsed = workerConfigSchema.parse({
    nodeEnv: env.NODE_ENV,
    databaseUrl: env.DATABASE_URL,
    workerPollMilliseconds: env.WORKER_POLL_MS,
  });
  return {
    databaseUrl: parsed.databaseUrl,
    workerPollMilliseconds: parsed.workerPollMilliseconds,
  };
}
