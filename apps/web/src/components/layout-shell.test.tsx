/**
 * El marco de las pantallas con sesión.
 *
 * La cabecera: el menú global marca «Proyectos» también dentro de un proyecto, «Importar» solo lo
 * ve quien edita y abre el importador, el nombre del proyecto enlaza a él, el selector de
 * organización aparece solo con más de una y al cambiar saca del proyecto, y «Salir» cierra sesión.
 *
 * La barra del proyecto: nombre, contrato (o que falta), sección activa contando sus direcciones
 * extra, ayuda abierta en el tema de la sección, plegar y desplegar recordándolo, volver a todos los
 * proyectos, y el error de carga en lugar del contenido.
 */
import { describe, expect, test, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";

import { AppLayout, PageLayout, ProjectLayout } from "@/components/layout";
import { HelpProvider } from "@/components/help-panel";

const call = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", async (original) => ({ ...(await original<object>()), api: call }));

const auth = vi.hoisted(() => ({
  canEdit: true,
  organizations: [{ id: "o", name: "Org" }] as { id: string; name: string }[],
  signOut: vi.fn(() => Promise.resolve()),
  selectOrganization: vi.fn(),
  organization: { id: "o", name: "Org", role: "admin" } as { id: string; name: string; role: string } | null,
}));
vi.mock("@/lib/auth", () => ({
  useAuth: () => ({
    user: { email: "ana@ejemplo.com", organizations: auth.organizations },
    signOut: auth.signOut,
    selectOrganization: auth.selectOrganization,
  }),
  useOrganization: () => auth.organization,
  useCan: () => auth.canEdit,
}));

const importer = vi.hoisted(() => ({ open: vi.fn() }));
vi.mock("@/components/import-provider", () => ({
  ImportProvider: ({ children }: { children: React.ReactNode }) => children,
  useImport: () => importer,
}));
vi.mock("@/components/environment-button", () => ({
  EnvironmentButton: ({ projectId }: { projectId: string }) => <span>entorno de {projectId}</span>,
}));
vi.mock("@/components/project-fork-menu", () => ({
  ProjectMenu: () => <span>menú</span>,
  ForkBadge: () => <span>insignia</span>,
}));

function Where() {
  const location = useLocation();
  return <p data-testid="where">{location.pathname}</p>;
}

function draw(url: string) {
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <HelpProvider>
        <MemoryRouter initialEntries={[url]}>
          <Routes>
            <Route element={<AppLayout />}>
              <Route element={<PageLayout />}>
                <Route path="/projects" element={<p>lista de proyectos</p>} />
              </Route>
              <Route path="/p/:projectId" element={<ProjectLayout />}>
                <Route index element={<p>endpoints</p>} />
                <Route path="*" element={<p>sección</p>} />
              </Route>
            </Route>
          </Routes>
          <Where />
        </MemoryRouter>
      </HelpProvider>
    </QueryClientProvider>,
  );
}

const project = { id: "p1", name: "Pedidos", contract: { title: "API Pedidos", version: "2.1" } };

beforeEach(() => {
  auth.canEdit = true;
  auth.organizations = [{ id: "o", name: "Org" }];
  auth.organization = { id: "o", name: "Org", role: "admin" };
  vi.restoreAllMocks();
  auth.signOut.mockClear();
  auth.selectOrganization.mockClear();
  importer.open.mockClear();
  window.localStorage.clear();
  call.mockReset();
  call.mockImplementation((path: string) =>
    path === "/orgs/o/projects/p1" ? Promise.resolve(project) : Promise.reject(new Error("Proyecto no encontrado")),
  );
});

