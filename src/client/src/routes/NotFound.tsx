import React from "react";
import { Link } from "react-router";
import { PageHeader } from "../components/primitives.js";

/**
 * One presentation for "does not exist" and "you may not see it". Anything that
 * distinguished the two would disclose the existence of private records.
 */
export function NotFound() {
  return (
    <>
      <PageHeader eyebrow="Atlas" title="Not available" />
      <div className="state">
        <p>This page does not exist, or your account cannot open it.</p>
        <Link className="button" to="/today">
          Go to Today
        </Link>
      </div>
    </>
  );
}
