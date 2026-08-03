import process from "node:process";
import { pathToFileURL } from "node:url";
import type { Pool, QueryConfig, QueryResult } from "pg";
import {
  webPermissionContractSql,
  workerPermissionContractSql,
} from "../../../shared/database-permission-contract.js";
import { createPool } from "./client.js";
import { readMigrationDatabaseUrl } from "./migrate.js";

type PermissionRow = { database_ok?: boolean; permissions_ok?: boolean };

export async function verifyRuntimePermissionContracts(
  pool: Pick<Pool, "query">,
): Promise<void> {
  const boundedQuery = pool.query.bind(pool) as (
    query: QueryConfig & { query_timeout: number },
  ) => Promise<QueryResult<PermissionRow>>;
  for (const text of [webPermissionContractSql, workerPermissionContractSql]) {
    const result = await boundedQuery({ text, query_timeout: 2_000 });
    if (
      result.rows[0]?.database_ok !== true ||
      result.rows[0]?.permissions_ok !== true
    ) {
      throw new Error("Atlas runtime database permission contract failed.");
    }
  }
}

async function main(): Promise<void> {
  const pool = createPool(readMigrationDatabaseUrl(process.env));
  try {
    await verifyRuntimePermissionContracts(pool);
  } finally {
    await pool.end();
  }
}

const entrypoint = process.argv[1];
if (entrypoint && import.meta.url === pathToFileURL(entrypoint).href) {
  main().catch(() => {
    console.error("Atlas runtime database permission contract failed.");
    process.exitCode = 1;
  });
}
