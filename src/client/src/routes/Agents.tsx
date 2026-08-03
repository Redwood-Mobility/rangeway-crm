import React, { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiRequest, newIdempotencyKey } from "../api/client.js";
import { useMe } from "../api/queries.js";
import { publishMutationError, publishToast } from "../components/toast.js";
import {
  Badge,
  Dialog,
  EmptyState,
  ErrorState,
  Field,
  PageHeader,
  Panel,
  SkeletonRows,
  formatDateTime,
} from "../components/primitives.js";

interface AgentRow {
  actorId: string;
  displayName: string;
  type: string;
  credentialId: string | null;
  serviceKeyPrefix: string | null;
  scopes: string | string[] | null;
  externalDeliveryAuthorized: boolean | null;
  expiresAt: string | null;
  rotatedAt: string | null;
  credentialDisabledAt: string | null;
}

interface Approval {
  id: string;
  operation: string;
  reason: string;
  state: string;
  requestedByDisplayName: string;
  decisionRationale: string;
  createdAt: string;
}

interface Invocation {
  id: string;
  actorDisplayName: string;
  operation: string;
  outcome: string;
  detail: string;
  taskSource: string | null;
  createdAt: string;
}

function scopeList(scopes: string | string[] | null): string[] {
  if (Array.isArray(scopes)) return scopes;
  if (!scopes) return [];
  return scopes.replace(/^\{|\}$/g, "").split(",").filter(Boolean);
}

const outcomeTone: Record<string, "positive" | "critical" | "caution" | "neutral"> = {
  succeeded: "positive",
  rejected: "critical",
  failed: "critical",
  awaiting_approval: "caution",
};

/**
 * Administration only. A member sees the same safe not-found the API returns,
 * because the server refuses these reads outright.
 */
