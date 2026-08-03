import "dotenv/config";
import { z } from "zod";

const workerConfigSchema = z
  .object({
    nodeEnv: z.enum(["development", "test", "production"]).default("development"),
    databaseUrl: z.string().trim().min(1, "DATABASE_URL is required to run the outbox worker."),
    workerPollMilliseconds: z.coerce.number().int().positive().default(1000),
  })
  .superRefine((value, context) => {
    if (value.nodeEnv !== "production") return;
    try {
      if (new URL(value.databaseUrl).username !== "atlas_worker") {
        context.addIssue({
          code: "custom",
          path: ["databaseUrl"],
          message: "Production worker DATABASE_URL must use atlas_worker.",
        });
      }
    } catch {
      context.addIssue({
        code: "custom",
        path: ["databaseUrl"],
        message: "Production worker DATABASE_URL must be a valid PostgreSQL URL.",
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
