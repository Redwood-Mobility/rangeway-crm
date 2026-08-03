/**
 * The Atlas MCP server.
 *
 * It holds a service key and speaks to the versioned HTTP API. It is given no
 * database credentials and no direct database access, so every scope, guarded
 * operation and attribution rule enforced by the API applies to it unchanged.
 */

export interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, { type: string; description: string }>;
    required?: string[];
  };
}

export interface McpCallResult {
  ok: boolean;
  status: number;
  body: unknown;
}

interface ToolBinding {
  method: "GET" | "POST" | "PATCH" | "DELETE";
  /** Builds the path from the call arguments. */
  path: (input: Record<string, unknown>) => string;
  /** Query parameters for GET calls. */
  query?: (input: Record<string, unknown>) => Record<string, string>;
  /** Body for mutations. */
  body?: (input: Record<string, unknown>) => Record<string, unknown>;
  mutation?: boolean;
}

const bindings: Record<string, ToolBinding> = {
  atlas_search: {
    method: "GET",
    path: () => "/search",
    query: (input) => ({
      q: String(input.query ?? ""),
      ...(input.types ? { types: String(input.types) } : {}),
    }),
  },
  atlas_today: {
    method: "GET",
    path: () => "/today",
    query: (input) => (input.date ? { date: String(input.date) } : {}),
  },
  atlas_project_context: {
    method: "GET",
    path: (input) => `/projects/${String(input.projectId)}/context-bundle`,
  },
  atlas_blocked_or_overdue_work: {
    method: "GET",
    path: () => "/work-items",
    query: (input) => ({
      ...(input.projectId ? { projectId: String(input.projectId) } : {}),
      status: "waiting",
      limit: "100",
    }),
  },
  atlas_create_work_item: {
    method: "POST",
    path: () => "/work-items",
    mutation: true,
    body: (input) => ({
      projectId: input.projectId,
      title: input.title,
      type: input.type ?? "action",
      status: input.status ?? "next",
      priority: input.priority ?? "medium",
      description: input.description ?? "",
      position: 1000,
      labelIds: [],
    }),
  },
  atlas_update_work_item: {
    method: "PATCH",
    path: (input) => `/work-items/${String(input.workItemId)}`,
    mutation: true,
    body: (input) => {
      const patch: Record<string, unknown> = {};
      for (const field of ["title", "description", "priority", "dueAt", "ownerUserId"]) {
        if (input[field] !== undefined) patch[field] = input[field];
      }
      return patch;
    },
  },
  atlas_move_work_item: {
    method: "POST",
    path: (input) => `/work-items/${String(input.workItemId)}/move`,
    mutation: true,
    body: (input) => ({ status: input.status, position: Number(input.position ?? 1000) }),
  },
  atlas_add_activity: {
    method: "POST",
    path: () => "/activities",
    mutation: true,
    body: (input) => ({
      projectId: input.projectId,
      summary: input.summary,
      occurredAt: input.occurredAt ?? new Date().toISOString(),
    }),
  },
  atlas_propose_decision: {
    method: "POST",
    path: () => "/decisions",
    mutation: true,
    body: (input) => ({
      primaryProjectId: input.projectId,
      question: input.question,
      // An agent proposes; it does not record a final decision.
      state: "proposed",
      outcome: input.outcome ?? "",
      rationale: input.rationale ?? "",
    }),
  },
  atlas_link_evidence: {
    method: "POST",
    path: () => "/evidence",
    mutation: true,
    body: (input) => ({
      artifactId: input.artifactId,
      targetType: input.targetType,
      targetId: input.targetId,
      claim: input.claim ?? "",
    }),
  },
  atlas_update_project_health: {
    method: "POST",
    path: (input) => `/projects/${String(input.projectId)}/health-updates`,
    mutation: true,
    body: (input) => ({ health: input.health, rationale: input.rationale }),
  },
  atlas_pursuit_readiness: {
    method: "GET",
    path: (input) => `/projects/${String(input.projectId)}/pursuit`,
  },
  atlas_prepare_report: {
    method: "POST",
    path: () => "/reports",
    mutation: true,
    body: (input) => ({
      projectId: input.projectId ?? undefined,
      templateKey: input.templateKey,
      audienceRole: input.audienceRole,
      sourceCutoff: input.sourceCutoff ?? new Date().toISOString(),
    }),
  },
  atlas_render_report: {
    method: "POST",
    path: (input) => `/reports/${String(input.reportId)}/render`,
    mutation: true,
    body: () => ({}),
  },
  atlas_get_report: {
    method: "GET",
    path: (input) => `/reports/${String(input.reportId)}`,
  },
};

