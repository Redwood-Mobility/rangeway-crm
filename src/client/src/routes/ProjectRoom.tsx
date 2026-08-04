import React, { useState, type FormEvent } from "react";
import { Link, NavLink, useParams } from "react-router";
import { Pencil } from "lucide-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Gates } from "./Gates.js";
import { apiRequest, newIdempotencyKey } from "../api/client.js";
import { publishMutationError, publishToast } from "../components/toast.js";
import { useAddHealthUpdate, useProjectContext, useUpdateProject } from "../api/queries.js";
import {
  boardLanes,
  projectHealthValues,
  projectStatusLabels,
  workItemStatusLabels,
  type ProjectHealth,
  type ProjectStatus,
} from "../api/types.js";
import {
  Badge,
  Dialog,
  EmptyState,
  ErrorState,
  Field,
  HealthBadge,
  PageHeader,
  Panel,
  PriorityBadge,
  SkeletonRows,
  StatusBadge,
  VisibilityChip,
  formatDate,
  formatDateTime,
} from "../components/primitives.js";

const tabs = [
  { key: "overview", label: "Overview" },
  { key: "work", label: "Work" },
  { key: "milestones", label: "Milestones" },
  { key: "gates", label: "Gates" },
  { key: "stakeholders", label: "Stakeholders" },
  { key: "decisions", label: "Decisions & Risks" },
  { key: "context", label: "Shared context" },
  { key: "activity", label: "Activity" },
];

interface WorkspaceShare {
  id: string;
  sourceKind: string;
  title: string;
  summary: string;
  occurredAt: string | null;
  ownerDisplayName: string;
}

const shareKindLabel: Record<string, string> = {
  gmail_thread: "Mail",
  drive_item: "Drive",
  calendar_event: "Calendar",
};

/**
 * Mail, files and meetings someone deliberately shared into this project.
 *
 * Nothing arrives here by indexing alone — a Workspace connection stays private
 * until its owner shares a specific item.
 */
