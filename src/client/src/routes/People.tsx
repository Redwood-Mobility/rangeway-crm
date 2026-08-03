import React from "react";
import { NavLink, useParams, useSearchParams } from "react-router";
import { useCounterparties, usePeople } from "../api/queries.js";
import {
  EmptyState,
  ErrorState,
  PageHeader,
  SkeletonRows,
  formatDate,
} from "../components/primitives.js";

/**
 * People and organizations are separate records with separate indexes. An
 * external counterparty is never conflated with Rangeway's own organization.
 */
export function People() {
  const { index = "people" } = useParams();
  const [params, setParams] = useSearchParams();
  const query = params.get("q") ?? "";

  const people = usePeople({ q: query || undefined, limit: 100 });
  const counterparties = useCounterparties({ q: query || undefined, limit: 100 });
  const active = index === "organizations" ? counterparties : people;

  function setQuery(value: string) {
    const next = new URLSearchParams(params);
    if (value) next.set("q", value);
    else next.delete("q");
    setParams(next, { replace: true });
  }

  return (
    <>
      <PageHeader
        eyebrow="Relationships"
        title="Stakeholders"
        description="The people and external organizations Rangeway works with."
      />

      <nav aria-label="Stakeholder indexes" style={{ display: "flex", gap: "0.375rem", marginBottom: "1rem" }}>
        {[
          { key: "people", label: "People" },
          { key: "organizations", label: "Organizations" },
        ].map((item) => (
          <NavLink
            key={item.key}
            to={{ pathname: `/stakeholders/${item.key}`, search: params.toString() }}
            className="button"
            style={
              index === item.key
                ? { background: "var(--surface-selected)", borderColor: "var(--accent-strong)" }
                : undefined
            }
          >
            {item.label}
          </NavLink>
        ))}
      </nav>

      <div className="filter-bar" role="search">
        <div className="field">
          <label htmlFor="stakeholder-search">Search</label>
          <input
            id="stakeholder-search"
            className="input"
            type="search"
            placeholder={index === "organizations" ? "Name, kind or website" : "Name, email or title"}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>
      </div>

      {active.error ? (
        <ErrorState error={active.error} onRetry={() => void active.refetch()} />
      ) : active.isPending ? (
        <SkeletonRows rows={6} />
      ) : index === "organizations" ? (
        (counterparties.data?.counterparties.length ?? 0) === 0 ? (
          <EmptyState title="No organizations match" />
        ) : (
          <div className="panel table-scroll">
            <table className="data-table">
              <caption className="visually-hidden">External organizations</caption>
              <thead>
                <tr>
                  <th scope="col">Name</th>
                  <th scope="col">Kind</th>
                  <th scope="col">Website</th>
                  <th scope="col">Added</th>
                </tr>
              </thead>
              <tbody>
                {counterparties.data?.counterparties.map((counterparty) => (
                  <tr key={counterparty.id}>
                    <td className="wrap">
                      <strong>{counterparty.name}</strong>
                    </td>
                    <td>{counterparty.kind || "—"}</td>
                    <td className="wrap">{counterparty.website || "—"}</td>
                    <td>
                      <time className="mono">{formatDate(counterparty.createdAt)}</time>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )
      ) : (people.data?.people.length ?? 0) === 0 ? (
        <EmptyState title="No people match" />
      ) : (
        <div className="panel table-scroll">
          <table className="data-table">
            <caption className="visually-hidden">People</caption>
            <thead>
              <tr>
                <th scope="col">Name</th>
                <th scope="col">Title</th>
                <th scope="col">Email</th>
                <th scope="col">Added</th>
              </tr>
            </thead>
            <tbody>
              {people.data?.people.map((person) => (
                <tr key={person.id}>
                  <td className="wrap">
                    <strong>{person.displayName}</strong>
                  </td>
                  <td className="wrap">{person.title || "—"}</td>
                  <td className="wrap">{person.email || "—"}</td>
                  <td>
                    <time className="mono">{formatDate(person.createdAt)}</time>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
