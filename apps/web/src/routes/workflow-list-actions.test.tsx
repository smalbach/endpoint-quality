/**
 * Lo que se hace desde la lista de flujos, que antes vivía en el cajón del editor.
 *
 * - **Crear un flujo lo abre** en su lienzo; cancelar no escribe nada.
 * - **Renombrar, duplicar, exportar, cambiar de estado e importar** van por fila, y el mismo nombre
 *   no escribe.
 * - **Cada error se dice** encima de la lista.
 * - **Las suites** se crean, se editan, se borran y se ejecutan con el entorno elegido, que empieza
 *   siendo el activo del proyecto; la corrida se lee en su propia página.
 * - **Buscar y filtrar** por estado, nombre o descripción; sin coincidencias, se dice.
 * - **Quien sólo mira** abre lienzos, nada más.
 */
import { afterEach, describe, expect, test, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes, useParams } from "react-router-dom";

import { WorkflowListPage } from "@/routes/workflow-list";
import type { Environment, SuiteView, WorkflowStepView, WorkflowView, WorkflowsView } from "@/lib/types";

const mocks = vi.hoisted(() => ({
  call: vi.fn(),
  download: vi.fn(),
  openImport: vi.fn(),
  canEdit: { value: true },
}));
vi.mock("@/lib/api", async (original) => ({ ...(await original<object>()), api: mocks.call }));
vi.mock("@/lib/auth", () => ({
  useOrganization: () => ({ id: "o", name: "Org" }),
  useCan: () => mocks.canEdit.value,
}));
vi.mock("@/components/import-provider", () => ({ useImport: () => ({ open: mocks.openImport }) }));
vi.mock("@/lib/project-bundle", async (original) => ({ ...(await original<object>()), downloadJson: mocks.download }));

const BASE = "/orgs/o/projects/p1";

const step = (id: string, patch: Partial<WorkflowStepView> = {}) => ({ id, ...patch }) as WorkflowStepView;
const flow = (id: string, name: string, patch: Partial<WorkflowView> = {}): WorkflowView =>
  ({
    id,
    name,
    description: null,
    status: "ready",
    steps: [],
    updatedAt: "2026-09-01T00:00:00.000Z",
    ...patch,
  }) as WorkflowView;

const environments = [
  { id: "e1", name: "local", active: false },
  { id: "e2", name: "staging", active: true },
] as Environment[];

type Server = {
  workflows: WorkflowView[];
  suites: SuiteView[];
  environments: Environment[];
  fail: Record<string, Error>;
  pending: Set<string>;
};
let server: Server;

function serve(patch: Partial<Server> = {}) {
  server = {
    workflows: [
      flow("w1", "Pedidos", {
        description: "Alta y baja de pedido",
        steps: [
          step("a"),
          step("b", { kind: "request" }),
          step("c", { kind: "branch" }),
          step("d", { kind: "subflow", subflow: { workflowId: "w2" } } as never),
        ],
      }),
      flow("w2", "Login", { status: "draft", steps: [step("x", { kind: "request" })] }),
      flow("w3", "Viejo", { status: "archived" }),
    ],
    suites: [
      { id: "su1", name: "Antes de publicar", description: null, workflowIds: ["w1"], updatedAt: "" } as SuiteView,
    ],
    environments,
    fail: {},
    pending: new Set(),
    ...patch,
  };
  mocks.call.mockReset();
  mocks.call.mockImplementation((path: string, options?: { method?: string; body?: unknown }) => {
    const method = options?.method ?? "GET";
    const key = `${method} ${path.slice(BASE.length)}`;
    if (server.fail[key]) return Promise.reject(server.fail[key]);
    if (server.pending.has(key)) return new Promise(() => {});
    if (key === "GET /workflows")
      return Promise.resolve({
        workflows: server.workflows,
        suites: server.suites,
        requestTemplates: [],
        datasets: [],
      } as unknown as WorkflowsView);
    if (key === "GET /environments") return Promise.resolve(server.environments);
    if (key === "POST /workflows") return Promise.resolve({ workflowId: "nuevo" });
    if (key === "POST /workflows/w1/duplicate") return Promise.resolve({ workflowId: "w9" });
    if (key.startsWith("GET /export")) return Promise.resolve({ bundle: true });
    if (key === "POST /suites") return Promise.resolve({ suiteId: "su2" });
    if (key === "POST /runs") return Promise.resolve({ runId: "run-1" });
    return Promise.resolve(undefined);
  });
}

