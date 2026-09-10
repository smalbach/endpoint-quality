import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";

import "./styles/index.css";
import { ApiError } from "@/lib/api";
import { AuthProvider, useAuth } from "@/lib/auth";
import { AppLayout } from "@/components/layout";
import { LoginPage } from "@/routes/login";
import { ProjectsPage } from "@/routes/projects";
import { MatrixPage } from "@/routes/matrix";
import { EnvironmentsPage } from "@/routes/environments";
import { ConfigPage } from "@/routes/config";
import { RunDetailPage, RunsPage } from "@/routes/runs";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 10_000,
      // A 401 has already been handled by the client — it refreshed once and gave up — and a 403
      // or a 404 will not become a 200 by asking again. Retrying either only delays the message.
      retry: (failureCount, error) => !(error instanceof ApiError && error.status < 500) && failureCount < 2,
    },
  },
});

/**
 * The gate.
 *
 * `loading` renders nothing rather than the login screen: on a page reload the app has no access
 * token — it lives in memory — but may still hold a valid refresh cookie, and showing `/login`
 * before that answer arrives would sign people out every time they hit F5.
 */
function Protected() {
  const { status } = useAuth();
  if (status === "loading") return <div className="grid min-h-dvh place-items-center text-sm text-slate-400">…</div>;
  if (status === "anonymous") return <Navigate to="/login" replace />;
  return <AppLayout />;
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <AuthProvider>
          <Routes>
            <Route path="/login" element={<LoginPage mode="login" />} />
            <Route path="/register" element={<LoginPage mode="register" />} />
            <Route element={<Protected />}>
              <Route index element={<ProjectsPage />} />
              <Route path="p/:projectId">
                <Route index element={<MatrixPage />} />
                <Route path="environments" element={<EnvironmentsPage />} />
                <Route path="config" element={<ConfigPage />} />
                <Route path="runs" element={<RunsPage />} />
                <Route path="runs/:runId" element={<RunDetailPage />} />
              </Route>
            </Route>
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </AuthProvider>
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
);
