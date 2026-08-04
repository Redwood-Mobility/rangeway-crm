import React from "react";
import { useSearchParams } from "react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiRequest, newIdempotencyKey } from "../api/client.js";
import { publishMutationError, publishToast } from "../components/toast.js";
import {
  Badge,
  EmptyState,
  ErrorState,
  PageHeader,
  Panel,
  SkeletonRows,
  formatDateTime,
} from "../components/primitives.js";

interface Connection {
  id: string;
  googleEmail: string;
  scopes: string | string[] | null;
  status: string;
  lastSyncedAt: string | null;
  lastError: string;
  disconnectedAt: string | null;
}

interface Suggestion {
  id: string;
  kind: string;
  summary: string;
  confidence: string;
  extractorVersion: string;
}

const statusTone: Record<string, "positive" | "caution" | "critical" | "neutral"> = {
  connected: "positive",
  expired: "caution",
  error: "critical",
  revoked: "neutral",
};

function scopeList(scopes: string | string[] | null): string[] {
  if (Array.isArray(scopes)) return scopes;
  if (!scopes) return [];
  return scopes.replace(/^\{|\}$/g, "").split(",").filter(Boolean);
}

/** A scope reads better as what it lets Atlas see. */
function scopeLabel(scope: string): string {
  if (scope.includes("gmail")) return "Gmail (read-only)";
  if (scope.includes("drive")) return "Drive metadata (read-only)";
  if (scope.includes("calendar")) return "Calendar (read-only)";
  if (scope === "openid" || scope.includes("email")) return "Identity";
  return scope;
}

export function Workspace() {
  const client = useQueryClient();
  const [params] = useSearchParams();
  const connectResult = params.get("connect");

  const connections = useQuery({
    queryKey: ["workspace", "connections"],
    queryFn: () => apiRequest<{ connections: Connection[] }>("/workspace/connections"),
  });
  const suggestions = useQuery({
    queryKey: ["workspace", "suggestions"],
    queryFn: () => apiRequest<{ suggestions: Suggestion[] }>("/workspace/suggestions"),
  });

  const sync = useMutation({
    mutationFn: (connectionId: string) =>
      apiRequest(`/workspace/connections/${connectionId}/sync`, {
        method: "POST",
        body: {},
        idempotencyKey: newIdempotencyKey("workspace-sync"),
      }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ["workspace"] });
      publishToast("Workspace sync complete.");
    },
    onError: (error) =>
      publishMutationError(error, "Sync failed. You may need to reconnect Google."),
  });

  const disconnect = useMutation({
    mutationFn: (connectionId: string) =>
      apiRequest(`/workspace/connections/${connectionId}`, {
        method: "DELETE",
        body: {},
        idempotencyKey: newIdempotencyKey("workspace-disconnect"),
      }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ["workspace"] });
      publishToast("Google disconnected.");
    },
    onError: (error) => publishMutationError(error, "That connection was not disconnected."),
  });

  if (connections.error) {
    return <ErrorState error={connections.error} onRetry={() => void connections.refetch()} />;
  }

  const active = (connections.data?.connections ?? []).filter(
    (connection) => !connection.disconnectedAt,
  );

  return (
    <>
      <PageHeader
        eyebrow="Settings"
        title="Google Workspace"
        description="Connect your mailbox, Drive and calendar so Atlas can find context. What Atlas indexes stays private to you."
      />

      {connectResult === "ok" ? (
        <p className="meta-row" role="status" style={{ marginBottom: "1rem" }}>
          <Badge tone="positive">Connected</Badge> Google authorization completed.
        </p>
      ) : null}
      {connectResult === "declined" ? (
        <p className="meta-row" role="status" style={{ marginBottom: "1rem" }}>
          <Badge tone="caution">Declined</Badge> You can connect later; nothing was changed.
        </p>
      ) : null}

      <div className="panel-grid">
        <Panel title="Your connection">
          {connections.isPending ? (
            <SkeletonRows rows={2} />
          ) : active.length === 0 ? (
            <EmptyState
              title="Google is not connected"
              description="Atlas will index only what your account can already see, and only you will be able to search it."
              action={
                <a className="button button--primary" href="/api/v2/workspace/google/connect">
                  Connect Google
                </a>
              }
            />
          ) : (
            <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
              {active.map((connection) => (
                <li key={connection.id} style={{ padding: "0.5rem 0" }}>
                  <strong>{connection.googleEmail}</strong>
                  <div className="meta-row" style={{ marginTop: "0.25rem" }}>
                    <Badge tone={statusTone[connection.status] ?? "neutral"}>
                      {connection.status}
                    </Badge>
                    <span>
                      Last synced{" "}
                      {connection.lastSyncedAt ? formatDateTime(connection.lastSyncedAt) : "never"}
                    </span>
                  </div>
                  <div className="meta-row" style={{ marginTop: "0.25rem" }}>
                    {scopeList(connection.scopes).map((scope) => (
                      <span className="chip" key={scope}>
                        {scopeLabel(scope)}
                      </span>
                    ))}
                  </div>
                  {connection.status === "expired" ? (
                    <p className="field-error" style={{ marginTop: "0.375rem" }}>
                      Authorization expired. Reconnect to resume syncing.
                    </p>
                  ) : null}
                  <div style={{ display: "flex", gap: "0.375rem", marginTop: "0.5rem", flexWrap: "wrap" }}>
                    <button
                      type="button"
                      className="button"
                      onClick={() => sync.mutate(connection.id)}
                      disabled={sync.isPending}
                    >
                      {sync.isPending ? "Syncing…" : "Sync now"}
                    </button>
                    <a className="button" href="/api/v2/workspace/google/connect">
                      Reconnect
                    </a>
                    <button
                      type="button"
                      className="button button--danger"
                      onClick={() => disconnect.mutate(connection.id)}
                      disabled={disconnect.isPending}
                    >
                      Disconnect
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Panel>

        <Panel title="What Atlas can see">
          {/*
            Stated plainly rather than buried. This is the screen where someone
            decides whether to connect a personal mailbox.
          */}
          <ul style={{ margin: 0, paddingLeft: "1.1rem", color: "var(--text-secondary)" }}>
            <li>Atlas requests read-only access. It cannot send mail or change files.</li>
            <li>Everything indexed is private to you by default.</li>
            <li>
              Another person — including an organization owner — cannot search your mail, Drive or
              calendar, and neither can their agents.
            </li>
            <li>
              A project sees an item only when you explicitly share that one item into it.
            </li>
            <li>Disconnecting stops all syncing and revokes the stored credential.</li>
          </ul>
        </Panel>

        <Panel title="Suggestions awaiting review">
          {suggestions.isPending ? (
            <SkeletonRows rows={2} />
          ) : (suggestions.data?.suggestions ?? []).length === 0 ? (
            <EmptyState
              title="Nothing to review"
              description="Commitments and actions extracted from your mail appear here. They never change project facts on their own."
            />
          ) : (
            <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
              {suggestions.data?.suggestions.map((suggestion) => (
                <li
                  key={suggestion.id}
                  style={{ padding: "0.5rem 0", borderBottom: "1px solid var(--border-subtle)" }}
                >
                  <div>{suggestion.summary}</div>
                  <div className="meta-row" style={{ marginTop: "0.25rem" }}>
                    <Badge tone="neutral">{suggestion.kind}</Badge>
                    <span className="mono">
                      confidence {Number(suggestion.confidence).toFixed(2)}
                    </span>
                    <span className="mono">{suggestion.extractorVersion}</span>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </div>
    </>
  );
}