const calls = (method: string, suffix: string) =>
  mocks.call.mock.calls
    .filter(([path, options]) => (options?.method ?? "GET") === method && path === `${BASE}${suffix}`)
    .map(([, options]) => options as { body?: unknown } | undefined);

function draw() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const Opened = () => <p>lienzo de {useParams().workflowId}</p>;
  const Run = () => <p>corrida {useParams().runId}</p>;
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={["/p/p1/workflows"]}>
        <Routes>
          <Route path="/p/:projectId/workflows" element={<WorkflowListPage projectId="p1" />} />
          <Route path="/p/:projectId/workflows/:workflowId" element={<Opened />} />
          <Route path="/p/:projectId/runs/:runId" element={<Run />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const row = (name: string) =>
  screen.getAllByRole("listitem").find((item) => item.querySelector("a.min-w-0")?.textContent?.startsWith(name))!;
const ready = async () => {
  draw();
  await screen.findByText("Pedidos");
};

afterEach(() => {
  mocks.canEdit.value = true;
  mocks.download.mockReset();
  mocks.openImport.mockReset();
});

describe("la lista de flujos: estados", () => {
  test("mientras carga lo dice", () => {
    serve();
    server.pending.add("GET /workflows");
    draw();
    expect(screen.getByText("Cargando flujos…")).toBeTruthy();
  });

  test("sin flujos invita a crear el primero, y crearlo lo abre", async () => {
    serve({ workflows: [], suites: [] });
    draw();
    expect(await screen.findByText("Crea tu primer flujo")).toBeTruthy();
    fireEvent.click(screen.getAllByRole("button", { name: "+ Nuevo flujo" }).at(-1)!);
    const dialog = await screen.findByRole("dialog", { name: "Nuevo flujo" });
    fireEvent.change(within(dialog).getByRole("textbox"), { target: { value: "Alta de pedido" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Crear" }));
    expect(await screen.findByText("lienzo de nuevo")).toBeTruthy();
    expect(calls("POST", "/workflows")[0]!.body).toEqual({ name: "Alta de pedido" });
  });

  test("cada fila dice de qué está hecho el flujo, con su descripción", async () => {
    serve();
    await ready();
    const pedidos = row("Pedidos");
    expect(within(pedidos).getByText("Alta y baja de pedido")).toBeTruthy();
    // Un paso sin tipo es una petición.
    expect(within(pedidos).getByText("2 peticiones · 1 branch · 1 sub-flujo · Listo", { exact: false })).toBeTruthy();
    expect(within(row("Login")).getByText("1 petición · Borrador", { exact: false })).toBeTruthy();
    expect(within(pedidos).getByText("Antes de publicar")).toBeTruthy();

    // El árbol de sub-flujos se pliega y se despliega.
    const toggle = within(pedidos).getByRole("button", { name: /Sub-flujos \(1\)/ });
    expect(toggle.textContent).toContain("▾");
    expect(within(pedidos).getAllByText("Login")).toHaveLength(1);
    fireEvent.click(toggle);
    expect(toggle.textContent).toContain("▸");
    expect(within(pedidos).queryAllByText("Login")).toHaveLength(0);
  });

  test("buscar por nombre o descripción, filtrar por estado, y sin coincidencias lo dice", async () => {
    serve();
    await ready();
    fireEvent.change(screen.getByPlaceholderText("Buscar flujo…"), { target: { value: "baja" } });
    expect(screen.getByText("Pedidos")).toBeTruthy();
    expect(screen.queryByText("Login", { selector: "span.block" })).toBeNull();
    fireEvent.change(screen.getByPlaceholderText("Buscar flujo…"), { target: { value: "LOGIN" } });
    expect(row("Login")).toBeTruthy();
    fireEvent.change(screen.getByPlaceholderText("Buscar flujo…"), { target: { value: "nada de esto" } });
    expect(screen.getByText("Ningún flujo coincide.")).toBeTruthy();

    fireEvent.change(screen.getByPlaceholderText("Buscar flujo…"), { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: /Borradores/ }));
    expect(row("Login")).toBeTruthy();
    expect(screen.queryByText("Pedidos", { selector: "span.block" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Listos/ }));
    expect(row("Pedidos")).toBeTruthy();
    expect(screen.getByRole("button", { name: /Activos/ }).textContent).toContain("2");
  });

  test("el árbol marca los ciclos, los archivados y los sub-flujos borrados", async () => {
    serve({
      workflows: [
        flow("w1", "Raíz", {
          steps: [
            step("a", { kind: "subflow", subflow: { workflowId: "w2" } } as never),
            step("b", { kind: "subflow", subflow: { workflowId: "borrado-123456789" } } as never),
          ],
        }),
        flow("w2", "Archivado", {
          status: "archived",
          steps: [step("c", { kind: "subflow", subflow: { workflowId: "w1" } } as never)],
        }),
      ],
      suites: [],
    });
    draw();
    const root = await waitFor(() => row("Raíz"));
    expect(within(root).getByText("archivado")).toBeTruthy();
    expect(within(root).getByText("ciclo")).toBeTruthy();
    expect(within(root).getByText("Sub-flujo borrado (borrado-)")).toBeTruthy();
  });
});

describe("la lista de flujos: acciones por fila", () => {
  test("renombrar (el mismo nombre no escribe, cancelar tampoco), cambiar de estado, exportar e importar", async () => {
    serve();
    await ready();
    const pedidos = row("Pedidos");

    fireEvent.click(within(pedidos).getByRole("button", { name: "Renombrar" }));
    let dialog = await screen.findByRole("dialog", { name: "Renombrar flujo" });
    const input = within(dialog).getByRole("textbox") as HTMLInputElement;
    expect(input.value).toBe("Pedidos");
    fireEvent.change(input, { target: { value: "Pedidos de alta" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Crear" }));
    await waitFor(() => expect(calls("PUT", "/workflows/w1")[0]!.body).toEqual({ name: "Pedidos de alta" }));

    fireEvent.click(within(pedidos).getByRole("button", { name: "Renombrar" }));
    dialog = await screen.findByRole("dialog", { name: "Renombrar flujo" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Crear" }));
    fireEvent.click(within(pedidos).getByRole("button", { name: "Renombrar" }));
    dialog = await screen.findByRole("dialog", { name: "Renombrar flujo" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancelar" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(calls("PUT", "/workflows/w1")).toHaveLength(1);

    fireEvent.change(within(pedidos).getByTitle("Estado del flujo"), { target: { value: "archived" } });
    await waitFor(() => expect(calls("PUT", "/workflows/w1")[1]!.body).toEqual({ status: "archived" }));

    fireEvent.click(within(pedidos).getByRole("button", { name: "Exportar" }));
    await waitFor(() => expect(mocks.download).toHaveBeenCalledTimes(1));
    expect(calls("GET", "/export?parts=flows,contract&workflowIds=w1")).toHaveLength(1);
    expect(mocks.download.mock.calls[0]![0]).toMatch(/^pedidos-\d{4}-\d{2}-\d{2}\.eq\.json$/);
    expect(mocks.download.mock.calls[0]![1]).toEqual({ bundle: true });

    fireEvent.click(screen.getByRole("button", { name: "Importar" }));
    expect(mocks.openImport).toHaveBeenCalled();
  });

  test("duplicar pide la copia y vuelve a pedir la lista", async () => {
    serve();
    await ready();
    const lists = calls("GET", "/workflows").length;
    fireEvent.click(within(row("Pedidos")).getByRole("button", { name: "Duplicar" }));
    await waitFor(() => expect(calls("POST", "/workflows/w1/duplicate")).toHaveLength(1));
    await waitFor(() => expect(calls("GET", "/workflows").length).toBeGreaterThan(lists));
  });

  test("cancelar el nuevo flujo no escribe nada", async () => {
    serve();
    await ready();
    fireEvent.click(screen.getByRole("button", { name: "+ Nuevo flujo" }));
    const dialog = await screen.findByRole("dialog", { name: "Nuevo flujo" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancelar" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(calls("POST", "/workflows")).toHaveLength(0);
  });

  test.each([
    ["crear", "POST /workflows", "No se pudo crear"],
    ["duplicar", "POST /workflows/w1/duplicate", "No se pudo duplicar"],
    ["exportar", "GET /export?parts=flows,contract&workflowIds=w1", "No se pudo exportar"],
    ["cambiar de estado", "PUT /workflows/w1", "No se pudo guardar"],
    ["ejecutar una suite", "POST /runs", "El entorno no admite escrituras"],
  ])("un fallo al %s se dice encima de la lista", async (action, key, detail) => {
    serve();
    server.fail[key] = new Error(detail);
    await ready();
    const pedidos = row("Pedidos");
    if (action === "crear") {
      fireEvent.click(screen.getByRole("button", { name: "+ Nuevo flujo" }));
      const dialog = await screen.findByRole("dialog", { name: "Nuevo flujo" });
      fireEvent.change(within(dialog).getByRole("textbox"), { target: { value: "X" } });
      fireEvent.click(within(dialog).getByRole("button", { name: "Crear" }));
    } else if (action === "duplicar") fireEvent.click(within(pedidos).getByRole("button", { name: "Duplicar" }));
    else if (action === "exportar") fireEvent.click(within(pedidos).getByRole("button", { name: "Exportar" }));
    else if (action === "cambiar de estado")
      fireEvent.change(within(pedidos).getByTitle("Estado del flujo"), { target: { value: "draft" } });
    else {
      fireEvent.click(screen.getByRole("button", { name: /Antes de publicar/ }));
      fireEvent.click(screen.getByRole("button", { name: "Ejecutar" }));
    }
    expect(await screen.findByText(detail)).toBeTruthy();
  });

  test("quien sólo mira abre lienzos, nada más", async () => {
    mocks.canEdit.value = false;
    serve();
    await ready();
    expect(screen.queryByRole("button", { name: "+ Nuevo flujo" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Importar" })).toBeNull();
    expect(within(row("Pedidos")).queryByRole("button", { name: "Renombrar" })).toBeNull();
    fireEvent.click(within(row("Pedidos")).getByRole("link", { name: "Abrir lienzo" }));
    expect(screen.getByText("lienzo de w1")).toBeTruthy();
  });

  test("sin flujos y sin permiso, el vacío no ofrece crear", async () => {
    mocks.canEdit.value = false;
    serve({ workflows: [], suites: [] });
    draw();
    expect(await screen.findByText("Crea tu primer flujo")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "+ Nuevo flujo" })).toBeNull();
  });
});

describe("la lista de flujos: suites", () => {
  test("empiezan con el entorno activo; se crean, se editan, se borran y se ejecutan", async () => {
    serve();
    await ready();
    const environment = screen.getByDisplayValue("staging") as HTMLSelectElement;
    expect(environment.value).toBe("e2");

    fireEvent.click(screen.getByRole("button", { name: "+ Nueva" }));
    const dialog = await screen.findByRole("dialog", { name: "Nueva suite" });
    fireEvent.change(within(dialog).getByRole("textbox"), { target: { value: "Humo" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Crear" }));
    await waitFor(() => expect(calls("POST", "/suites")[0]!.body).toEqual({ name: "Humo" }));

    fireEvent.click(screen.getByRole("button", { name: /Antes de publicar/ }));
    fireEvent.change(screen.getByDisplayValue("Añadir flujo…"), { target: { value: "w2" } });
    await waitFor(() => expect(calls("PUT", "/suites/su1")[0]!.body).toEqual({ workflowIds: ["w1", "w2"] }));

    // Eliminar pregunta antes, y el diálogo es donde se confirma.
    fireEvent.click(screen.getByRole("button", { name: "Eliminar" }));
    fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Eliminar" }));
    await waitFor(() => expect(calls("DELETE", "/suites/su1")).toHaveLength(1));

    // Elegir otro entorno lo activa en el proyecto, y la suite corre en él.
    fireEvent.change(environment, { target: { value: "e1" } });
    await waitFor(() => expect(calls("POST", "/environments/e1/activate")).toHaveLength(1));
    fireEvent.click(screen.getByRole("button", { name: "Ejecutar" }));
    expect(await screen.findByText("corrida run-1")).toBeTruthy();
    expect(calls("POST", "/runs")[0]!.body).toEqual({ environmentId: "e1", suiteId: "su1" });
  });

  test("mientras llegan los entornos, el selector sólo ofrece «Entorno…»", async () => {
    serve();
    server.pending.add("GET /environments");
    await ready();
    const environment = screen.getByDisplayValue("Entorno…") as HTMLSelectElement;
    expect(Array.from(environment.options).map((option) => option.textContent)).toEqual(["Entorno…"]);
  });

  test("sin entorno elegido no se ejecuta ninguna suite", async () => {
    serve({ environments: environments.map((item) => ({ ...item, active: false })) });
    await ready();
    const environment = screen.getByDisplayValue("Entorno…") as HTMLSelectElement;
    expect(environment.value).toBe("");
    fireEvent.click(screen.getByRole("button", { name: /Antes de publicar/ }));
    expect((screen.getByRole("button", { name: "Ejecutar" }) as HTMLButtonElement).disabled).toBe(true);
    // Volver a «Entorno…» no activa nada.
    fireEvent.change(environment, { target: { value: "e1" } });
    fireEvent.change(environment, { target: { value: "" } });
    await waitFor(() => expect(calls("POST", "/environments/e1/activate")).toHaveLength(1));
    expect(mocks.call.mock.calls.filter(([path]) => String(path).endsWith("/activate"))).toHaveLength(1);
  });
});