function SharedContext({ projectId }: { projectId: string | undefined }) {
  const client = useQueryClient();
  const shares = useQuery({
    queryKey: ["project", projectId, "workspace-shares"],
    queryFn: () =>
      apiRequest<{ shares: WorkspaceShare[] }>(`/projects/${projectId}/workspace-shares`),
    enabled: Boolean(projectId),
  });

  const revoke = useMutation({
    mutationFn: (shareId: string) =>
      apiRequest(`/workspace-shares/${shareId}`, {
        method: "DELETE",
        body: {},
        idempotencyKey: newIdempotencyKey("workspace-share-revoke"),
      }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ["project", projectId, "workspace-shares"] });
      publishToast("Removed from this project.");
    },
    onError: (error) => publishMutationError(error, "That item was not removed."),
  });

  if (shares.error) {
    return <ErrorState error={shares.error} onRetry={() => void shares.refetch()} />;
  }

  return (
    <Panel title="Shared from Google Workspace">
      {shares.isPending ? (
        <SkeletonRows rows={3} />
      ) : (shares.data?.shares ?? []).length === 0 ? (
        <EmptyState
          title="Nothing shared yet"
          description="Find mail, a file or a meeting under Workspace and share it into this project. Connected mailboxes stay private until someone does."
        />
      ) : (
        <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
          {shares.data?.shares.map((share) => (
            <li
              key={share.id}
              style={{ padding: "0.625rem 0", borderBottom: "1px solid var(--border-subtle)" }}
            >
              <div style={{ fontWeight: 600 }}>{share.title || "Untitled"}</div>
              {share.summary ? (
                <div style={{ color: "var(--text-secondary)" }}>{share.summary}</div>
              ) : null}
              <div className="meta-row" style={{ marginTop: "0.25rem" }}>
                <Badge tone="neutral">{shareKindLabel[share.sourceKind] ?? share.sourceKind}</Badge>
                <span>Shared by {share.ownerDisplayName}</span>
                {share.occurredAt ? <span>{formatDateTime(share.occurredAt)}</span> : null}
                <button
                  type="button"
                  className="button button--quiet"
                  onClick={() => revoke.mutate(share.id)}
                  disabled={revoke.isPending}
                >
                  Remove
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

export function ProjectRoom() {
  const { projectId, tab = "overview" } = useParams();
  const { data, isPending, error, refetch } = useProjectContext(projectId);
  const [editing, setEditing] = useState(false);
  const [reportingHealth, setReportingHealth] = useState(false);

  if (error) return <ErrorState error={error} onRetry={() => void refetch()} />;
  if (isPending) return <SkeletonRows rows={8} />;

  const { project, sections } = data;

  return (
    <>
      <PageHeader
        eyebrow={project.templateType === "location_pursuit" ? "Location Pursuit" : "Project Room"}
        title={project.name}
        description={project.objective || undefined}
        actions={
          <>
            <HealthBadge health={project.health as ProjectHealth} />
            <Badge tone="neutral">{projectStatusLabels[project.status as ProjectStatus]}</Badge>
            <button type="button" className="button" onClick={() => setReportingHealth(true)}>
              Report health
            </button>
            <button type="button" className="button" onClick={() => setEditing(true)}>
              <Pencil aria-hidden="true" />
              Edit
            </button>
          </>
        }
      />

      {editing ? <EditProjectDialog project={project} onClose={() => setEditing(false)} /> : null}
      {reportingHealth ? (
        <HealthDialog project={project} onClose={() => setReportingHealth(false)} />
      ) : null}

      {/* The four operating questions every active project must answer. */}
      <div className="panel" style={{ marginBottom: "var(--section-gap)" }}>
        <div className="panel__body">
          <dl className="definition-grid">
            <div>
              <dt>Current focus</dt>
              <dd>{project.currentFocus || "Not stated"}</dd>
            </div>
            <div>
              <dt>Blocker</dt>
              <dd>{project.blockerSummary || "None recorded"}</dd>
            </div>
            <div>
              <dt>Next decision</dt>
              <dd>{project.nextDecision || "None recorded"}</dd>
            </div>
            <div>
              <dt>Next action</dt>
              <dd>{project.nextAction || "None recorded"}</dd>
            </div>
          </dl>
        </div>
      </div>

      <nav aria-label="Project sections" style={{ display: "flex", flexWrap: "wrap", gap: "0.375rem", marginBottom: "1rem" }}>
        {tabs.map((item) => (
          <NavLink
            key={item.key}
            to={`/projects/${projectId}/${item.key}`}
            className="button"
            style={({ isActive }) =>
              isActive || (item.key === "overview" && tab === "overview")
                ? { background: "var(--surface-selected)", borderColor: "var(--accent-strong)" }
                : {}
            }
          >
            {item.label}
          </NavLink>
        ))}
      </nav>

      {tab === "overview" ? <Overview data={data} /> : null}
      {tab === "work" ? <WorkSection data={data} /> : null}
      {tab === "milestones" ? <Milestones data={data} /> : null}
      {tab === "gates" ? (
        <Gates projectId={project.id} templateType={project.templateType} />
      ) : null}
      {tab === "stakeholders" ? <Stakeholders data={data} /> : null}
      {tab === "decisions" ? <DecisionsAndRisks data={data} /> : null}
      {tab === "context" ? <SharedContext projectId={projectId} /> : null}
      {tab === "activity" ? <Activity data={data} /> : null}

      {Object.values(sections).some((section) => section.truncated) ? (
        <p className="meta-row" style={{ marginTop: "1rem" }}>
          Some sections show the first {data.sectionLimit} records. Open the dedicated view for the
          complete set.
        </p>
      ) : null}
    </>
  );
}

type Context = NonNullable<ReturnType<typeof useProjectContext>["data"]>;

const editableFields = [
  { key: "objective", label: "Objective", multiline: true },
  { key: "currentFocus", label: "Current focus", multiline: true },
  { key: "blockerSummary", label: "Blocker", multiline: true },
  { key: "nextDecision", label: "Next decision", multiline: true },
  { key: "nextAction", label: "Next action", multiline: true },
  { key: "strategicArea", label: "Strategic area", multiline: false },
] as const;

function EditProjectDialog({
  project,
  onClose,
}: {
  project: Context["project"];
  onClose: () => void;
}) {
  const updateProject = useUpdateProject();
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(editableFields.map((field) => [field.key, project[field.key] ?? ""])),
  );
  const [name, setName] = useState(project.name);

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    updateProject.mutate({ projectId: project.id, name, ...values }, { onSuccess: onClose });
  }

  return (
    <Dialog
      title="Edit project"
      wide
      onClose={onClose}
      footer={
        <>
          <button type="button" className="button" onClick={onClose}>
            Cancel
          </button>
          <button
            type="submit"
            form="edit-project"
            className="button button--primary"
            disabled={updateProject.isPending || name.trim().length === 0}
          >
            {updateProject.isPending ? "Saving…" : "Save changes"}
          </button>
        </>
      }
    >
      <form id="edit-project" onSubmit={onSubmit} style={{ display: "contents" }}>
        <Field label="Name" htmlFor="edit-project-name">
          <input
            id="edit-project-name"
            className="input"
            required
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
        </Field>
        {editableFields.map((field) => (
          <Field key={field.key} label={field.label} htmlFor={`edit-${field.key}`}>
            {field.multiline ? (
              <textarea
                id={`edit-${field.key}`}
                className="textarea"
                value={values[field.key]}
                onChange={(event) =>
                  setValues((current) => ({ ...current, [field.key]: event.target.value }))
                }
              />
            ) : (
              <input
                id={`edit-${field.key}`}
                className="input"
                value={values[field.key]}
                onChange={(event) =>
                  setValues((current) => ({ ...current, [field.key]: event.target.value }))
                }
              />
            )}
          </Field>
        ))}
      </form>
    </Dialog>
  );
}

/**
 * Health is reported with a rationale rather than set silently, so every change
 * carries the reasoning behind it into the project history.
 */
function HealthDialog({ project, onClose }: { project: Context["project"]; onClose: () => void }) {
  const addHealth = useAddHealthUpdate();
  const [health, setHealth] = useState<string>(project.health);
  const [rationale, setRationale] = useState("");

  return (
    <Dialog
      title="Report project health"
      onClose={onClose}
      footer={
        <>
          <button type="button" className="button" onClick={onClose}>
            Cancel
          </button>
          <button
            type="submit"
            form="report-health"
            className="button button--primary"
            disabled={addHealth.isPending || rationale.trim().length === 0}
          >
            {addHealth.isPending ? "Recording…" : "Record health"}
          </button>
        </>
      }
    >
      <form
        id="report-health"
        style={{ display: "contents" }}
        onSubmit={(event) => {
          event.preventDefault();
          addHealth.mutate({ projectId: project.id, health, rationale }, { onSuccess: onClose });
        }}
      >
        <Field label="Health" htmlFor="health-value">
          <select
            id="health-value"
            className="select"
            value={health}
            onChange={(event) => setHealth(event.target.value)}
          >
            {projectHealthValues.map((value) => (
              <option key={value} value={value}>
                {value.replace("_", " ")}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Rationale" htmlFor="health-rationale">
          <textarea
            id="health-rationale"
            className="textarea"
            required
            value={rationale}
            onChange={(event) => setRationale(event.target.value)}
          />
        </Field>
      </form>
    </Dialog>
  );
}

function Overview({ data }: { data: Context }) {
  const counts = boardLanes.map((lane) => ({
    lane,
    count: data.workItems.filter((item) => item.status === lane).length,
  }));

  return (
    <div className="panel-grid">
      <Panel title="Work by status">
        <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: "0.5rem" }}>
          {counts.map(({ lane, count }) => (
            <li key={lane} style={{ display: "flex", justifyContent: "space-between", gap: "0.75rem" }}>
              <StatusBadge status={lane} />
              <span className="mono">{count}</span>
            </li>
          ))}
        </ul>
      </Panel>

      <Panel title="Open blockers">
        {data.blockers.filter((blocker) => !blocker.resolvedAt).length === 0 ? (
          <EmptyState title="No open blockers" />
        ) : (
          <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
            {data.blockers
              .filter((blocker) => !blocker.resolvedAt)
              .map((blocker) => (
                <li key={blocker.id} style={{ padding: "0.375rem 0" }}>
                  {blocker.condition}
                </li>
              ))}
          </ul>
        )}
      </Panel>

      <Panel title="Workstreams">
        {data.workstreams.length === 0 ? (
          <EmptyState title="No workstreams yet" />
        ) : (
          <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
            {data.workstreams.map((workstream) => (
              <li key={workstream.id} style={{ padding: "0.375rem 0" }}>
                <strong>{workstream.name}</strong>
                {workstream.description ? (
                  <div style={{ color: "var(--text-muted)", fontSize: "var(--text-sm)" }}>
                    {workstream.description}
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </Panel>

      <Panel title="Recent health">
        {data.healthUpdates.length === 0 ? (
          <EmptyState title="No health updates recorded" />
        ) : (
          <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
            {data.healthUpdates.slice(0, 5).map((update) => (
              <li key={update.id} style={{ padding: "0.375rem 0" }}>
                <div className="meta-row">
                  <HealthBadge health={update.health} />
                  <time className="mono">{formatDate(update.createdAt)}</time>
                </div>
                <div>{update.rationale}</div>
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </div>
  );
}

function WorkSection({ data }: { data: Context }) {
  if (data.workItems.length === 0) {
    return (
      <EmptyState
        title="No work in this project"
        description="Capture work from the Work screen and assign it to this project."
        action={
          <Link className="button button--primary" to={`/work?projectId=${data.project.id}&compose=1`}>
            New work item
          </Link>
        }
      />
    );
  }

  return (
    <>
      <p style={{ marginBottom: "0.75rem" }}>
        <Link to={`/work/board?projectId=${data.project.id}`}>Open this project on the board →</Link>
      </p>
      <div className="board">
        {boardLanes.map((lane) => {
          const laneItems = data.workItems.filter((item) => item.status === lane);
          return (
            <section className="board-lane" key={lane} aria-label={workItemStatusLabels[lane]}>
              <div className="board-lane__header">
                <h2 className="board-lane__title">{workItemStatusLabels[lane]}</h2>
                <span className="board-lane__count">{laneItems.length}</span>
              </div>
              <ul className="board-lane__items">
                {laneItems.map((item) => (
                  <li key={item.id}>
                    <Link
                      to={`/work?selected=${item.id}`}
                      className="work-card"
                      data-priority={item.priority}
                      style={{ textDecoration: "none" }}
                    >
                      <span className="work-card__title">{item.title}</span>
                      <span className="work-card__meta">
                        <PriorityBadge priority={item.priority} />
                        {item.dueAt ? <time className="mono">{formatDate(item.dueAt)}</time> : null}
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            </section>
          );
        })}
      </div>
    </>
  );
}

function Milestones({ data }: { data: Context }) {
  if (data.milestones.length === 0) {
    return <EmptyState title="No milestones" description="Dated outcomes for this project appear here." />;
  }
  return (
    <div className="panel table-scroll">
      <table className="data-table">
        <caption className="visually-hidden">Project milestones</caption>
        <thead>
          <tr>
            <th scope="col">Outcome</th>
            <th scope="col">Target</th>
            <th scope="col">State</th>
          </tr>
        </thead>
        <tbody>
          {data.milestones.map((milestone) => (
            <tr key={milestone.id}>
              <td className="wrap">{milestone.outcome}</td>
              <td>
                <time className="mono">{formatDate(milestone.targetAt)}</time>
              </td>
              <td>
                <Badge tone={milestone.state === "completed" ? "positive" : "neutral"}>
                  {milestone.state}
                </Badge>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Stakeholders({ data }: { data: Context }) {
  return (
    <div className="panel-grid">
      <Panel title="People">
        {data.people.length === 0 ? (
          <EmptyState title="No people linked" />
        ) : (
          <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
            {data.people.map((person) => (
              <li key={person.id} style={{ padding: "0.5rem 0", borderBottom: "1px solid var(--border-subtle)" }}>
                <strong>{person.displayName}</strong>
                <div className="meta-row" style={{ marginTop: "0.25rem" }}>
                  {person.projectRole ? <span>{person.projectRole}</span> : null}
                  <VisibilityChip visibility={person.visibility} />
                </div>
              </li>
            ))}
          </ul>
        )}
      </Panel>
      <Panel title="Organizations">
        {data.counterparties.length === 0 ? (
          <EmptyState title="No organizations linked" />
        ) : (
          <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
            {data.counterparties.map((counterparty) => (
              <li key={counterparty.id} style={{ padding: "0.5rem 0", borderBottom: "1px solid var(--border-subtle)" }}>
                <strong>{counterparty.name}</strong>
                <div className="meta-row" style={{ marginTop: "0.25rem" }}>
                  <span>{counterparty.kind}</span>
                  <VisibilityChip visibility={counterparty.visibility} />
                </div>
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </div>
  );
}

function DecisionsAndRisks({ data }: { data: Context }) {
  return (
    <div className="panel-grid">
      <Panel title="Decisions">
        {data.decisions.length === 0 ? (
          <EmptyState title="No decisions recorded" />
        ) : (
          <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
            {data.decisions.map((decision) => (
              <li key={decision.id} style={{ padding: "0.5rem 0", borderBottom: "1px solid var(--border-subtle)" }}>
                <strong>{decision.question}</strong>
                <div className="meta-row" style={{ marginTop: "0.25rem" }}>
                  <Badge tone={decision.state === "final" ? "positive" : "caution"}>
                    {decision.state}
                  </Badge>
                  {decision.decisionAt ? (
                    <time className="mono">{formatDate(decision.decisionAt)}</time>
                  ) : null}
                </div>
                {decision.outcome ? <p style={{ marginTop: "0.25rem" }}>{decision.outcome}</p> : null}
              </li>
            ))}
          </ul>
        )}
      </Panel>
      <Panel title="Risks">
        {data.risks.length === 0 ? (
          <EmptyState title="No risks recorded" />
        ) : (
          <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
            {data.risks.map((risk) => (
              <li key={risk.id} style={{ padding: "0.5rem 0", borderBottom: "1px solid var(--border-subtle)" }}>
                <strong>{risk.title}</strong>
                <div className="meta-row" style={{ marginTop: "0.25rem" }}>
                  <Badge tone={risk.impact === "critical" ? "critical" : "caution"}>
                    {risk.likelihood} likelihood · {risk.impact} impact
                  </Badge>
                  <span>{risk.state}</span>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </div>
  );
}

function Activity({ data }: { data: Context }) {
  if (data.activities.length === 0) {
    return <EmptyState title="No activity recorded" />;
  }
  return (
    <Panel title="Activity">
      <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
        {data.activities.map((entry) => (
          <li key={entry.id} style={{ padding: "0.5rem 0", borderBottom: "1px solid var(--border-subtle)" }}>
            <div>{entry.summary}</div>
            <div className="meta-row" style={{ marginTop: "0.25rem" }}>
              <time className="mono">{formatDateTime(entry.occurredAt)}</time>
            </div>
          </li>
        ))}
      </ul>
    </Panel>
  );
}
