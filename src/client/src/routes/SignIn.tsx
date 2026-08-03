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
  const [showLocal, setShowLocal] = useState(false);

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

        {/*
          Google is the production path. Local email sign-in exists for
          development and is refused by the server in production, so it stays
          behind a disclosure rather than presenting a dead form by default.
        */}
        <a className="button button--primary" href="/api/auth/google" style={{ width: "100%" }}>
          Continue with Google
        </a>

        {showLocal ? null : (
          <button
            type="button"
            className="button button--quiet"
            onClick={() => setShowLocal(true)}
          >
            Sign in with email instead
          </button>
        )}

        {message ? (
          <p className="field-error" role="alert">
            {message}
          </p>
        ) : null}

        {showLocal ? (
        <>
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

        <button type="submit" className="button" disabled={signIn.isPending}>
          {signIn.isPending ? "Signing in…" : "Sign in with email"}
        </button>
        </>
        ) : null}
      </form>
    </main>
  );
}