export const atlasMcpTools: McpToolDefinition[] = [
  {
    name: "atlas_search",
    description: "Search Atlas projects, work, people and organizations you are authorized to see.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search text, at least two characters." },
        types: { type: "string", description: "Optional comma-separated record types." },
      },
      required: ["query"],
    },
  },
  {
    name: "atlas_today",
    description: "Retrieve the Today briefing for the delegating user.",
    inputSchema: {
      type: "object",
      properties: { date: { type: "string", description: "Optional ISO date." } },
    },
  },
  {
    name: "atlas_project_context",
    description: "Retrieve a complete Project Room context bundle.",
    inputSchema: {
      type: "object",
      properties: { projectId: { type: "string", description: "Project identifier." } },
      required: ["projectId"],
    },
  },
  {
    name: "atlas_blocked_or_overdue_work",
    description: "List work that is waiting or blocked.",
    inputSchema: {
      type: "object",
      properties: { projectId: { type: "string", description: "Optional project filter." } },
    },
  },
  {
    name: "atlas_create_work_item",
    description: "Create a work item in a project.",
    inputSchema: {
      type: "object",
      properties: {
        projectId: { type: "string", description: "Project identifier." },
        title: { type: "string", description: "Work item title." },
        type: { type: "string", description: "action, deliverable, follow_up, approval or research." },
        status: { type: "string", description: "inbox, next, in_progress, waiting, done or canceled." },
        priority: { type: "string", description: "low, medium, high or urgent." },
        description: { type: "string", description: "Optional detail." },
      },
      required: ["projectId", "title"],
    },
  },
  {
    name: "atlas_update_work_item",
    description: "Update fields on a work item.",
    inputSchema: {
      type: "object",
      properties: {
        workItemId: { type: "string", description: "Work item identifier." },
        title: { type: "string", description: "New title." },
        description: { type: "string", description: "New description." },
        priority: { type: "string", description: "New priority." },
        dueAt: { type: "string", description: "New due timestamp." },
      },
      required: ["workItemId"],
    },
  },
  {
    name: "atlas_move_work_item",
    description: "Move a work item to another status. Invalid transitions are refused.",
    inputSchema: {
      type: "object",
      properties: {
        workItemId: { type: "string", description: "Work item identifier." },
        status: { type: "string", description: "Target status." },
        position: { type: "number", description: "Ordering position." },
      },
      required: ["workItemId", "status"],
    },
  },
  {
    name: "atlas_add_activity",
    description: "Record a human-readable activity entry on a project.",
    inputSchema: {
      type: "object",
      properties: {
        projectId: { type: "string", description: "Project identifier." },
        summary: { type: "string", description: "What happened." },
        occurredAt: { type: "string", description: "Optional ISO timestamp." },
      },
      required: ["projectId", "summary"],
    },
  },
  {
    name: "atlas_propose_decision",
    description: "Propose a decision. Agents propose; people finalize.",
    inputSchema: {
      type: "object",
      properties: {
        projectId: { type: "string", description: "Project identifier." },
        question: { type: "string", description: "The decision to be made." },
        outcome: { type: "string", description: "Proposed outcome." },
        rationale: { type: "string", description: "Why." },
      },
      required: ["projectId", "question"],
    },
  },
  {
    name: "atlas_link_evidence",
    description: "Link an artifact as evidence for a requirement, decision, risk or blocker.",
    inputSchema: {
      type: "object",
      properties: {
        artifactId: { type: "string", description: "Artifact identifier." },
        targetType: { type: "string", description: "requirement, decision, risk, blocker or milestone." },
        targetId: { type: "string", description: "Target identifier." },
        claim: { type: "string", description: "What this evidence supports." },
      },
      required: ["artifactId", "targetType", "targetId"],
    },
  },
  {
    name: "atlas_update_project_health",
    description: "Record a project health update with a rationale.",
    inputSchema: {
      type: "object",
      properties: {
        projectId: { type: "string", description: "Project identifier." },
        health: { type: "string", description: "unknown, on_track, at_risk or off_track." },
        rationale: { type: "string", description: "Why the health is what it is." },
      },
      required: ["projectId", "health", "rationale"],
    },
  },
  {
    name: "atlas_pursuit_readiness",
    description: "Retrieve Location Pursuit development-area readiness for a project.",
    inputSchema: {
      type: "object",
      properties: { projectId: { type: "string", description: "Project identifier." } },
      required: ["projectId"],
    },
  },
  {
    name: "atlas_prepare_report",
    description: "Prepare a report snapshot for a project or the portfolio.",
    inputSchema: {
      type: "object",
      properties: {
        projectId: { type: "string", description: "Project identifier, omitted for portfolio reports." },
        templateKey: { type: "string", description: "Report template key." },
        audienceRole: { type: "string", description: "Audience role profile." },
        sourceCutoff: { type: "string", description: "ISO cutoff for source data." },
      },
      required: ["templateKey", "audienceRole"],
    },
  },
  {
    name: "atlas_render_report",
    description: "Render an approved report snapshot to a PDF artifact.",
    inputSchema: {
      type: "object",
      properties: { reportId: { type: "string", description: "Report identifier." } },
      required: ["reportId"],
    },
  },
  {
    name: "atlas_get_report",
    description: "Retrieve a report, its snapshot and its rendered artifact.",
    inputSchema: {
      type: "object",
      properties: { reportId: { type: "string", description: "Report identifier." } },
      required: ["reportId"],
    },
  },
];

