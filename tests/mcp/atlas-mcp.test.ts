import { describe, expect, it } from "vitest";
import { AtlasMcpClient, atlasMcpTools } from "../../src/mcp/atlas-mcp.js";

function recordingFetch(status = 200, body: unknown = { ok: true }) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const implementation = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return { calls, implementation };
}

const client = (fetchImplementation: typeof fetch) =>
  new AtlasMcpClient({
    baseUrl: "https://atlas.rangeway.app",
    serviceKey: "atlas_abcdefghijkl.secret",
    fetchImplementation,
  });

describe("Atlas MCP server", () => {
  it("exposes the initial capability set", () => {
    expect(atlasMcpTools.map((tool) => tool.name).sort()).toEqual([
      "atlas_add_activity",
      "atlas_blocked_or_overdue_work",
      "atlas_create_work_item",
      "atlas_get_report",
      "atlas_link_evidence",
      "atlas_move_work_item",
      "atlas_prepare_report",
      "atlas_project_context",
      "atlas_propose_decision",
      "atlas_pursuit_readiness",
      "atlas_render_report",
      "atlas_search",
      "atlas_today",
      "atlas_update_project_health",
      "atlas_update_work_item",
    ]);
    for (const tool of atlasMcpTools) {
      expect(tool.description.length).toBeGreaterThan(10);
      expect(tool.inputSchema.type).toBe("object");
    }
  });

  it("refuses to start without an Atlas service key", () => {
    expect(
      () =>
        new AtlasMcpClient({
          baseUrl: "https://atlas.rangeway.app",
          serviceKey: "postgres://atlas:atlas@db:5432/atlas",
        }),
    ).toThrow(/service key/i);
  });

  it("calls the versioned API and never holds database credentials", async () => {
    const { calls, implementation } = recordingFetch();
    await client(implementation).call("atlas_search", { query: "Mojave" });

    expect(calls[0].url).toBe("https://atlas.rangeway.app/api/v2/search?q=Mojave");
    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer atlas_abcdefghijkl.secret");

    // Nothing in the client can reach a database directly.
    const source = JSON.stringify(calls);
    expect(source).not.toMatch(/postgres:\/\//);
  });

  it("sends an idempotency key on every mutation and none on reads", async () => {
    const { calls, implementation } = recordingFetch(201);
    const mcp = client(implementation);

    await mcp.call("atlas_create_work_item", { projectId: "p", title: "Confirm site control" });
    await mcp.call("atlas_today", {});

    const mutationHeaders = calls[0].init.headers as Record<string, string>;
    const readHeaders = calls[1].init.headers as Record<string, string>;
    expect(mutationHeaders["Idempotency-Key"]).toMatch(/^mcp-atlas_create_work_item-/);
    expect(readHeaders["Idempotency-Key"]).toBeUndefined();
    expect(calls[0].init.method).toBe("POST");
    expect(calls[1].init.method).toBe("GET");
  });

  it("proposes decisions rather than recording final ones", async () => {
    const { calls, implementation } = recordingFetch(201);
    await client(implementation).call("atlas_propose_decision", {
      projectId: "p",
      question: "Which utility path?",
      outcome: "Path A",
    });
    const body = JSON.parse(String(calls[0].init.body));
    expect(body.state).toBe("proposed");
  });

  it("surfaces an API refusal rather than retrying around it", async () => {
    const { implementation } = recordingFetch(403, {
      error: { code: "FORBIDDEN", message: "scope_not_granted" },
    });
    const result = await client(implementation).call("atlas_move_work_item", {
      workItemId: "w",
      status: "done",
    });
    expect(result).toMatchObject({ ok: false, status: 403 });
    expect(result.body).toMatchObject({ error: { code: "FORBIDDEN" } });
  });

  it("rejects an unknown tool without calling the API", async () => {
    const { calls, implementation } = recordingFetch();
    const result = await client(implementation).call("atlas_drop_database", {});
    expect(result.status).toBe(404);
    expect(calls).toHaveLength(0);
  });
});
