/**
 * The app without its entry point: the query client, the providers and every route.
 *
 * Out of `main.tsx` so it can be rendered under a `MemoryRouter` in a test — `main.tsx` is only
 * the `createRoot` that mounts it in a `BrowserRouter`.
 */
import { lazy, Suspense } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Navigate, Route, Routes, useParams } from "react-router-dom";

import { ApiError } from "@/lib/api";
import { AuthProvider, useAuth } from "@/lib/auth";
import { AppLayout, PageLayout, ProjectLayout } from "@/components/layout";
import { ToastProvider } from "@/components/toast";
import { HelpProvider } from "@/components/help-panel";
import { LoginPage } from "@/routes/login";
import { ProjectsPage } from "@/routes/projects";
import { DashboardPage } from "@/routes/dashboard";
import { HistoryPage } from "@/routes/history";
import { SettingsPage } from "@/routes/settings";
import { MatrixPage } from "@/routes/matrix";
import { EndpointEditorPage, EndpointsPage } from "@/routes/endpoints";
import { EnvironmentsPage } from "@/routes/environments";
import { ConfigPage } from "@/routes/config";
import { RunDetailPage, RunsPage } from "@/routes/runs";
import { SecurityRunDetailPage, SecurityRunsPage } from "@/routes/security-runs";
import { RolesPage } from "@/routes/roles";
import { MocksPage } from "@/routes/mocks";
import { DocSitesPage } from "@/routes/doc-sites";
import { MonitorsPage } from "@/routes/monitors";
import { ForkSyncPage } from "@/routes/fork-sync";
import { MergeRequestDetailPage, MergeRequestsPage } from "@/routes/merge-requests";
import { ChannelsPage } from "@/routes/channels";
import { PublishedDocsPage } from "@/routes/published-docs";
import { ProjectGeneralPage, ProjectSettingsLayout } from "@/routes/project-settings";
import { ProjectTransferPage } from "@/routes/project-transfer";
import { NotFoundPage } from "@/routes/not-found";
import { ForgotPasswordPage, ResetPasswordPage } from "@/routes/password-reset";

// The graph editor brings its own renderer and controls. Keep it out of the initial dashboard
// bundle so users who only inspect the matrix do not download it on every visit.
const WorkflowsPage = lazy(() => import("@/routes/workflows").then((module) => ({ default: module.WorkflowsPage })));
const PerformancePage = lazy(() =>
  import("@/routes/performance").then((module) => ({ default: module.PerformancePage })),
);
const PerformanceRunDetailPage = lazy(() =>
  import("@/routes/performance").then((module) => ({ default: module.PerformanceRunDetailPage })),
);
const PerformanceComparePage = lazy(() =>
  import("@/routes/performance").then((module) => ({ default: module.PerformanceComparePage })),
);
const CodeScanPage = lazy(() => import("@/routes/code-scan").then((module) => ({ default: module.CodeScanPage })));
// El editor de una colección trae el árbol, el editor de peticiones y el informe de las corridas:
// fuera del bundle inicial, como el editor de flujos.
const CollectionsPage = lazy(() =>
  import("@/routes/collections").then((module) => ({ default: module.CollectionsPage })),
);
const CollectionPage = lazy(() => import("@/routes/collections").then((module) => ({ default: module.CollectionPage })));
const CollectionRunPage = lazy(() =>
  import("@/routes/collections").then((module) => ({ default: module.CollectionRunPage })),
);

/**
 * Whether a failed query is worth asking again.
 *
 * A 401 has already been handled by the client — it refreshed once and gave up — and a 403 or a
 * 404 will not become a 200 by asking again. Retrying either only delays the message.
 */
export const shouldRetry = (failureCount: number, error: unknown): boolean =>
  !(error instanceof ApiError && error.status < 500) && failureCount < 2;

export function createQueryClient(): QueryClient {
  return new QueryClient({ defaultOptions: { queries: { staleTime: 10_000, retry: shouldRetry } } });
}

/**
 * The gate.
 *
 * `loading` renders nothing rather than the login screen: on a page reload the app has no access
 * token — it lives in memory — but may still hold a valid refresh cookie, and showing `/login`
 * before that answer arrives would sign people out every time they hit F5.
 */
export function Protected() {
  const { status } = useAuth();
  if (status === "loading") return <div className="grid min-h-dvh place-items-center text-sm text-slate-400">…</div>;
  if (status === "anonymous") return <Navigate to="/login" replace />;
  return <AppLayout />;
}

/** The old addresses of the two screens that moved under Settings, so bookmarks keep working. */
export function MovedToSettings({ to }: { to: string }) {
  const { projectId } = useParams();
  return <Navigate to={`/p/${projectId}/settings/${to}`} replace />;
}

