import process from "node:process";
import { pathToFileURL } from "node:url";
import type { Pool, QueryConfig, QueryResult } from "pg";
import { createPool } from "../server/platform/db/client.js";
import { parseWorkerConfig } from "./config.js";

export const workerContractVersion = "atlas-v2-foundation-v1";

export async function checkWorkerReadiness(
  pool: Pick<Pool, "query">,
  requireProductionIdentity: boolean,
): Promise<{ status: "ready"; service: "atlas-worker"; contractVersion: string }> {
  type ReadinessRow = { role_ok?: boolean; database_ok?: boolean; permissions_ok?: boolean };
  const boundedQuery = pool.query.bind(pool) as (
    query: QueryConfig & { query_timeout: number },
  ) => Promise<QueryResult<ReadinessRow>>;
  const result = await boundedQuery({
    text: `SELECT
      current_user = 'atlas_worker' AS role_ok,
      current_database() = 'atlas' AS database_ok,
      has_table_privilege(current_user, 'public.outbox_events', 'SELECT')
        AND has_column_privilege(current_user, 'public.outbox_events', 'attempt_count', 'UPDATE')
        AND NOT has_column_privilege(current_user, 'public.outbox_events', 'payload', 'UPDATE')
        AS permissions_ok`,
    query_timeout: 2_000,
  });
  const readiness = result.rows[0];
  if (
    readiness?.permissions_ok !== true ||
    (requireProductionIdentity &&
      (readiness.role_ok !== true || readiness.database_ok !== true))
  ) {
    throw new Error("Atlas worker is not ready.");
  }
  return {
    status: "ready",
    service: "atlas-worker",
    contractVersion: workerContractVersion,
  };
}

async function main(): Promise<void> {
  const config = parseWorkerConfig(process.env);
  const pool = createPool(config.databaseUrl);
  try {
    await checkWorkerReadiness(pool, process.env.NODE_ENV === "production");
  } catch {
    throw new Error("Atlas worker is not ready.");
  } finally {
    await pool.end();
  }
}

const entrypoint = process.argv[1];
if (entrypoint && import.meta.url === pathToFileURL(entrypoint).href) {
  main().catch(() => {
    console.error("Atlas worker is not ready.");
    process.exitCode = 1;
  });
}
