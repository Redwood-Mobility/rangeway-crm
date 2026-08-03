import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = path.resolve(import.meta.dirname, "../..");

function read(relativePath: string): string {
  try {
    return readFileSync(path.join(root, relativePath), "utf8");
  } catch {
    return "";
  }
}

describe("Operating Core additive PostgreSQL migrations", () => {
  it("preserves the immutable platform migrations byte-for-byte", () => {
    const expected = new Map([
      ["0001_platform.sql", "73b91f8487afe9e34fd07ee7d4521ca3d559d1e6727225739e932f0a5ca20ef2"],
      ["0002_api_idempotency.sql", "659ffd93d0e7e9dbc853f3284f6bbb8e8a0e9a809d63e6971708a0e57e07cab9"],
      ["0003_database_security.sql", "fefdfd3f694d4ecb180734a6299c7cfdca06a884ffdb95613bbbc461a20bc489"],
      ["0004_worker_outbox_permissions.sql", "1ae5381b8f1cb93dafe1517213a991b24cdc7bf2f73863acd34eab703b2d1af5"],
      ["0005_exact_runtime_permissions.sql", "c6cca53b905a5a628e4af9772b2207a6517aa64ae5347ccbe434f0c201398751"],
      ["0006_exact_database_schema_privileges.sql", "6b34489c3a6963bef9cb99acdd315f25c5855e3a541a612611a56697fd654028"],
    ]);

    for (const [filename, checksum] of expected) {
      expect(createHash("sha256").update(read(`db/migrations/${filename}`)).digest("hex")).toBe(checksum);
    }
  });

  it("adds every Operating Core relation with organization-first indexes", () => {
    const schema = read("db/migrations/0007_operating_core.sql");
    for (const relation of [
      "project_rooms",
      "project_memberships",
      "project_health_updates",
      "workstreams",
      "work_items",
      "work_item_dependencies",
      "labels",
      "work_item_labels",
      "decisions",
      "decision_projects",
      "risks",
      "blockers",
      "milestones",
      "activities",
      "people",
      "counterparty_organizations",
      "person_organization_affiliations",
      "project_people",
      "project_counterparties",
      "saved_views",
    ]) {
      expect(schema).toContain(`CREATE TABLE ${relation}`);
      expect(schema).toMatch(new RegExp(`CREATE (?:UNIQUE )?INDEX [^\\n]+\\n  ON ${relation} \\(organization_id`));
    }
    expect(schema).toContain("work_item_type AS ENUM ('action', 'deliverable', 'follow_up', 'approval', 'research')");
    expect(schema).toContain("work_item_status AS ENUM ('inbox', 'next', 'in_progress', 'waiting', 'done', 'canceled')");
  });

  it("grants the web role only the Operating Core privileges it needs", () => {
    const permissions = read("db/migrations/0008_operating_core_permissions.sql");
    expect(permissions).toContain("REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM atlas_web");
    expect(permissions).toContain("GRANT SELECT ON");
    expect(permissions).toContain("GRANT INSERT ON");
    expect(permissions).toContain("TO atlas_web");
    expect(permissions).not.toMatch(/GRANT\s+ALL/i);
    const workerGrants = permissions.split(
      "REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM atlas_worker",
    )[1];
    expect(workerGrants).not.toMatch(/GRANT\s+(?:INSERT|DELETE)\s+ON[\s\S]*TO atlas_worker/i);
    expect(workerGrants).not.toMatch(/GRANT\s+UPDATE\s+ON[\s\S]*TO atlas_worker/i);
  });
});