/** Every address the app answers, below whichever router mounts it. */
export function AppRoutes() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage mode="login" />} />
      <Route path="/register" element={<LoginPage mode="register" />} />
      <Route path="/forgot-password" element={<ForgotPasswordPage />} />
      <Route path="/reset-password" element={<ResetPasswordPage />} />
      {/* La documentación publicada: **fuera** de `Protected`, que es de lo que va. La lee
          alguien que no tiene cuenta aquí, y si estuviera dentro del portero lo mandaría
          a `/login` con un enlace que se le acaba de dar. */}
      <Route path="/docs/:publicId" element={<PublishedDocsPage />} />
      <Route element={<Protected />}>
        <Route element={<PageLayout />}>
          <Route index element={<Navigate to="/projects" replace />} />
          <Route path="dashboard" element={<DashboardPage />} />
          <Route path="projects" element={<ProjectsPage />} />
          <Route path="history" element={<HistoryPage />} />
          <Route path="settings/org" element={<SettingsPage />} />
          <Route path="*" element={<NotFoundPage />} />
        </Route>
        <Route path="p/:projectId" element={<ProjectLayout />}>
          <Route index element={<EndpointsPage />} />
          <Route path="matrix" element={<MatrixPage />} />
          <Route path="channels" element={<ChannelsPage />} />
          <Route path="endpoints/:endpointId" element={<EndpointEditorPage />} />
          <Route path="roles" element={<RolesPage />} />
          <Route
            path="workflows"
            element={
              <Suspense fallback={<p className="text-sm text-slate-500">Cargando editor…</p>}>
                <WorkflowsPage />
              </Suspense>
            }
          />
          <Route
            path="workflows/:workflowId"
            element={
              <Suspense fallback={<p className="text-sm text-slate-500">Cargando editor…</p>}>
                <WorkflowsPage />
              </Suspense>
            }
          />
          <Route
            path="collections"
            element={
              <Suspense fallback={<p className="text-sm text-slate-500">Cargando…</p>}>
                <CollectionsPage />
              </Suspense>
            }
          />
          <Route
            path="collections/runs/:runId"
            element={
              <Suspense fallback={<p className="text-sm text-slate-500">Cargando…</p>}>
                <CollectionRunPage />
              </Suspense>
            }
          />
          <Route
            path="collections/:collectionId"
            element={
              <Suspense fallback={<p className="text-sm text-slate-500">Cargando…</p>}>
                <CollectionPage />
              </Suspense>
            }
          />
          <Route path="runs" element={<RunsPage />} />
          <Route path="runs/:runId" element={<RunDetailPage />} />
          <Route path="security" element={<SecurityRunsPage />} />
          <Route path="security/:runId" element={<SecurityRunDetailPage />} />
          <Route
            path="performance"
            element={
              <Suspense fallback={<p className="text-sm text-slate-500">Cargando…</p>}>
                <PerformancePage />
              </Suspense>
            }
          />
          <Route
            path="performance/compare/:baseRunId/:targetRunId"
            element={
              <Suspense fallback={<p className="text-sm text-slate-500">Cargando…</p>}>
                <PerformanceComparePage />
              </Suspense>
            }
          />
          <Route
            path="performance/:runId"
            element={
              <Suspense fallback={<p className="text-sm text-slate-500">Cargando…</p>}>
                <PerformanceRunDetailPage />
              </Suspense>
            }
          />
          <Route
            path="code-scan"
            element={
              <Suspense fallback={<p className="text-sm text-slate-500">Cargando…</p>}>
                <CodeScanPage />
              </Suspense>
            }
          />
          <Route path="mocks" element={<MocksPage />} />
          <Route path="doc-sites" element={<DocSitesPage />} />
          <Route path="monitors" element={<MonitorsPage />} />
          <Route path="fork/:direction" element={<ForkSyncPage />} />
          <Route path="merge-requests" element={<MergeRequestsPage />} />
          <Route path="merge-requests/:requestId" element={<MergeRequestDetailPage />} />
          <Route path="settings" element={<ProjectSettingsLayout />}>
            <Route index element={<ProjectGeneralPage />} />
            <Route path="contract" element={<ConfigPage />} />
            <Route path="environments" element={<EnvironmentsPage />} />
            <Route path="transfer" element={<ProjectTransferPage />} />
          </Route>
          <Route path="environments" element={<MovedToSettings to="environments" />} />
          <Route path="config" element={<MovedToSettings to="contract" />} />
          <Route path="*" element={<NotFoundPage />} />
        </Route>
      </Route>
    </Routes>
  );
}

/** The providers around the routes. The router is the caller's. */
export function App({ client }: { client: QueryClient }) {
  return (
    <QueryClientProvider client={client}>
      <AuthProvider>
        <ToastProvider>
          <HelpProvider>
            <AppRoutes />
          </HelpProvider>
        </ToastProvider>
      </AuthProvider>
    </QueryClientProvider>
  );
}
