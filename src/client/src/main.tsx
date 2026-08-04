import React from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Navigate, Route, Routes } from "react-router";
import { AtlasApiError } from "./api/client.js";
import { useMe } from "./api/queries.js";
import { AppShell } from "./app/AppShell.js";
import { ErrorState, LoadingState } from "./components/primitives.js";
import { Agents } from "./routes/Agents.js";
import { CommandCenter } from "./routes/CommandCenter.js";
import { NotFound } from "./routes/NotFound.js";
import { People } from "./routes/People.js";
import { ProjectRoom } from "./routes/ProjectRoom.js";
import { Projects } from "./routes/Projects.js";
import { SignIn } from "./routes/SignIn.js";
import { Today } from "./routes/Today.js";
import { Work } from "./routes/Work.js";
import { Workspace } from "./routes/Workspace.js";
import "./styles/app.css";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 10_000,
      refetchOnWindowFocus: false,
      // Authorization and validation failures are final; only transport and
      // server faults are worth retrying.
      retry: (failureCount, error) => {
        if (error instanceof AtlasApiError && error.status > 0 && error.status < 500) return false;
        return failureCount < 2;
      },
    },
  },
});

/**
 * Gates the application on an authenticated actor. The attempted URL is
 * preserved so signing in returns the user where they were headed.
 */
function RequireActor() {
  const { data, isPending, error, refetch } = useMe();

  if (isPending) return <LoadingState label="Opening Atlas" />;

  if (error) {
    const unauthenticated =
      error instanceof AtlasApiError && (error.status === 401 || error.code === "UNAUTHENTICATED");
    if (unauthenticated) {
      const returnTo = `${window.location.pathname}${window.location.search}`;
      return <Navigate to="/sign-in" replace state={{ returnTo }} />;
    }
    return <ErrorState error={error} onRetry={() => void refetch()} />;
  }

  if (!data?.actor) return <Navigate to="/sign-in" replace />;
  return <AppShell />;
}

function App() {
  return (
    <Routes>
      <Route path="/sign-in" element={<SignIn />} />
      <Route element={<RequireActor />}>
        <Route index element={<Navigate to="/today" replace />} />
        <Route path="/today" element={<Today />} />
        <Route path="/command-center" element={<CommandCenter />} />
        <Route path="/projects" element={<Projects />} />
        <Route path="/projects/:projectId" element={<ProjectRoom />} />
        <Route path="/projects/:projectId/:tab" element={<ProjectRoom />} />
        <Route path="/work" element={<Work />} />
        <Route path="/work/:view" element={<Work />} />
        <Route path="/settings/agents" element={<Agents />} />
        <Route path="/settings/workspace" element={<Workspace />} />
        <Route path="/stakeholders" element={<People />} />
        <Route path="/stakeholders/:index" element={<People />} />
        <Route path="*" element={<NotFound />} />
      </Route>
    </Routes>
  );
}

const container = document.getElementById("root");
if (!container) throw new Error("Atlas root element is missing.");

createRoot(container).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </QueryClientProvider>
  </React.StrictMode>,
);
