/**
 * El mapa de direcciones de la app y su portero.
 *
 * Cada página tiene sus propias pruebas; aquí se sustituyen por un rótulo con su nombre, porque lo
 * que decide este fichero es a cuál lleva cada dirección:
 *
 * - **Entrar, registrarse, restablecer y la documentación publicada no piden sesión**; lo demás sí.
 * - **Mientras la sesión se decide no se enseña el login**, que cerraría la sesión en cada F5.
 * - **Las direcciones antiguas de entornos y configuración llevan a Settings.**
 * - **Las pantallas pesadas llegan perezosas** y con un «Cargando» mientras.
 * - **Un 4xx no se reintenta**; un fallo de red o un 5xx, dos veces.
 */
import { describe, expect, test, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter, Outlet, useParams } from "react-router-dom";

import { App, createQueryClient, shouldRetry } from "@/app";
import { ApiError } from "@/lib/api";

const session = vi.hoisted(() => ({ status: "authenticated" as string }));

vi.mock("@/lib/auth", () => ({
  AuthProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  useAuth: () => ({ status: session.status }),
}));
vi.mock("@/components/layout", () => ({
  AppLayout: () => (
    <div data-testid="app-layout">
      <Outlet />
    </div>
  ),
  PageLayout: () => (
    <div data-testid="page-layout">
      <Outlet />
    </div>
  ),
  ProjectLayout: () => (
    <div data-testid="project-layout">
      <Outlet />
    </div>
  ),
}));
vi.mock("@/components/help-panel", () => ({
  HelpProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

/** A page stand-in that says which page it is and the params it got. */
function stub(name: string) {
  return function Page(props: Record<string, unknown>) {
    const params = useParams();
    const extra = Object.values({ ...props, ...params }).join(" ");
    return (
      <p data-testid="page">
        {name}
        {extra ? ` ${extra}` : ""}
      </p>
    );
  };
}

vi.mock("@/routes/login", () => ({ LoginPage: stub("LoginPage") }));
vi.mock("@/routes/password-reset", () => ({
  ForgotPasswordPage: stub("ForgotPasswordPage"),
  ResetPasswordPage: stub("ResetPasswordPage"),
}));
vi.mock("@/routes/published-docs", () => ({ PublishedDocsPage: stub("PublishedDocsPage") }));
vi.mock("@/routes/dashboard", () => ({ DashboardPage: stub("DashboardPage") }));
vi.mock("@/routes/projects", () => ({ ProjectsPage: stub("ProjectsPage") }));
vi.mock("@/routes/history", () => ({ HistoryPage: stub("HistoryPage") }));
vi.mock("@/routes/settings", () => ({ SettingsPage: stub("SettingsPage") }));
vi.mock("@/routes/not-found", () => ({ NotFoundPage: stub("NotFoundPage") }));
vi.mock("@/routes/endpoints", () => ({
  EndpointsPage: stub("EndpointsPage"),
  EndpointEditorPage: stub("EndpointEditorPage"),
}));
vi.mock("@/routes/matrix", () => ({ MatrixPage: stub("MatrixPage") }));
vi.mock("@/routes/channels", () => ({ ChannelsPage: stub("ChannelsPage") }));
vi.mock("@/routes/roles", () => ({ RolesPage: stub("RolesPage") }));
vi.mock("@/routes/workflows", () => ({ WorkflowsPage: stub("WorkflowsPage") }));
vi.mock("@/routes/runs", () => ({ RunsPage: stub("RunsPage"), RunDetailPage: stub("RunDetailPage") }));
vi.mock("@/routes/security-runs", () => ({
  SecurityRunsPage: stub("SecurityRunsPage"),
  SecurityRunDetailPage: stub("SecurityRunDetailPage"),
}));
vi.mock("@/routes/performance", () => ({
  PerformancePage: stub("PerformancePage"),
  PerformanceRunDetailPage: stub("PerformanceRunDetailPage"),
  PerformanceComparePage: stub("PerformanceComparePage"),
}));
vi.mock("@/routes/code-scan", () => ({ CodeScanPage: stub("CodeScanPage") }));
vi.mock("@/routes/mocks", () => ({ MocksPage: stub("MocksPage") }));
vi.mock("@/routes/doc-sites", () => ({ DocSitesPage: stub("DocSitesPage") }));
vi.mock("@/routes/monitors", () => ({ MonitorsPage: stub("MonitorsPage") }));
vi.mock("@/routes/fork-sync", () => ({ ForkSyncPage: stub("ForkSyncPage") }));
vi.mock("@/routes/merge-requests", () => ({
  MergeRequestsPage: stub("MergeRequestsPage"),
  MergeRequestDetailPage: stub("MergeRequestDetailPage"),
}));
vi.mock("@/routes/project-settings", () => ({
  ProjectSettingsLayout: () => (
    <div data-testid="settings-layout">
      <Outlet />
    </div>
  ),
  ProjectGeneralPage: stub("ProjectGeneralPage"),
}));
vi.mock("@/routes/config", () => ({ ConfigPage: stub("ConfigPage") }));
vi.mock("@/routes/environments", () => ({ EnvironmentsPage: stub("EnvironmentsPage") }));
vi.mock("@/routes/project-transfer", () => ({ ProjectTransferPage: stub("ProjectTransferPage") }));

function draw(at: string, status = "authenticated") {
  session.status = status;
  return render(
    <MemoryRouter initialEntries={[at]}>
      <App client={createQueryClient()} />
    </MemoryRouter>,
  );
}

const page = () => screen.getByTestId("page").textContent;

describe("las direcciones sin sesión", () => {
  test.each([
    ["/login", "LoginPage login"],
    ["/register", "LoginPage register"],
    ["/forgot-password", "ForgotPasswordPage"],
    ["/reset-password", "ResetPasswordPage"],
    ["/docs/abc", "PublishedDocsPage abc"],
  ])("%s lleva a %s aunque no haya sesión", (at, expected) => {
    draw(at, "anonymous");
    expect(page()).toBe(expected);
  });
});

describe("el portero", () => {
  test("mientras se decide la sesión no enseña ni el login ni la página", () => {
    draw("/projects", "loading");
    expect(screen.getByText("…")).toBeTruthy();
    expect(screen.queryByTestId("page")).toBeNull();
  });

  test("sin sesión lleva al login", () => {
    draw("/p/p1/runs", "anonymous");
    expect(page()).toBe("LoginPage login");
  });

  test("con sesión, la raíz lleva a los proyectos dentro del marco de la app", () => {
    draw("/");
    expect(page()).toBe("ProjectsPage");
    expect(screen.getByTestId("app-layout")).toBeTruthy();
    expect(screen.getByTestId("page-layout")).toBeTruthy();
  });
});

describe("las páginas de la organización", () => {
  test.each([
    ["/dashboard", "DashboardPage"],
    ["/projects", "ProjectsPage"],
    ["/history", "HistoryPage"],
    ["/settings/org", "SettingsPage"],
    ["/nada/de/esto", "NotFoundPage nada/de/esto"],
  ])("%s → %s", (at, expected) => {
    draw(at);
    expect(page()).toBe(expected);
  });
});

describe("las páginas de un proyecto", () => {
  test.each([
    ["/p/p1", "EndpointsPage p1"],
    ["/p/p1/matrix", "MatrixPage p1"],
    ["/p/p1/channels", "ChannelsPage p1"],
    ["/p/p1/endpoints/e1", "EndpointEditorPage p1 e1"],
    ["/p/p1/roles", "RolesPage p1"],
    ["/p/p1/runs", "RunsPage p1"],
    ["/p/p1/runs/r1", "RunDetailPage p1 r1"],
    ["/p/p1/security", "SecurityRunsPage p1"],
    ["/p/p1/security/r1", "SecurityRunDetailPage p1 r1"],
    ["/p/p1/mocks", "MocksPage p1"],
    ["/p/p1/doc-sites", "DocSitesPage p1"],
    ["/p/p1/monitors", "MonitorsPage p1"],
    ["/p/p1/fork/pull", "ForkSyncPage p1 pull"],
    ["/p/p1/merge-requests", "MergeRequestsPage p1"],
    ["/p/p1/merge-requests/m1", "MergeRequestDetailPage p1 m1"],
    ["/p/p1/settings", "ProjectGeneralPage p1"],
    ["/p/p1/settings/contract", "ConfigPage p1"],
    ["/p/p1/settings/environments", "EnvironmentsPage p1"],
    ["/p/p1/settings/transfer", "ProjectTransferPage p1"],
    ["/p/p1/no-existe", "NotFoundPage p1 no-existe"],
  ])("%s → %s", (at, expected) => {
    draw(at);
    expect(page()).toBe(expected);
    expect(screen.getByTestId("project-layout")).toBeTruthy();
  });

  test.each([
    ["/p/p1/environments", "EnvironmentsPage p1"],
    ["/p/p1/config", "ConfigPage p1"],
  ])("la dirección antigua %s lleva a Settings (%s)", (at, expected) => {
    draw(at);
    expect(page()).toBe(expected);
    expect(screen.getByTestId("settings-layout")).toBeTruthy();
  });

  test.each([
    ["/p/p1/workflows", "Cargando editor…", "WorkflowsPage p1"],
    ["/p/p1/performance", "Cargando…", "PerformancePage p1"],
    ["/p/p1/performance/compare/a/b", "Cargando…", "PerformanceComparePage p1 a b"],
    ["/p/p1/performance/r1", "Cargando…", "PerformanceRunDetailPage p1 r1"],
    ["/p/p1/code-scan", "Cargando…", "CodeScanPage p1"],
  ])("%s llega perezosa: primero «%s», luego %s", async (at, loading, expected) => {
    draw(at);
    expect(screen.getByText(loading)).toBeTruthy();
    expect((await screen.findByTestId("page")).textContent).toBe(expected);
  });
});

describe("shouldRetry", () => {
  const problem = (status: number) => new ApiError(status, { type: "", title: "", status, detail: "" });

  test("un 4xx no se reintenta; un 5xx o un fallo de red, hasta dos veces", () => {
    expect(shouldRetry(0, problem(403))).toBe(false);
    expect(shouldRetry(0, problem(404))).toBe(false);
    expect(shouldRetry(0, problem(503))).toBe(true);
    expect(shouldRetry(1, new TypeError("Failed to fetch"))).toBe(true);
    expect(shouldRetry(2, new TypeError("Failed to fetch"))).toBe(false);
  });

  test("el cliente de la app lo usa, con diez segundos de frescura", () => {
    const client = createQueryClient();
    expect(client.getDefaultOptions().queries).toEqual({ staleTime: 10_000, retry: shouldRetry });
  });
});