describe("AppLayout", () => {
  test("fuera de un proyecto: menú, importar, organización, correo y salir", () => {
    draw("/projects");
    expect(screen.getByText("lista de proyectos")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Proyectos" }).className).toContain("bg-slate-100");
    expect(screen.getByRole("link", { name: "Panel" }).className).not.toContain("bg-slate-100");
    expect(screen.getByRole("link", { name: "Org" }).getAttribute("href")).toBe("/settings/org");
    expect(screen.getByText("ana@ejemplo.com")).toBeTruthy();
    // Por su nombre y no «el único desplegable»: la cabecera tiene también el selector de
    // backend, que sale siempre.
    expect(screen.queryByRole("combobox", { name: "Organización" })).toBeNull();
    expect(screen.queryByText(/entorno de/)).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Importar" }));
    expect(importer.open).toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Salir" }));
    expect(auth.signOut).toHaveBeenCalled();
  });

  test("quien solo lee no ve «Importar»", () => {
    auth.canEdit = false;
    draw("/projects");
    expect(screen.queryByRole("button", { name: "Importar" })).toBeNull();
  });

  test("con varias organizaciones hay selector, y cambiar saca del proyecto", async () => {
    auth.organizations = [
      { id: "o", name: "Org" },
      { id: "o2", name: "Otra" },
    ];
    draw("/p/p1/roles");
    expect(screen.getByRole("link", { name: "ajustes" })).toBeTruthy();
    fireEvent.change(screen.getByRole("combobox", { name: "Organización" }), { target: { value: "o2" } });
    expect(auth.selectOrganization).toHaveBeenCalledWith("o2");
    await waitFor(() => expect(screen.getByTestId("where").textContent).toBe("/projects"));
  });

  test("con varias organizaciones y ninguna elegida todavía, el selector sale igual y elegir una la elige", () => {
    auth.organizations = [
      { id: "o", name: "Org" },
      { id: "o2", name: "Otra" },
    ];
    auth.organization = null;
    draw("/projects");
    expect(screen.getByRole("link", { name: "ajustes" })).toBeTruthy();
    fireEvent.change(screen.getByRole("combobox", { name: "Organización" }), { target: { value: "o2" } });
    expect(auth.selectOrganization).toHaveBeenCalledWith("o2");
  });

  test("dentro de un proyecto: «Proyectos» marcado, el nombre enlaza y el entorno aparece", async () => {
    draw("/p/p1/roles");
    expect(screen.getByRole("link", { name: "Proyectos" }).className).toContain("bg-slate-100");
    expect(screen.getByText("entorno de p1")).toBeTruthy();
    await waitFor(() => expect(screen.getAllByText("Pedidos").length).toBeGreaterThan(0));
    expect(screen.getByRole("link", { name: "Pedidos" }).getAttribute("href")).toBe("/p/p1");
  });
});

describe("ProjectLayout", () => {
  test("enseña el proyecto, su contrato y marca la sección por sus direcciones extra", async () => {
    draw("/p/p1/matrix");
    expect(await screen.findByText("API Pedidos")).toBeTruthy();
    expect(screen.getByText("v2.1")).toBeTruthy();
    expect(screen.getByText("menú")).toBeTruthy();
    expect(screen.getByText("insignia")).toBeTruthy();
    const nav = screen.getByRole("navigation", { name: "Secciones del proyecto" });
    const endpoints = nav.querySelector('a[href="/p/p1"]')!;
    const roles = nav.querySelector('a[href="/p/p1/roles"]')!;
    expect(endpoints.className).toContain("bg-slate-900");
    expect(roles.className).not.toContain("bg-slate-900");
  });

  test("un proyecto sin contrato lo dice", async () => {
    call.mockImplementation(() => Promise.resolve({ ...project, contract: null }));
    draw("/p/p1");
    expect(await screen.findByText("Sin contrato todavía")).toBeTruthy();
    expect(screen.getByText("endpoints")).toBeTruthy();
  });

  test("la ayuda se abre en el tema de la sección", () => {
    draw("/p/p1/roles");
    window.history.pushState({}, "", "/p/p1/workflows");
    try {
      fireEvent.click(screen.getByRole("button", { name: "Ayuda y documentación" }));
      const dialog = screen.getByRole("dialog", { name: "Ayuda y documentación" });
      expect(dialog.querySelector("h2")!.textContent).toBe("Flow Testing");
    } finally {
      window.history.pushState({}, "", "/");
    }
  });

  test("se pliega, lo recuerda y se despliega; «Todos los proyectos» vuelve a la lista", () => {
    draw("/p/p1/roles");
    fireEvent.click(screen.getByTitle("Plegar barra lateral"));
    expect(window.localStorage.getItem("eq.sidebar-collapsed")).toBe("true");
    expect(screen.queryByText("Navegación")).toBeNull();
    expect(screen.getByTitle("Roles")).toBeTruthy();
    fireEvent.click(screen.getByTitle("Expandir barra lateral"));
    expect(window.localStorage.getItem("eq.sidebar-collapsed")).toBe("false");
    expect(screen.getByText("Navegación")).toBeTruthy();

    fireEvent.click(screen.getByTitle("Todos los proyectos"));
    expect(screen.getByTestId("where").textContent).toBe("/projects");
  });

  test("arranca plegada si así se dejó", () => {
    window.localStorage.setItem("eq.sidebar-collapsed", "true");
    draw("/p/p1/roles");
    expect(screen.getByTitle("Expandir barra lateral")).toBeTruthy();
  });

  test("sin almacenamiento arranca desplegada y plegar sigue funcionando en esta pestaña", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("SecurityError");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("SecurityError");
    });
    draw("/p/p1/roles");
    expect(screen.getByTitle("Plegar barra lateral")).toBeTruthy();
    fireEvent.click(screen.getByTitle("Plegar barra lateral"));
    expect(screen.getByTitle("Expandir barra lateral")).toBeTruthy();
  });

  test("un proyecto que no carga enseña el error en lugar de la sección", async () => {
    draw("/p/p9/roles");
    expect(await screen.findByText("Proyecto no encontrado")).toBeTruthy();
    expect(screen.queryByText("sección")).toBeNull();
  });
});
