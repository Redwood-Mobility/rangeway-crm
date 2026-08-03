import React from "react";
import { Link } from "react-router";
import { usePortfolio, usePortfolioHealth } from "../api/queries.js";
import {
  projectHealthLabels,
  projectStatusLabels,
  workItemStatusLabels,
  type ProjectHealth,
  type ProjectStatus,
} from "../api/types.js";
import {
  EmptyState,
  ErrorState,
  HealthBadge,
  PageHeader,
  Panel,
  SkeletonRows,
  formatDate,
} from "../components/primitives.js";

/**
 * The organization-wide operating picture. Every aggregate is a link into the
 * records behind it — no number is a dead end.
 */
export function CommandCenter() {
  const portfolio = usePortfolio({ limit: 100 });
  const health = usePortfolioHealth();

  if (portfolio.error) {
    return <ErrorState error={portfolio.error} onRetry={() => void portfolio.refetch()} />;
  }

  const projects = portfolio.data?.projects ?? [];
  const attention = projects.filter(
    (project) => project.health === "at_risk" || project.health === "off_track",
  );
  const withoutNextAction = projects.filter((project) => !project.nextAction);

  return (
    <>
      <PageHeader
        eyebrow="Organization"
        title="Command Center"
        description="Active projects by health, the attention queue, and where work is concentrated."
      />

      {portfolio.isPending ? (
        <SkeletonRows rows={6} />
      ) : projects.length === 0 ? (
        <EmptyState
          title="No active projects"
          description="Projects appear here once they exist and are not archived."
          action={
            <Link className="button button--primary" to="/projects">
              Go to Projects
            </Link>
          }
        />
      ) : (
        <>
          <div className="panel-grid" style={{ marginBottom: "var(--section-gap)" }}>
            <Panel title="Health distribution">
              {health.isPending ? (
                <SkeletonRows rows={3} />
              ) : (
                <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: "0.5rem" }}>
                  {(health.data?.health ?? []).map((entry) => (
                    <li key={entry.health} style={{ display: "flex", justifyContent: "space-between", gap: "0.75rem" }}>
                      <Link to={`/projects?health=${entry.health}`}>
                        {projectHealthLabels[entry.health as ProjectHealth] ?? entry.health}
                      </Link>
                      <span className="mono">{entry.projectCount}</span>
                    </li>
                  ))}
                </ul>
              )}
            </Panel>

            <Panel title="Attention queue">
              {attention.length === 0 ? (
                <EmptyState title="Nothing at risk" description="No active project is at risk or off track." />
              ) : (
                <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
                  {attention.map((project) => (
                    <li key={project.id} style={{ padding: "0.5rem 0", borderBottom: "1px solid var(--border-subtle)" }}>
                      <Link to={`/projects/${project.id}`} style={{ fontWeight: 600 }}>
                        {project.name}
                      </Link>
                      <div className="meta-row" style={{ marginTop: "0.25rem" }}>
                        <HealthBadge health={project.health as ProjectHealth} />
                        <span>{project.blockerSummary || "No blocker recorded"}</span>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </Panel>

            <Panel title="Missing a next action">
              {withoutNextAction.length === 0 ? (
                <EmptyState title="Every project states its next action" />
              ) : (
                <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
                  {withoutNextAction.map((project) => (
                    <li key={project.id} style={{ padding: "0.375rem 0" }}>
                      <Link to={`/projects/${project.id}`}>{project.name}</Link>
                    </li>
                  ))}
                </ul>
              )}
            </Panel>
          </div>

          <div className="panel table-scroll">
            <table className="data-table">
              <caption className="visually-hidden">Active projects with work distribution</caption>
              <thead>
                <tr>
                  <th scope="col">Project</th>
                  <th scope="col">Health</th>
                  <th scope="col">Status</th>
                  <th scope="col">In progress</th>
                  <th scope="col">Waiting</th>
                  <th scope="col">Done</th>
                  <th scope="col">Last activity</th>
                </tr>
              </thead>
              <tbody>
                {projects.map((project) => (
                  <tr key={project.id}>
                    <td className="wrap">
                      <Link to={`/projects/${project.id}`} style={{ fontWeight: 600 }}>
                        {project.name}
                      </Link>
                    </td>
                    <td>
                      <HealthBadge health={project.health as ProjectHealth} />
                    </td>
                    <td>{projectStatusLabels[project.status as ProjectStatus]}</td>
                    {(["in_progress", "waiting", "done"] as const).map((status) => (
                      <td key={status}>
                        <Link
                          to={`/work/list?projectId=${project.id}&status=${status}`}
                          aria-label={`${project.workStatusCounts[status] ?? 0} ${workItemStatusLabels[status]} items in ${project.name}`}
                          className="mono"
                        >
                          {project.workStatusCounts[status] ?? 0}
                        </Link>
                      </td>
                    ))}
                    <td>
                      <time className="mono">{formatDate(project.recentActivityAt)}</time>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </>
  );
}
