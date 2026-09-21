/**
 * La matriz del contrato.
 *
 * Lo que decide algo:
 *
 * - **Sin contrato hay una pantalla propia** que lleva a configuración, no una rejilla vacía.
 * - **Se parte del entorno activo** y elegir otro lo activa; sin entorno no se puede ejecutar.
 * - **Lo que se ejecuta es lo que se ve**: la selección va como ids y la etiqueta propia como
 *   filtro, no resuelta a ids.
 * - **La cobertura nombra los huecos**, y un caso bloqueado dice por qué.
 */
import { beforeEach, describe, expect, test, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";

import { MatrixPage } from "@/routes/matrix";
import { ApiError } from "@/lib/api";
import type { CoverageView, Environment, OperationScenarios, ScenariosView } from "@/lib/types";

const call = vi.hoisted(() => vi.fn());
const can = vi.hoisted(() => ({ editor: true }));
vi.mock("@/lib/api", async (original) => ({
  ...(await original<object>()),
  api: call,
}));
vi.mock("@/lib/auth", () => ({
  useOrganization: () => ({ id: "o", name: "Org" }),
  useCan: (role: "editor") => can[role] ?? true,
}));

const environment = (patch: Partial<Environment>): Environment => ({
  id: "e1",
  name: "staging",
  baseUrl: "https://staging.test",
  specUrl: null,
  variables: {},
  disabledVariables: {},
  writesAllowed: true,
  authEnforced: true,
  active: false,
  credentials: [],
  archivedAt: null,
  deletedAt: null,
  ...patch,
});

const operations: OperationScenarios[] = [
  {
    id: "listOrders",
    method: "GET",
    path: "/orders",
    tag: "Pedidos",
    labels: ["crítico"],
    summary: "Lista los pedidos",
    implemented: true,
    responseShape: "{ data, meta }",
    scenarios: [
      {
        id: "ok",
        name: "Lista con éxito",
        description: "Devuelve la primera página",
        expectedStatus: 200,
        flow: "happy",
        auth: "primary",
        requestPath: "/orders?page=1",
        budget: { ms: 300, label: "300 ms", source: "p95" },
        runnable: true,
      },
      {
        id: "unauth",
        name: "Sin credencial",
        description: "Rechaza sin token",
        expectedStatus: 401,
        flow: "auth",
        requestPath: "/orders",
        budget: null,
        runnable: false,
        blockedReason: "El entorno no aplica autorización",
      },
    ],
  },
  {
    id: "createUser",
    method: "POST",
    path: "/users",
    tag: "Usuarios",
    labels: [],
    summary: "Crea un usuario",
    implemented: false,
    responseShape: "{ data }",
    scenarios: [
      {
        id: "created",
        name: "Crea",
        description: "Alta",
        expectedStatus: 201,
        flow: "happy",
        requestPath: "/users",
        body: { name: "Ada" },
        budget: null,
        runnable: true,
      },
    ],
  },
  {
    id: "health",
    method: "GET",
    path: "/health",
    tag: "",
    labels: [],
    summary: "",
    implemented: true,
    responseShape: "{}",
    scenarios: [],
  },
];

const scenarios = (blocked = 1): ScenariosView => ({
  specVersionId: "v1",
  contractVersion: "1.0.0",
  environment: null,
  operations,
  queue: [],
  totals: { operations: 3, cases: 3, runnable: 2, blocked },
});

const coverage = (gaps: boolean): CoverageView => ({
  specVersionId: "v1",
  contractVersion: "1.0.0",
  totals: { operations: 3, declaredResponses: 4, covered: gaps ? 3 : 4, uncovered: gaps ? 1 : 0, cases: 3 },
  byStatus: [],
  gaps: gaps ? [{ operationId: "health", method: "GET", path: "/health", tag: "", status: 503 }] : [],
});

type Handlers = {
  environments?: Environment[];
  scenarios?: () => Promise<unknown>;
  /** `null`: the coverage cannot be computed. */
  coverage?: CoverageView | null;
  run?: () => Promise<unknown>;
};

function draw(handlers: Handlers = {}) {
  call.mockImplementation((path: string, options?: { method?: string }) => {
    if (options?.method === "POST" && path.endsWith("/runs"))
      return (handlers.run ?? (() => Promise.resolve({ runId: "r9" })))();
    if (options?.method === "POST") return Promise.resolve(undefined);
    if (path.endsWith("/environments")) return Promise.resolve(handlers.environments ?? []);
    if (path.includes("/scenarios")) return (handlers.scenarios ?? (() => Promise.resolve(scenarios())))();
    if (path.endsWith("/coverage"))
      return handlers.coverage === null
        ? Promise.reject(new Error("sin cobertura"))
        : Promise.resolve(handlers.coverage ?? coverage(true));
    return Promise.reject(new Error(`inesperado ${path}`));
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={["/p/p1/matrix"]}>
        <Routes>
          <Route path="/p/:projectId/matrix" element={<MatrixPage />} />
          <Route path="/p/:projectId/config" element={<p>pantalla de configuración</p>} />
          <Route path="/p/:projectId/runs/:runId" element={<p>corrida abierta</p>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

/** Waits for the matrix drawn against the preselected environment: choosing one is a new query. */
async function settledOn(environmentId: string) {
  await waitFor(() =>
    expect(call).toHaveBeenCalledWith(`/orgs/o/projects/p1/scenarios?order=safe&environmentId=${environmentId}`),
  );
  await screen.findByText("Lista los pedidos");
}

const runButton = () => screen.getByRole("button", { name: /^Ejecutar/ }) as HTMLButtonElement;

beforeEach(() => {
  call.mockReset();
  can.editor = true;
});

describe("MatrixPage", () => {
  test("mientras carga lo dice", () => {
    draw({ scenarios: () => new Promise(() => {}) });
    expect(screen.getByText("Cargando la matriz…")).toBeTruthy();
  });

  test("sin contrato explica qué falta y lleva a configuración", async () => {
    draw({
      scenarios: () =>
        Promise.reject(
          new ApiError(404, { type: "about:blank", title: "Not Found", status: 404, detail: "sin contrato" }),
        ),
    });
    expect(await screen.findByText("Este proyecto todavía no tiene contrato")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Ir a configuración" }));
    expect(await screen.findByText("pantalla de configuración")).toBeTruthy();
  });

  test("enseña totales, bloqueados, la cobertura con sus huecos y el detalle del primer caso", async () => {
    draw({ environments: [environment({ id: "e1", name: "staging" })] });
    expect(await screen.findByText("1 no se ejecutarán en este entorno")).toBeTruthy();
    const covered = await screen.findByText(/3\/4 respuestas del contrato con/);
    expect(covered.getAttribute("title")).toBe("503 · GET /health");
    expect(covered.className).toContain("amber");

    // La primera operación visible está abierta, con su primer caso.
    expect(screen.getByText("Lista los pedidos")).toBeTruthy();
    expect(screen.getByText("{ data, meta }")).toBeTruthy();
    expect(screen.getByText("GET /orders?page=1")).toBeTruthy();
    expect(screen.getByText("primary")).toBeTruthy();
    expect(screen.getByText("300 ms (p95)")).toBeTruthy();
    // La operación sin ruta todavía está pendiente, no en rojo.
    expect(screen.getByText("pendiente")).toBeTruthy();
    // Orden seguro explicado.
    expect(screen.getByText(/GET, POST, PUT, PATCH y por último DELETE/)).toBeTruthy();
  });

  test("un caso bloqueado dice por qué y un caso sin presupuesto no afirma nada", async () => {
    draw();
    fireEvent.click(await screen.findByText("Sin credencial"));
    expect(screen.getByText("El entorno no aplica autorización")).toBeTruthy();
    expect(screen.getByText("Sin presupuesto publicado: no se afirma nada sobre la latencia")).toBeTruthy();
  });

  test("elegir otra operación enseña su cuerpo, y una sin casos lo dice", async () => {
    draw();
    fireEvent.click(await screen.findByText("/users"));
    expect(screen.getByText("Crea un usuario")).toBeTruthy();
    expect(screen.getByText(/"Ada"/)).toBeTruthy();

    fireEvent.click(screen.getByText("/health"));
    expect(screen.getByText("Esta operación no genera casos.")).toBeTruthy();
  });

  test("la cobertura completa se pinta en verde y explica que no hay huecos", async () => {
    draw({ coverage: coverage(false), scenarios: () => Promise.resolve(scenarios(0)) });
    const covered = await screen.findByText(/4\/4 respuestas del contrato con/);
    expect(covered.getAttribute("title")).toBe("todas las respuestas declaradas tienen caso");
    expect(covered.className).toContain("emerald");
    expect(screen.queryByText(/no se ejecutarán en este entorno/)).toBeNull();
  });

  test("sin entorno no se puede ejecutar; se parte del activo y se pide con su id", async () => {
    draw({
      environments: [environment({ id: "e1", name: "staging" }), environment({ id: "e2", name: "prod", active: true })],
    });
    await screen.findByText("Lista los pedidos");
    await waitFor(() => expect(call).toHaveBeenCalledWith("/orgs/o/projects/p1/scenarios?order=safe&environmentId=e2"));
    expect(runButton().disabled).toBe(false);
    expect(runButton().textContent).toContain("Ejecutar todo · 3 casos");

    fireEvent.change(screen.getByLabelText("Entorno"), { target: { value: "" } });
    await waitFor(() => expect(runButton().disabled).toBe(true));
    expect(runButton().getAttribute("title")).toBe("Elige un entorno para ejecutar");
  });

  test("elegir un entorno lo activa y el orden cambia la consulta", async () => {
    draw({
      environments: [environment({ id: "e1", name: "staging" }), environment({ id: "e2", name: "prod", active: true })],
    });
    await screen.findByText("Lista los pedidos");
    await waitFor(() => expect((screen.getByLabelText("Entorno") as HTMLSelectElement).value).toBe("e2"));
    fireEvent.change(screen.getByLabelText("Entorno"), { target: { value: "e1" } });
    await waitFor(() =>
      expect(call).toHaveBeenCalledWith("/orgs/o/projects/p1/environments/e1/activate", { method: "POST" }),
    );

    fireEvent.change(screen.getByLabelText("Orden"), { target: { value: "contract" } });
    await waitFor(() =>
      expect(call).toHaveBeenCalledWith("/orgs/o/projects/p1/scenarios?order=contract&environmentId=e1"),
    );
    await waitFor(() => expect(screen.queryByText(/GET, POST, PUT, PATCH y por último DELETE/)).toBeNull());
  });

  test("filtra por búsqueda y por etiqueta del contrato", async () => {
    draw();
    await screen.findByText("Lista los pedidos");
    fireEvent.change(screen.getByPlaceholderText("Buscar operación"), { target: { value: "usuario" } });
    expect(screen.queryByLabelText("Seleccionar listOrders")).toBeNull();
    expect(screen.getByLabelText("Seleccionar createUser")).toBeTruthy();

    fireEvent.change(screen.getByPlaceholderText("Buscar operación"), { target: { value: "" } });
    const tagSelect = screen.getByLabelText("Etiqueta del contrato") as HTMLSelectElement;
    expect([...tagSelect.options].map((option) => option.value)).toEqual(["Todos", "Pedidos", "Usuarios"]);
    fireEvent.change(tagSelect, { target: { value: "Pedidos" } });
    expect(screen.getByLabelText("Seleccionar listOrders")).toBeTruthy();
    expect(screen.queryByLabelText("Seleccionar createUser")).toBeNull();
    expect(screen.queryByLabelText("Seleccionar health")).toBeNull();
  });

  test("ejecutar una selección manda sus ids y abre la corrida", async () => {
    draw({ environments: [environment({ id: "e1", active: true })] });
    await screen.findByText("Lista los pedidos");
    await waitFor(() => expect(runButton().disabled).toBe(false));

    fireEvent.click(screen.getByLabelText("Seleccionar listOrders"));
    fireEvent.click(screen.getByLabelText("Seleccionar createUser"));
    fireEvent.click(screen.getByLabelText("Seleccionar createUser"));
    expect(runButton().textContent).toContain("Ejecutar 1 operaciones · 2 casos");
    fireEvent.click(runButton());

    await waitFor(() =>
      expect(call).toHaveBeenCalledWith("/orgs/o/projects/p1/runs", {
        method: "POST",
        body: { environmentId: "e1", order: "safe", operationIds: ["listOrders"] },
      }),
    );
    expect(await screen.findByText("corrida abierta")).toBeTruthy();
  });

  test("la etiqueta propia filtra y viaja como filtro, no como ids", async () => {
    draw({ environments: [environment({ id: "e1", active: true })] });
    await settledOn("e1");
    const labelSelect = screen.getByLabelText("Etiqueta propia") as HTMLSelectElement;
    expect([...labelSelect.options].map((option) => option.value)).toEqual(["Todas", "crítico"]);
    fireEvent.change(labelSelect, { target: { value: "crítico" } });
    expect(screen.queryByLabelText("Seleccionar createUser")).toBeNull();

    await waitFor(() => expect(runButton().disabled).toBe(false));
    fireEvent.click(runButton());
    await waitFor(() =>
      expect(call).toHaveBeenCalledWith("/orgs/o/projects/p1/runs", {
        method: "POST",
        body: { environmentId: "e1", order: "safe", labels: ["crítico"] },
      }),
    );
  });

  test("si la corrida no arranca se enseña el error", async () => {
    draw({
      environments: [environment({ id: "e1", active: true })],
      run: () => Promise.reject(new Error("ya hay una corrida")),
    });
    await screen.findByText("Lista los pedidos");
    await waitFor(() => expect(runButton().disabled).toBe(false));
    fireEvent.click(runButton());
    expect(await screen.findByText("ya hay una corrida")).toBeTruthy();
  });

  test("sin permiso de edición no hay botón de ejecutar", async () => {
    can.editor = false;
    draw({ environments: [environment({ id: "e1", active: true })] });
    await settledOn("e1");
    expect(screen.queryByRole("button", { name: /^Ejecutar/ })).toBeNull();
    // Y el entorno se elige para ver, sin activarlo para todos.
    fireEvent.change(screen.getByLabelText(/^Entorno/), { target: { value: "" } });
    await waitFor(() => expect(call).toHaveBeenCalledWith("/orgs/o/projects/p1/scenarios?order=safe"));
    expect(call).not.toHaveBeenCalledWith(expect.stringContaining("/activate"), expect.anything());
  });

  test("cambiar el orden deja la matriz anterior a la vista mientras llega la nueva", async () => {
    let pending = false;
    draw({ scenarios: () => (pending ? new Promise(() => {}) : Promise.resolve(scenarios())) });
    await screen.findByText("Lista los pedidos");
    pending = true;
    fireEvent.change(screen.getByLabelText("Orden"), { target: { value: "contract" } });
    await waitFor(() => expect(call).toHaveBeenCalledWith("/orgs/o/projects/p1/scenarios?order=contract"));
    expect(screen.queryByText("Cargando la matriz…")).toBeNull();
    expect(screen.getByText("Lista los pedidos")).toBeTruthy();
    expect((screen.getByLabelText("Orden") as HTMLSelectElement).value).toBe("contract");
  });

  test("sin cobertura calculada no la afirma, y una operación sin etiquetas propias no pasa ese filtro", async () => {
    const [orders, users, health] = operations;
    const { labels: _labels, ...unlabelled } = users;
    draw({
      coverage: null,
      scenarios: () =>
        Promise.resolve({ ...scenarios(), operations: [orders, unlabelled as OperationScenarios, health] }),
    });
    await screen.findByText("Lista los pedidos");
    await waitFor(() => expect(call).toHaveBeenCalledWith("/orgs/o/projects/p1/coverage"));
    expect(screen.queryByText(/respuestas del contrato con/)).toBeNull();
    expect(screen.getByLabelText("Seleccionar createUser")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Etiqueta propia"), { target: { value: "crítico" } });
    expect(screen.queryByLabelText("Seleccionar createUser")).toBeNull();
    expect(screen.getByLabelText("Seleccionar listOrders")).toBeTruthy();
  });
});
