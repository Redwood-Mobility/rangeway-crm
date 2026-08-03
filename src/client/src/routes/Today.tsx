import React from "react";
import { Link } from "react-router";
import { useMe, useToday } from "../api/queries.js";
import type { WorkItem } from "../api/types.js";
import {
  EmptyState,
  ErrorState,
  PageHeader,
  Panel,
  PriorityBadge,
  SkeletonRows,
  StatusBadge,
  formatDate,
  formatDateTime,
  relativeDueLabel,
} from "../components/primitives.js";

function WorkLine({ item }: { item: WorkItem }) {
  const due = relativeDueLabel(item.dueAt);
  return (
    <li style={{ padding: "0.5rem 0", borderBottom: "1px solid var(--border-subtle)" }}>
      <Link
        to={`/work?selected=${item.id}`}
        style={{ color: "inherit", textDecoration: "none", fontWeight: 500 }}
      >
        {item.title}
      </Link>
      <div className="meta-row" style={{ marginTop: "0.25rem" }}>
        <StatusBadge status={item.status} />
        <PriorityBadge priority={item.priority} />
        <span style={{ color: due.overdue ? "var(--status-critical-fg)" : undefined }}>
          {due.label}
        </span>
        <Link to={`/projects/${item.projectId}`}>Open project</Link>
      </div>
    </li>
  );
}

export function Today() {
  const { data: me } = useMe();
  const { data, isPending, error, refetch, dataUpdatedAt } = useToday();

  if (error) return <ErrorState error={error} onRetry={() => void refetch()} />;

  const overdue = (data?.workItems ?? []).filter(
    (item) => item.dueAt && new Date(item.dueAt).getTime() < Date.now(),
  );
  const waiting = (data?.workItems ?? []).filter((item) => item.status === "waiting");
  const active = (data?.workItems ?? []).filter(
    (item) => item.status !== "waiting" && !overdue.includes(item),
  );

  return (
    <>
      <PageHeader
        eyebrow={data?.date ?? "Today"}
        title={me?.actor ? `Good day, ${me.actor.actorName.split(" ")[0]}` : "Today"}
        description="What needs your attention now, assembled from the work, decisions and health changes you can see."
        actions={
          <Link className="button button--primary" to="/work?compose=1">
            Quick capture
          </Link>
        }
      />

      {/*
        Generated-at and source window are stated plainly. A briefing that hides
        when it was assembled invites decisions on stale data.
      */}
      <p className="meta-row" style={{ marginBottom: "1rem" }}>
        <span>
          Generated <time className="mono">{formatDateTime(new Date(dataUpdatedAt).toISOString())}</time>
        </span>
        <span>· Source window: open work assigned to you, proposed decisions, and the last 7 days of health changes</span>
      </p>

      {isPending ? (
        <SkeletonRows rows={6} />
      ) : (
        <div className="panel-grid">
          <Panel title="Overdue">
            {overdue.length === 0 ? (
              <EmptyState title="Nothing overdue" description="Every dated item you own is still ahead of its due date." />
            ) : (
              <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
                {overdue.map((item) => (
                  <WorkLine key={item.id} item={item} />
                ))}
              </ul>
            )}
          </Panel>

          <Panel title="Your next actions">
            {active.length === 0 ? (
              <EmptyState
                title="No open work assigned to you"
                description="Work you own in Next, In Progress or Waiting appears here."
              />
            ) : (
              <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
                {active.map((item) => (
                  <WorkLine key={item.id} item={item} />
                ))}
              </ul>
            )}
          </Panel>

          <Panel title="Waiting on others">
            {waiting.length === 0 ? (
              <EmptyState title="Nothing waiting" />
            ) : (
              <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
                {waiting.map((item) => (
                  <WorkLine key={item.id} item={item} />
                ))}
              </ul>
            )}
          </Panel>

          <Panel title="Decisions needed">
            {(data?.decisionsNeeded ?? []).length === 0 ? (
              <EmptyState title="No decisions awaiting you" />
            ) : (
              <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
                {data?.decisionsNeeded.map((decision) => (
                  <li key={decision.id} style={{ padding: "0.5rem 0", borderBottom: "1px solid var(--border-subtle)" }}>
                    <div style={{ fontWeight: 500 }}>{decision.question}</div>
                    <div className="meta-row" style={{ marginTop: "0.25rem" }}>
                      <span className="badge badge--caution">Proposed</span>
                      <Link to={`/projects/${decision.primaryProjectId}/decisions`}>Open project</Link>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </Panel>

          <Panel title="Health changes">
            {(data?.healthChanges ?? []).length === 0 ? (
              <EmptyState title="No health changes in the last 7 days" />
            ) : (
              <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
                {data?.healthChanges.map((update) => (
                  <li key={update.id} style={{ padding: "0.5rem 0", borderBottom: "1px solid var(--border-subtle)" }}>
                    <div className="meta-row">
                      <Link to={`/projects/${update.projectId}`}>Project</Link>
                      <span>·</span>
                      <time className="mono">{formatDate(update.createdAt)}</time>
                    </div>
                    <div style={{ marginTop: "0.25rem" }}>{update.rationale}</div>
                  </li>
                ))}
              </ul>
            )}
          </Panel>

          <Panel title="Upcoming milestones">
            {(data?.upcomingMilestones ?? []).length === 0 ? (
              <EmptyState title="No milestones in the next 31 days" />
            ) : (
              <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
                {data?.upcomingMilestones.map((milestone) => (
                  <li key={milestone.id} style={{ padding: "0.5rem 0", borderBottom: "1px solid var(--border-subtle)" }}>
                    <div style={{ fontWeight: 500 }}>{milestone.outcome}</div>
                    <div className="meta-row" style={{ marginTop: "0.25rem" }}>
                      <time className="mono">{formatDate(milestone.targetAt)}</time>
                      <Link to={`/projects/${milestone.projectId}/milestones`}>Open project</Link>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </Panel>

          <Panel title="Agent activity">
            {(data?.agentActivity ?? []).length === 0 ? (
              <EmptyState
                title="No agent activity"
                description="Work performed by Claude, Codex, Hermes or an automation appears here with full attribution."
              />
            ) : (
              <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
                {data?.agentActivity.map((entry) => (
                  <li key={entry.id} style={{ padding: "0.5rem 0", borderBottom: "1px solid var(--border-subtle)" }}>
                    <div>{entry.summary}</div>
                    <div className="meta-row" style={{ marginTop: "0.25rem" }}>
                      <time className="mono">{formatDateTime(entry.occurredAt)}</time>
                      <Link to={`/projects/${entry.projectId}/activity`}>Open project</Link>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </Panel>
        </div>
      )}
    </>
  );
}
