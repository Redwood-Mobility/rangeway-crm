import React, { useState, type FormEvent } from "react";
import { Navigate, useLocation, useNavigate } from "react-router";
import { AtlasApiError } from "../api/client.js";
import { useMe, useSignIn } from "../api/queries.js";
import { Field } from "../components/primitives.js";

export function SignIn() {
  const { data } = useMe();
  const signIn = useSignIn();
  const navigate = useNavigate();
  const location = useLocation();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");

  const returnTo = (location.state as { returnTo?: string } | null)?.returnTo ?? "/today";

  if (data?.actor) return <Navigate to={returnTo} replace />;

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    signIn.mutate(
      { email, password },
      { onSuccess: () => navigate(returnTo, { replace: true }) },
    );
  }

  const error = signIn.error;
  const message =
    error instanceof AtlasApiError
      ? error.status === 401
        ? "That email and password combination was not accepted."
        : error.message
      : error
        ? "Sign-in failed. Try again."
        : null;

  return (
    <main className="signin">
      <form className="panel signin__card" onSubmit={onSubmit}>
        <div className="app-brand" style={{ padding: 0 }}>
          <strong>Rangeway</strong>
          <span>Atlas</span>
        </div>
        <h1>Sign in</h1>
        <p style={{ color: "var(--text-muted)" }}>
          Atlas is Rangeway's internal operating office. Accounts are provisioned by an
          organization owner.
        </p>

        {message ? (
          <p className="field-error" role="alert">
            {message}
          </p>
        ) : null}

        <Field label="Email" htmlFor="signin-email">
          <input
            id="signin-email"
            className="input"
            type="email"
            autoComplete="username"
            required
            value={email}
            onChange={(event) => setEmail(event.target.value)}
          />
        </Field>

        <Field label="Password" htmlFor="signin-password">
          <input
            id="signin-password"
            className="input"
            type="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
        </Field>

        <button type="submit" className="button button--primary" disabled={signIn.isPending}>
          {signIn.isPending ? "Signing in…" : "Sign in"}
        </button>
      </form>
    </main>
  );
}
