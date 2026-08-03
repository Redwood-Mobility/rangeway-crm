import React from "react";
import { Link, NavLink, useParams } from "react-router";
import { useProjectContext } from "../api/queries.js";
import {
  boardLanes,
  projectStatusLabels,
  workItemStatusLabels,
  type ProjectHealth,
  type ProjectStatus,
} from "../api/types.js";
import {
  Badge,
  EmptyState,
  ErrorState,
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
  { key: "activity", label: "Activity" },
];

export function ProjectRoom() {
  const { projectId, tab = "overview" } = useParams();
  const { data, isPending, error, refetch } = useProjectContext(projectId);

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
          </>
        }
      />

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
      {tab === "gates" ? <Gates project={project} /> : null}
      {tab === "stakeholders" ? <Stakeholders data={data} /> : null}
      {tab === "decisions" ? <DecisionsAndRisks data={data} /> : null}
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

/**
 * The Location Pursuit gate engine is Task 3. This slot states that plainly
 * rather than showing a placeholder that looks like working functionality.
 */
function Gates({ project }: { project: Context["project"] }) {
  return (
    <EmptyState
      title={
        project.templateType === "location_pursuit"
          ? "Development-area gates are not built yet"
          : "This project does not use the Location Pursuit template"
      }
      description={
        project.templateType === "location_pursuit"
          ? "The eight development areas, requirement states, evidence and phase reconciliation arrive with the Location Pursuit engine. Nothing is being tracked here yet."
          : "Only Location Pursuit projects carry development-area gates."
      }
    />
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