export function Agents() {
  const { data: me } = useMe();
  const client = useQueryClient();
  const [revealed, setRevealed] = useState<string | null>(null);

  const agents = useQuery({
    queryKey: ["agents"],
    queryFn: () => apiRequest<{ agents: AgentRow[] }>("/agents"),
  });
  const approvals = useQuery({
    queryKey: ["agents", "approvals"],
    queryFn: () => apiRequest<{ approvals: Approval[] }>("/agents/approvals"),
  });
  const invocations = useQuery({
    queryKey: ["agents", "invocations"],
    queryFn: () => apiRequest<{ invocations: Invocation[] }>("/agents/invocations"),
  });

  const rotate = useMutation({
    mutationFn: (credentialId: string) =>
      apiRequest<{ serviceKey: string }>(`/agents/credentials/${credentialId}/rotate`, {
        method: "POST",
        body: {},
        idempotencyKey: newIdempotencyKey("credential-rotate"),
      }),
    onSuccess: (result) => {
      setRevealed(result.serviceKey);
      void client.invalidateQueries({ queryKey: ["agents"] });
    },
    onError: (error) => publishMutationError(error, "That credential was not rotated."),
  });

  const disable = useMutation({
    mutationFn: (credentialId: string) =>
      apiRequest(`/agents/credentials/${credentialId}`, {
        method: "DELETE",
        body: {},
        idempotencyKey: newIdempotencyKey("credential-disable"),
      }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ["agents"] });
      publishToast("Credential disabled.");
    },
    onError: (error) => publishMutationError(error, "That credential was not disabled."),
  });

  const decide = useMutation({
    mutationFn: (input: { approvalId: string; state: "approved" | "rejected" }) =>
      apiRequest(`/agents/approvals/${input.approvalId}`, {
        method: "POST",
        body: { state: input.state, rationale: "" },
        idempotencyKey: newIdempotencyKey("approval-decide"),
      }),
    onSuccess: (_result, input) => {
      void client.invalidateQueries({ queryKey: ["agents"] });
      publishToast(`Request ${input.state}.`);
    },
    onError: (error) => publishMutationError(error, "That decision was not recorded."),
  });

  if (agents.error) return <ErrorState error={agents.error} onRetry={() => void agents.refetch()} />;

  const pending = (approvals.data?.approvals ?? []).filter((approval) => approval.state === "pending");

  return (
    <>
      <PageHeader
        eyebrow="Settings"
        title="Agents"
        description="Service identities, their authority, and everything they have attempted."
      />

      {me?.actor.role === "owner" || me?.actor.role === "admin" ? null : (
        <p className="meta-row" style={{ marginBottom: "1rem" }}>
          Agent administration requires an organization owner or administrator.
        </p>
      )}

      <div className="panel-grid" style={{ marginBottom: "var(--section-gap)" }}>
        <Panel title="Approvals needed">
          {approvals.isPending ? (
            <SkeletonRows rows={2} />
          ) : pending.length === 0 ? (
            <EmptyState
              title="Nothing awaiting a decision"
              description="Destructive, credential-changing and unrequested external actions arrive here."
            />
          ) : (
            <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
              {pending.map((approval) => (
                <li key={approval.id} style={{ padding: "0.5rem 0", borderBottom: "1px solid var(--border-subtle)" }}>
                  <strong>{approval.requestedByDisplayName}</strong> requested{" "}
                  <span className="mono">{approval.operation}</span>
                  <div className="meta-row" style={{ marginTop: "0.25rem" }}>
                    <Badge tone="caution">{approval.reason.replaceAll("_", " ")}</Badge>
                    <time className="mono">{formatDateTime(approval.createdAt)}</time>
                  </div>
                  <div style={{ display: "flex", gap: "0.375rem", marginTop: "0.5rem" }}>
                    <button
                      type="button"
                      className="button button--primary"
                      onClick={() => decide.mutate({ approvalId: approval.id, state: "approved" })}
                      disabled={decide.isPending}
                    >
                      Approve
                    </button>
                    <button
                      type="button"
                      className="button button--danger"
                      onClick={() => decide.mutate({ approvalId: approval.id, state: "rejected" })}
                      disabled={decide.isPending}
                    >
                      Reject
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Panel>

        <Panel title="Service identities">
          {agents.isPending ? (
            <SkeletonRows rows={3} />
          ) : (agents.data?.agents ?? []).length === 0 ? (
            <EmptyState title="No agents yet" description="Claude, Codex, Hermes and automations appear here once created." />
          ) : (
            <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
              {agents.data?.agents.map((agent) => (
                <li
                  key={`${agent.actorId}-${agent.credentialId ?? "none"}`}
                  style={{ padding: "0.5rem 0", borderBottom: "1px solid var(--border-subtle)" }}
                >
                  <strong>{agent.displayName}</strong>
                  <div className="meta-row" style={{ marginTop: "0.25rem" }}>
                    <Badge tone={agent.credentialDisabledAt ? "critical" : "positive"}>
                      {agent.credentialDisabledAt ? "Disabled" : agent.credentialId ? "Active" : "No credential"}
                    </Badge>
                    {agent.serviceKeyPrefix ? (
                      <span className="mono">atlas_{agent.serviceKeyPrefix}…</span>
                    ) : null}
                    {agent.externalDeliveryAuthorized ? (
                      <Badge tone="caution">External delivery</Badge>
                    ) : null}
                  </div>
                  <div className="meta-row" style={{ marginTop: "0.25rem" }}>
                    {scopeList(agent.scopes).map((scope) => (
                      <span className="chip" key={scope}>
                        {scope}
                      </span>
                    ))}
                  </div>
                  {agent.credentialId && !agent.credentialDisabledAt ? (
                    <div style={{ display: "flex", gap: "0.375rem", marginTop: "0.5rem" }}>
                      <button
                        type="button"
                        className="button"
                        onClick={() => rotate.mutate(agent.credentialId!)}
                        disabled={rotate.isPending}
                      >
                        Rotate key
                      </button>
                      <button
                        type="button"
                        className="button button--danger"
                        onClick={() => disable.mutate(agent.credentialId!)}
                        disabled={disable.isPending}
                      >
                        Disable
                      </button>
                    </div>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </div>

      <Panel title="Agent activity">
        {invocations.isPending ? (
          <SkeletonRows rows={4} />
        ) : (invocations.data?.invocations ?? []).length === 0 ? (
          <EmptyState title="No agent activity recorded" />
        ) : (
          <div className="table-scroll">
            <table className="data-table">
              <caption className="visually-hidden">Every attempted agent operation</caption>
              <thead>
                <tr>
                  <th scope="col">Agent</th>
                  <th scope="col">Operation</th>
                  <th scope="col">Outcome</th>
                  <th scope="col">Task source</th>
                  <th scope="col">When</th>
                </tr>
              </thead>
              <tbody>
                {invocations.data?.invocations.map((invocation) => (
                  <tr key={invocation.id}>
                    <td>{invocation.actorDisplayName}</td>
                    <td className="mono">{invocation.operation}</td>
                    <td>
                      <Badge tone={outcomeTone[invocation.outcome] ?? "neutral"}>
                        {invocation.outcome.replaceAll("_", " ")}
                      </Badge>
                    </td>
                    <td className="wrap">{invocation.taskSource ?? "—"}</td>
                    <td>
                      <time className="mono">{formatDateTime(invocation.createdAt)}</time>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      {revealed ? (
        <Dialog title="New service key" onClose={() => setRevealed(null)}>
          {/* Shown once. Atlas stores only a hash and cannot show it again. */}
          <p>
            Copy this now. Atlas stores only a hash of it and cannot show it again. The agent keeps
            the same identity, so its history is unbroken.
          </p>
          <Field label="Service key" htmlFor="revealed-key">
            <input id="revealed-key" className="input mono" readOnly value={revealed} />
          </Field>
        </Dialog>
      ) : null}
    </>
  );
}