export interface McpClientOptions {
  baseUrl: string;
  serviceKey: string;
  fetchImplementation?: typeof fetch;
}

function idempotencyKey(tool: string): string {
  const unique =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return `mcp-${tool}-${unique}`.slice(0, 128);
}

export class AtlasMcpClient {
  private readonly fetchImplementation: typeof fetch;

  constructor(private readonly options: McpClientOptions) {
    this.fetchImplementation = options.fetchImplementation ?? fetch;
    if (!options.serviceKey.startsWith("atlas_")) {
      throw new Error("The Atlas MCP server requires an Atlas service key.");
    }
  }

  listTools(): McpToolDefinition[] {
    return atlasMcpTools;
  }

  async call(tool: string, input: Record<string, unknown> = {}): Promise<McpCallResult> {
    const binding = bindings[tool];
    if (!binding) {
      return { ok: false, status: 404, body: { error: { code: "NOT_FOUND", message: `Unknown tool ${tool}.` } } };
    }

    const search = new URLSearchParams(binding.query?.(input) ?? {});
    const suffix = search.toString() ? `?${search}` : "";
    const headers: Record<string, string> = {
      Accept: "application/json",
      // The service key is the only authority the MCP server holds. Scopes,
      // delegation and guarded-operation checks all happen server-side.
      Authorization: `Bearer ${this.options.serviceKey}`,
    };
    if (binding.mutation) {
      headers["Content-Type"] = "application/json";
      headers["Idempotency-Key"] = idempotencyKey(tool);
    }

    const response = await this.fetchImplementation(
      `${this.options.baseUrl}/api/v2${binding.path(input)}${suffix}`,
      {
        method: binding.method,
        headers,
        body: binding.mutation ? JSON.stringify(binding.body?.(input) ?? {}) : undefined,
      },
    );

    let body: unknown = null;
    try {
      body = await response.json();
    } catch {
      body = null;
    }
    return { ok: response.ok, status: response.status, body };
  }
}
