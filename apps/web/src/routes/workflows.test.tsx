/**
 * El editor de un flujo (`workflows/:workflowId`): el lienzo, sus cajones y el lanzamiento en el sitio.
 *
 * Lo que decide algo:
 *
 * - **Guardar escribe primero las peticiones que cambiaron y luego el grafo**, y sólo se puede con
 *   cambios y sin problemas en el flujo. Una petición editada que quedó igual no se manda.
 * - **Ejecutar lanza con el entorno, el flujo, los datos y los ajustes de ejecución**, y la corrida
 *   se sigue encima del lienzo sin irse a otra pantalla; en pausa se reanuda desde la barra.
 * - **Una parada sin nodos no deja lanzar**.
 * - **La vista JSON y el lienzo son el mismo documento**: un JSON roto no se aplica y se dice por qué.
 * - **Cada cajón escribe lo que dice**: biblioteca (una operación del contrato es un nodo de un
 *   toque; un login lo marca), datos (el conjunto elegido viaja con la corrida y se suelta al borrarlo).
 * - **Quien sólo mira no ve lo que escribe.**
 * - **La dirección manda**: sin id es la lista; un id que no existe lo dice y lleva de vuelta; otro id
 *   abre el editor desde cero; volver con cambios sin guardar pregunta antes.
 *
 * El lienzo (React Flow) y el inspector son componentes de miles de líneas con sus propias pruebas;
 * aquí se sustituyen por dobles que enseñan lo que reciben y llaman a lo que se les da, y la lista
 * (con sus propias pruebas) por un rótulo. El resto —cajones, diálogos, biblioteca, datos, ajustes y
 * el progreso en vivo— es el real.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes, useNavigate } from "react-router-dom";

import { WorkflowsPage } from "@/routes/workflows";
import type {
  Environment,
  RequestTemplateView,
  RunView,
  WorkflowStepView,
  WorkflowView,
  WorkflowsView,
} from "@/lib/types";

type StreamHandlers = { onEvent: (event: { type: string; data: unknown }) => void; signal: AbortSignal };
type Options = { method?: string; body?: unknown };

const mocks = vi.hoisted(() => ({
  call: vi.fn(),
  stream: vi.fn(),
  canEdit: { value: true },
}));
vi.mock("@/lib/api", async (original) => ({
  ...(await original<object>()),
  api: mocks.call,
  streamRun: mocks.stream,
}));
vi.mock("@/lib/auth", () => ({
  useOrganization: () => ({ id: "o", name: "Org" }),
  useCan: () => mocks.canEdit.value,
}));
vi.mock("@/routes/workflow-list", () => ({
  WorkflowListPage: ({ projectId }: { projectId: string }) => <p>lista de flujos de {projectId}</p>,
}));

type CanvasProps = {
  flowId: string;
  steps: WorkflowStepView[];
  onChange: (steps: WorkflowStepView[]) => void;
  onSelect: (stepId: string) => void;
  onAddRequest?: (at?: { x: number; y: number }) => void;
  onAddLogin?: (at?: { x: number; y: number }) => void;
  runStatus: Record<string, string>;
  pausedStepId: string | null;
  breakpoints: string[];
  onToggleBreakpoint: (stepId: string) => void;
};
vi.mock("@/components/workflow-canvas", () => ({
  WorkflowCanvas: (props: CanvasProps) => (
    <div data-testid="canvas">
      <p data-testid="canvas-steps">
        {props.steps.map((step) => `${step.id}${step.kind ? `:${step.kind}` : ""}`).join(",")}
      </p>
      <p data-testid="canvas-status">{JSON.stringify(props.runStatus)}</p>
      <p data-testid="canvas-paused">{props.pausedStepId ?? "-"}</p>
      <p data-testid="canvas-breakpoints">{props.breakpoints.join(",")}</p>
      <button onClick={() => props.onSelect("s1")}>lienzo: abrir s1</button>
      <button onClick={() => props.onToggleBreakpoint("s1")}>lienzo: parada en s1</button>
      <button
        onClick={() =>
          props.onChange([
            ...props.steps.slice(0, 1),
            { ...props.steps[1]!, dependsOn: ["zz"] },
            ...props.steps.slice(2),
          ])
        }
      >
        lienzo: romper
      </button>
      {props.onAddRequest && <button onClick={() => props.onAddRequest!({ x: 5, y: 6 })}>lienzo: + petición</button>}
      {props.onAddLogin && <button onClick={() => props.onAddLogin!()}>lienzo: + login</button>}
    </div>
  ),
}));

type InspectorProps = {
  selectedStep: string;
  steps: WorkflowStepView[];
  templates: RequestTemplateView[];
  environmentId: string;
  runSummary: string | null;
  running: boolean;
  onEnvironment: (id: string) => void;
  onWorkflow: (change: Partial<WorkflowView>) => void;
  onTemplate: (template: RequestTemplateView) => void;
  templateUsage: (templateId: string) => number;
  onFork: (step: WorkflowStepView, overrides?: Partial<RequestTemplateView>) => void;
  onRunSettings: () => void;
  onRun: () => void;
  onDelete: () => void;
};
vi.mock("@/components/workflow-inspector", () => ({
  WorkflowInspector: (props: InspectorProps) => (
    <div data-testid="inspector">
      <p>inspector: {props.selectedStep || "flujo"}</p>
      <p>usos de t1: {props.templateUsage("t1")}</p>
      <p>entorno: {props.environmentId}</p>
      <button onClick={() => props.onWorkflow({ name: "Pedidos v2" })}>inspector: renombrar</button>
      <button onClick={() => props.onTemplate({ ...props.templates[0]!, expectedStatus: 202 })}>
        inspector: editar t1
      </button>
      <button onClick={() => props.onTemplate({ ...props.templates[0]! })}>inspector: tocar t1</button>
      <button onClick={() => props.onFork(props.steps[1]!, { operationId: "op2" })}>inspector: independizar s2</button>
      <button onClick={() => props.onFork(props.steps[0]!)}>inspector: independizar s1</button>
      <button onClick={() => props.onFork({ id: "b", kind: "branch" })}>inspector: independizar rama</button>
      <button onClick={() => props.onEnvironment("e2")}>inspector: entorno e2</button>
      <button onClick={props.onRunSettings}>inspector: ajustes</button>
      <button onClick={props.onRun}>inspector: ejecutar</button>
      <button onClick={props.onDelete}>inspector: borrar</button>
    </div>
  ),
}));

// ---------------------------------------------------------------------------------------------

const template = (patch: Partial<RequestTemplateView> & { id: string; name: string }): RequestTemplateView => ({
  operationId: "op1",
  description: null,
  expectedStatus: 201,
  parameters: {},
  disabledParameters: {},
  headers: {},
  disabledHeaders: {},
  body: { type: "none" },
  auth: "default",
  updatedAt: "2026-03-01T10:00:00.000Z",
  ...patch,
});

const flow = (patch: Partial<WorkflowView> & { id: string; name: string }): WorkflowView => ({
  description: null,
  status: "draft",
  steps: [],
  updatedAt: "2026-03-01T10:00:00.000Z",
  deletedAt: null,
  ...patch,
});

const environment = (id: string, name: string, active: boolean) =>
  ({
    id,
    name,
    active,
    baseUrl: "http://x",
    specUrl: null,
    variables: {},
    disabledVariables: {},
    writesAllowed: true,
  }) as unknown as Environment;

type Server = {
  view: WorkflowsView;
  environments: Environment[];
  run: RunView;
  fail: Record<string, Error>;
};

let server: Server;

function freshServer(): Server {
  return {
    view: {
      requestTemplates: [template({ id: "t1", name: "Crear pedido" })],
      workflows: [
        flow({
          id: "w1",
          name: "Pedidos",
          steps: [
            { id: "s1", requestTemplateId: "t1" },
            { id: "s2", requestTemplateId: "t1", dependsOn: ["s1"] },
          ],
        }),
        flow({ id: "w2", name: "Viejo", status: "archived" }),
        flow({ id: "w3", name: "Pagos", status: "ready", steps: [{ id: "p1", requestTemplateId: "t1" }] }),
      ],
      datasets: [
        {
          id: "d1",
          workflowId: "w1",
          name: "clientes",
          columns: ["email"],
          rowCount: 2,
          updatedAt: "2026-03-01",
          archivedAt: null,
          deletedAt: null,
        },
      ],
      suites: [
        {
          id: "su1",
          name: "Antes de publicar",
          description: null,
          workflowIds: ["w1"],
          updatedAt: "2026-03-01",
          archivedAt: null,
          deletedAt: null,
        },
      ],
    },
    environments: [environment("e1", "staging", true), environment("e2", "prod", false)],
    run: {
      id: "run-1",
      projectId: "p",
      environmentId: "e1",
      status: "running",
      totals: { cases: 2, completed: 0, passed: 0, failed: 0, skipped: 0 },
      source: { kind: "workflow", workflowId: "w1", name: "Pedidos", datasetId: null, datasetName: null, rows: 1 },
      startedAt: "2026-03-01T10:00:00.000Z",
      finishedAt: null,
      error: null,
      cases: [
        {
          id: "c1",
          operationId: "op1",
          scenarioId: "workflow:w1:s1",
          method: "POST",
          path: "/orders",
          status: "queued",
          position: 0,
          durationMs: null,
        },
      ],
    },
    fail: {},
  };
}

const operations = [
  { id: "op1", method: "post", path: "/orders", summary: "Crear pedido" },
  { id: "op2", method: "GET", path: "/orders/{id}", summary: "" },
  { id: "op3", method: "HEAD", path: "/health", summary: "" },
];

let created = 0;
function respond(path: string, options?: Options): Promise<unknown> {
  const method = options?.method ?? "GET";
  const route = path.replace("/orgs/o/projects/p", "");
  const failure = server.fail[`${method} ${route}`];
  if (failure) return Promise.reject(failure);
  if (method === "GET") {
    if (route === "/workflows") return Promise.resolve(structuredClone(server.view));
    if (route === "/operations") return Promise.resolve({ operations });
    if (route === "/environments") return Promise.resolve(server.environments);
    if (route === "/channels") return Promise.resolve({ channels: [] });
    if (route.startsWith("/runs/")) return Promise.resolve(server.run);
    if (route === "/datasets/d1") return Promise.resolve({ id: "d1", name: "clientes", rows: [{ email: "a@b.c" }] });
  }
  if (method === "POST" && route === "/request-templates") {
    const id = `t-new-${++created}`;
    return Promise.resolve({ requestTemplateId: id });
  }
  if (method === "POST" && route === "/runs") return Promise.resolve({ runId: "run-1" });
  return Promise.resolve(undefined);
}

const sent = () => mocks.call.mock.calls as [string, Options | undefined][];

function calls(method: string, route?: string) {
  return sent()
    .filter(([, options]) => (options?.method ?? "GET") === method)
    .filter(([path]) => !route || path === `/orgs/o/projects/p${route}`)
    .map(([path, options]) => ({ path, body: options?.body }));
}

let streamState: { handlers?: StreamHandlers } = {};

beforeEach(() => {
  server = freshServer();
  window.localStorage.clear();
  mocks.call.mockImplementation(respond);
  streamState = {};
  mocks.stream.mockImplementation(
    (_path: string, handlers: StreamHandlers) =>
      new Promise<void>(() => {
        streamState.handlers = handlers;
      }),
  );
});

afterEach(() => {
  mocks.canEdit.value = true;
  mocks.call.mockReset();
  mocks.stream.mockReset();
  vi.restoreAllMocks();
});

/** Salta a otro flujo sin pasar por la lista, como lo hace abrir un sub-flujo desde el inspector. */
function Jump() {
  const navigate = useNavigate();
  return <button onClick={() => void navigate("/p/p/workflows/w3")}>ir a w3</button>;
}

function draw(path = "/p/p/workflows/w1") {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[path]}>
        <Jump />
        <Routes>
          <Route path="/p/:projectId/workflows" element={<WorkflowsPage />} />
          <Route path="/p/:projectId/workflows/:workflowId" element={<WorkflowsPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

/** Espera a que el flujo esté abierto en el lienzo y el entorno activo elegido. */
async function ready(path?: string) {
  draw(path);
  expect(await screen.findByTestId("canvas-steps")).toBeTruthy();
  await waitFor(() => expect((screen.getByTitle("Entorno") as HTMLSelectElement).value).toBe("e1"));
}

const button = (name: string | RegExp) => screen.getByRole("button", { name }) as HTMLButtonElement;
const play = () => screen.getByTitle(/Ejecutar flujo|Elige un entorno|Marca al menos/) as HTMLButtonElement;

async function openDrawer(label: "Biblioteca" | "Datos") {
  fireEvent.click(screen.getByTitle(label));
  return screen.findByRole("dialog");
}

// ---------------------------------------------------------------------------------------------

describe("WorkflowsPage: abrir y guardar", () => {
  test("mientras carga lo dice; después abre el primer flujo con el entorno activo", async () => {
    draw();
    expect(screen.getByText("Cargando flujos…")).toBeTruthy();
    expect(await screen.findByTestId("canvas-steps")).toBeTruthy();
    expect(screen.getByTestId("canvas-steps").textContent).toBe("s1,s2");
    expect(screen.getByText("Pedidos")).toBeTruthy();
    await waitFor(() => expect((screen.getByTitle("Entorno") as HTMLSelectElement).value).toBe("e1"));
    // Sin cambios no hay nada que guardar, y la pestaña de ejecución espera a una corrida.
    expect(button("Guardar").disabled).toBe(true);
    expect(button("Ejecución").disabled).toBe(true);
  });

  test("sin id de flujo, la dirección es la lista", async () => {
    draw("/p/p/workflows");
    expect(screen.getByText("lista de flujos de p")).toBeTruthy();
    expect(screen.queryByTestId("canvas")).toBeNull();
  });

  test("un id que no existe lo dice, no deja hacer nada y lleva de vuelta a la lista", async () => {
    draw("/p/p/workflows/nope");
    expect(await screen.findByText("Este flujo no existe")).toBeTruthy();
    expect(screen.queryByTestId("canvas")).toBeNull();
    expect(screen.queryByTitle(/Ejecutar flujo|Elige un entorno/)).toBeNull();
    expect(button("JSON").disabled).toBe(true);
    for (const label of ["Biblioteca", "Datos", "Ajustes"])
      expect((screen.getByTitle(label) as HTMLButtonElement).disabled).toBe(true);
    const back = screen.getByRole("link", { name: "Ver flujos" });
    expect(back.getAttribute("href")).toBe("/p/p/workflows");
    fireEvent.click(back);
    expect(await screen.findByText("lista de flujos de p")).toBeTruthy();
  });

  test("abrir otro flujo monta el editor desde cero", async () => {
    await ready();
    fireEvent.click(button("JSON"));
    expect(screen.queryByTestId("canvas")).toBeNull();
    fireEvent.click(button("ir a w3"));
    expect(await screen.findByTestId("canvas-steps")).toBeTruthy();
    expect(screen.getByTestId("canvas-steps").textContent).toBe("p1");
    expect(screen.getByText("Pagos")).toBeTruthy();
    expect(screen.queryByText("Pedidos")).toBeNull();
    expect(button("JSON")).toBeTruthy();
    expect(button("Guardar").disabled).toBe(true);
  });

  test("«← Flujos» vuelve a la lista; con cambios sin guardar pregunta antes", async () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValueOnce(false).mockReturnValueOnce(true);
    await ready();
    fireEvent.click(button("lienzo: romper"));
    fireEvent.click(screen.getByRole("link", { name: "← Flujos" }));
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("canvas")).toBeTruthy();
    fireEvent.click(screen.getByRole("link", { name: "← Flujos" }));
    expect(await screen.findByText("lista de flujos de p")).toBeTruthy();
    expect(confirm).toHaveBeenCalledTimes(2);
  });

  test("sin cambios, «← Flujos» vuelve sin preguntar", async () => {
    const confirm = vi.spyOn(window, "confirm");
    await ready();
    fireEvent.click(screen.getByRole("link", { name: "← Flujos" }));
    expect(await screen.findByText("lista de flujos de p")).toBeTruthy();
    expect(confirm).not.toHaveBeenCalled();
  });

  test("un flujo sin nodos no se puede ejecutar, ni con Ctrl+Enter", async () => {
    await ready("/p/p/workflows/w2");
    expect(screen.getByTestId("canvas-steps").textContent).toBe("");
    expect(play().disabled).toBe(true);
    fireEvent.keyDown(window, { key: "Enter", ctrlKey: true });
    expect(calls("POST", "/runs")).toHaveLength(0);
  });

  test("guardar manda las peticiones que cambiaron y después el grafo; una que quedó igual no", async () => {
    await ready();
    fireEvent.click(screen.getByTitle("Ajustes"));
    const inspector = await screen.findByTestId("inspector");
    expect(within(inspector).getByText("inspector: flujo")).toBeTruthy();
    // Dos nodos de este flujo y uno de otro usan la misma petición.
    expect(within(inspector).getByText("usos de t1: 3")).toBeTruthy();

    // Tocar una petición sin cambiarla ya cuenta como cambio pendiente, pero no se manda.
    fireEvent.click(within(inspector).getByRole("button", { name: "inspector: tocar t1" }));
    expect(button("Guardar").disabled).toBe(false);
    fireEvent.click(within(inspector).getByRole("button", { name: "inspector: renombrar" }));
    fireEvent.click(button("Guardar"));
    await waitFor(() => expect(calls("PUT", "/workflows/w1")).toHaveLength(1));
    expect(calls("PATCH")).toHaveLength(0);
    expect(calls("PUT", "/workflows/w1")[0]!.body).toEqual({
      name: "Pedidos v2",
      description: null,
      definition: {
        steps: [
          { id: "s1", requestTemplateId: "t1" },
          { id: "s2", requestTemplateId: "t1", dependsOn: ["s1"] },
        ],
      },
    });

    // Ahora sí cambia: primero la petición, después el grafo. Y con Ctrl+S.
    mocks.call.mockClear();
    fireEvent.click(within(inspector).getByRole("button", { name: "inspector: editar t1" }));
    fireEvent.keyDown(window, { key: "s", ctrlKey: true });
    await waitFor(() => expect(calls("PUT", "/workflows/w1")).toHaveLength(1));
    const order = sent()
      .filter(([, options]) => options?.method)
      .map(([path, options]) => `${options!.method} ${path.replace("/orgs/o/projects/p", "")}`);
    expect(order).toEqual(["PATCH /request-templates/t1", "PUT /workflows/w1"]);
    expect(calls("PATCH")[0]!.body).toEqual(
      expect.objectContaining({ name: "Crear pedido", operationId: "op1", expectedStatus: 202, auth: "default" }),
    );
  });

  test("un error al guardar se enseña sobre el lienzo", async () => {
    server.fail["PUT /workflows/w1"] = new Error("El paso s2 no existe");
    await ready();
    fireEvent.click(screen.getByTitle("Ajustes"));
    fireEvent.click(await screen.findByRole("button", { name: "inspector: renombrar" }));
    fireEvent.click(button("Guardar"));
    expect(await screen.findByText("El paso s2 no existe")).toBeTruthy();
  });

  test("un flujo con problemas no se guarda, y «Ir al nodo» abre ese nodo", async () => {
    await ready();
    fireEvent.click(button("lienzo: romper"));
    expect(screen.getByText("El paso «s2» depende de «zz», que no existe.")).toBeTruthy();
    expect(button("Guardar").disabled).toBe(true);
    // Ctrl+S tampoco.
    fireEvent.keyDown(window, { key: "S", metaKey: true });
    fireEvent.click(button("Ir al nodo"));
    expect(await screen.findByText("inspector: s2")).toBeTruthy();
    expect(screen.getByRole("dialog", { name: "Nodo" })).toBeTruthy();
    expect(calls("PUT")).toHaveLength(0);
  });

  test("la vista JSON es el mismo documento; uno roto no se aplica y dice por qué", async () => {
    await ready();
    fireEvent.click(button("JSON"));
    const textarea = screen.getByRole("textbox") as HTMLTextAreaElement;
    expect(JSON.parse(textarea.value).steps).toHaveLength(2);

    fireEvent.change(textarea, { target: { value: "{ roto" } });
    fireEvent.click(button("Diagrama"));
    expect(screen.getByText(/JSON/)).toBeTruthy();
    expect(screen.queryByTestId("canvas")).toBeNull();

    fireEvent.change(textarea, { target: { value: '{"pasos": []}' } });
    fireEvent.click(button("Diagrama"));
    expect(screen.getByText("El documento es { steps: [...] }")).toBeTruthy();

    fireEvent.change(textarea, {
      target: { value: JSON.stringify({ steps: [{ id: "solo", requestTemplateId: "t1" }] }) },
    });
    fireEvent.click(button("Diagrama"));
    expect(screen.getByTestId("canvas-steps").textContent).toBe("solo");
    expect(button("Guardar").disabled).toBe(false);
  });

  test("quien sólo mira no puede guardar ni añadir nodos, tampoco con Ctrl+S", async () => {
    mocks.canEdit.value = false;
    await ready();
    expect(screen.queryByRole("button", { name: "Guardar" })).toBeNull();
    expect(screen.queryByRole("button", { name: "lienzo: + petición" })).toBeNull();
    expect(screen.queryByRole("button", { name: "lienzo: + login" })).toBeNull();
    fireEvent.click(screen.getByTitle("Ajustes"));
    fireEvent.click(await screen.findByRole("button", { name: "inspector: renombrar" }));
    fireEvent.keyDown(window, { key: "s", ctrlKey: true });
    expect(calls("PUT")).toHaveLength(0);
  });
});

describe("WorkflowsPage: ejecutar", () => {
  test("lanza con entorno, flujo y ajustes por defecto, y sigue la corrida encima del lienzo", async () => {
    await ready();
    expect(play().disabled).toBe(false);
    fireEvent.click(play());
    await waitFor(() =>
      expect(calls("POST", "/runs")).toEqual([
        expect.objectContaining({ body: { environmentId: "e1", workflowId: "w1", delayMs: 0, concurrency: 1 } }),
      ]),
    );
    expect(await screen.findByText("Ejecutando el flujo…")).toBeTruthy();
    expect(screen.getByText("0/2")).toBeTruthy();

    // El stream colorea los nodos por su caso.
    await waitFor(() => expect(streamState.handlers).toBeTruthy());
    act(() =>
      streamState.handlers!.onEvent({
        type: "case",
        data: {
          case: { ...server.run.cases[0]!, status: "failed", failure: "status" },
          totals: { cases: 2, completed: 1, passed: 0, failed: 1, skipped: 0 },
        },
      }),
    );
    expect(JSON.parse(screen.getByTestId("canvas-status").textContent!)).toEqual({ s1: "failed" });

    // «Ver detalle» cambia a la pestaña de la corrida, en el sitio, con el progreso completo.
    // Es el mismo seguimiento que colorea el lienzo: ya está en vivo, y no se abre otro stream.
    const streams = mocks.stream.mock.calls.length;
    fireEvent.click(button("Ver detalle"));
    expect(await screen.findByText("en vivo")).toBeTruthy();
    expect(screen.queryByText("conectando…")).toBeNull();
    expect(screen.getByText("Flujo Pedidos")).toBeTruthy();
    expect(mocks.stream.mock.calls.length).toBe(streams);
    expect(mocks.stream.mock.calls.map((entry) => entry[0])).toEqual(["/orgs/o/projects/p/runs/run-1/stream"]);
    act(() => streamState.handlers!.onEvent({ type: "snapshot", data: { totals: server.run.totals } }));
    expect(screen.getByText("en vivo")).toBeTruthy();
    expect(screen.queryByTestId("canvas")).toBeNull();
    fireEvent.click(button("Lienzo"));
    expect(screen.getByTestId("canvas")).toBeTruthy();

    // Cerrar la barra deja de seguirla.
    fireEvent.click(screen.getAllByRole("button", { name: "Cerrar" }).at(-1)!);
    expect(screen.queryByText("Ejecutando el flujo…")).toBeNull();
    expect(button("Ejecución").disabled).toBe(true);
  });

  test("Ctrl+Enter lanza; sin entorno no se puede, y un fallo al lanzar se dice", async () => {
    server.fail["POST /runs"] = new Error("El entorno no admite escrituras");
    await ready();
    fireEvent.change(screen.getByTitle("Entorno"), { target: { value: "" } });
    expect(play().title).toBe("Elige un entorno arriba");
    expect(play().disabled).toBe(true);
    fireEvent.keyDown(window, { key: "Enter", ctrlKey: true });
    expect(calls("POST", "/runs")).toHaveLength(0);

    // Elegir otro entorno lo activa para todo el proyecto.
    fireEvent.change(screen.getByTitle("Entorno"), { target: { value: "e2" } });
    await waitFor(() => expect(calls("POST", "/environments/e2/activate")).toHaveLength(1));
    fireEvent.keyDown(window, { key: "Enter", ctrlKey: true });
    await waitFor(() =>
      expect(calls("POST", "/runs")[0]!.body).toEqual(expect.objectContaining({ environmentId: "e2" })),
    );
    expect(await screen.findByText("El entorno no admite escrituras")).toBeTruthy();
  });

  test("en pausa nombra el nodo que espera, lo marca en el lienzo y se reanuda desde la barra", async () => {
    server.run = { ...server.run, paused: { caseId: "c1", stepId: "s1" } };
    await ready();
    fireEvent.click(play());
    expect(await screen.findByText("En pausa")).toBeTruthy();
    // El nombre es el de la petición del nodo, no su id.
    expect(screen.getByText("Crear pedido", { selector: "span.font-semibold" })).toBeTruthy();
    expect(screen.getByTestId("canvas-paused").textContent).toBe("s1");

    fireEvent.click(button("Siguiente paso"));
    await waitFor(() => expect(calls("POST", "/runs/run-1/resume")[0]!.body).toEqual({ mode: "step" }));
    act(() => streamState.handlers!.onEvent({ type: "paused", data: { pausedAt: { caseId: "c1", stepId: null } } }));
    expect(screen.getByText("el siguiente caso")).toBeTruthy();
    fireEvent.click(button("Continuar hasta el final"));
    await waitFor(() => expect(calls("POST", "/runs/run-1/resume")[1]!.body).toEqual({ mode: "continue" }));
  });

  test("una corrida terminada dice cómo acabó", async () => {
    server.run = {
      ...server.run,
      status: "failed",
      totals: { cases: 2, completed: 2, passed: 1, failed: 1, skipped: 1 },
    };
    await ready();
    fireEvent.click(play());
    expect(await screen.findByText("Terminó con fallos")).toBeTruthy();
    expect(screen.getByText("1⃠")).toBeTruthy();
  });

  test.each([
    ["cancelled", "Cancelada"],
    ["passed", "Terminó"],
  ] as const)("una corrida %s se lee «%s»", async (status, label) => {
    server.run = { ...server.run, status };
    await ready();
    fireEvent.click(play());
    expect(await screen.findByText(label)).toBeTruthy();
  });

  test("los ajustes de ejecución viajan con el lanzamiento y se recuerdan por flujo", async () => {
    await ready();
    fireEvent.click(button("Configurar ejecución"));
    const dialog = await screen.findByRole("dialog", { name: "Configurar ejecución" });
    fireEvent.click(within(dialog).getByRole("radio", { name: /Paso a paso/ }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Listo" }));
    expect(screen.queryByRole("dialog", { name: "Configurar ejecución" })).toBeNull();
    // El resumen junto a «Ejecutar» dice lo que no está por defecto, y abre los ajustes.
    expect(button("Paso a paso").title).toBe("Configurar ejecución");
    expect(JSON.parse(window.localStorage.getItem("eq.run-settings.w1")!).pauseMode).toBe("step");

    fireEvent.click(play());
    await waitFor(() =>
      expect(calls("POST", "/runs")[0]!.body).toEqual(expect.objectContaining({ pauseMode: "step", workflowId: "w1" })),
    );
  });

  test("una parada sin nodos no deja lanzar; marcar uno desde el lienzo sí, y viaja", async () => {
    window.localStorage.setItem("eq.run-settings.w1", JSON.stringify({ pauseMode: "breakpoints", breakpoints: [] }));
    await ready();
    expect(play().disabled).toBe(true);
    expect(play().title).toBe("Marca al menos un nodo donde detenerse");

    fireEvent.click(button("lienzo: parada en s1"));
    expect(screen.getByTestId("canvas-breakpoints").textContent).toBe("s1");
    expect(screen.getByText("1 parada")).toBeTruthy();
    fireEvent.click(play());
    await waitFor(() =>
      expect(calls("POST", "/runs")[0]!.body).toEqual(
        expect.objectContaining({ pauseMode: "breakpoints", breakpoints: ["s1"] }),
      ),
    );

    // El diálogo nombra los nodos por su petición.
    fireEvent.click(screen.getByText("1 parada"));
    const dialog = await screen.findByRole("dialog", { name: "Configurar ejecución" });
    expect(within(dialog).getAllByText("Crear pedido")).toHaveLength(2);
  });
});

describe("WorkflowsPage: biblioteca, datos e inspector", () => {
  test("una operación del contrato es un nodo de un toque, donde se soltó y con el estado de su verbo", async () => {
    await ready();
    fireEvent.click(button("lienzo: + petición"));
    const drawer = await screen.findByRole("dialog", { name: "Biblioteca" });
    fireEvent.click(within(drawer).getByRole("button", { name: /\/orders\/\{id\}/ }));
    await waitFor(() =>
      expect(calls("POST", "/request-templates")[0]!.body).toEqual({
        name: "GET /orders/{id}",
        operationId: "op2",
        expectedStatus: 200,
        parameters: {},
        body: { type: "none" },
      }),
    );
    await waitFor(() => expect(screen.getByTestId("canvas-steps").textContent).toMatch(/^s1,s2,[^,:]+$/));

    // Un nombre ya usado se desambigua; el verbo en minúsculas también cuenta.
    fireEvent.click(within(drawer).getByRole("button", { name: /Crear pedido\s*\+$/ }));
    await waitFor(() =>
      expect(calls("POST", "/request-templates")[1]!.body).toEqual(
        expect.objectContaining({ name: "Crear pedido 2", expectedStatus: 201 }),
      ),
    );
  });

  test("un login se añade marcado como el que autoriza la corrida", async () => {
    await ready();
    fireEvent.click(button("lienzo: + login"));
    const drawer = await screen.findByRole("dialog", { name: "Biblioteca · elige la petición de login" });
    fireEvent.click(within(drawer).getByRole("button", { name: /\/orders\/\{id\}/ }));
    await waitFor(() => expect(screen.getByTestId("canvas-steps").textContent).toMatch(/:login$/));
  });

  test("las peticiones guardadas se añaden, se crean y se borran desde la biblioteca", async () => {
    server.fail["DELETE /request-templates/t1"] = new Error("La usa otro flujo");
    await ready();
    const drawer = await openDrawer("Biblioteca");
    fireEvent.click(within(drawer).getByRole("button", { name: /\+ Crear pedido/ }));
    expect(screen.getByTestId("canvas-steps").textContent!.split(",")).toHaveLength(3);

    fireEvent.change(within(drawer).getByPlaceholderText("Actualizar perfil"), { target: { value: "Leer" } });
    fireEvent.click(within(drawer).getByRole("button", { name: "Crear prueba" }));
    await waitFor(() =>
      expect(calls("POST", "/request-templates")[0]!.body).toEqual(
        expect.objectContaining({ name: "Leer", operationId: "op1" }),
      ),
    );

    fireEvent.click(within(drawer).getByRole("button", { name: "Eliminar" }));
    await waitFor(() => expect(calls("DELETE", "/request-templates/t1")).toHaveLength(1));
    expect((await within(drawer).findAllByText("La usa otro flujo")).length).toBeGreaterThan(0);
  });

  test("el conjunto elegido viaja con la corrida y se suelta al borrarlo", async () => {
    await ready();
    const drawer = await openDrawer("Datos");
    fireEvent.change(within(drawer).getByRole("combobox"), { target: { value: "d1" } });

    fireEvent.click(within(drawer).getByRole("button", { name: "editar" }));
    await waitFor(() => expect(calls("GET", "/datasets/d1")).toHaveLength(1));
    await waitFor(() =>
      expect((within(drawer).getAllByRole("textbox").at(-1) as HTMLTextAreaElement).value).toContain("a@b.c"),
    );
    fireEvent.click(within(drawer).getByRole("button", { name: "Guardar filas" }));
    await waitFor(() => expect(calls("PUT", "/datasets/d1")[0]!.body).toEqual({ rows: [{ email: "a@b.c" }] }));

    fireEvent.click(within(drawer).getByRole("button", { name: "+ Conjunto" }));
    const dialog = await screen.findByRole("dialog", { name: "Nuevo conjunto de datos" });
    fireEvent.change(within(dialog).getByRole("textbox"), { target: { value: "precios" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Crear" }));
    await waitFor(() =>
      expect(calls("POST", "/workflows/w1/datasets")[0]!.body).toEqual({ name: "precios", rows: [] }),
    );

    fireEvent.click(play());
    await waitFor(() => expect(calls("POST", "/runs")[0]!.body).toEqual(expect.objectContaining({ datasetId: "d1" })));

    // Archivar es la otra salida del diálogo: el conjunto deja de ofrecerse y se suelta igual.
    fireEvent.click(within(drawer).getByRole("button", { name: "Eliminar clientes" }));
    fireEvent.click(
      within((await screen.findAllByRole("dialog")).at(-1)!).getByRole("button", { name: "Archivar" }),
    );
    await waitFor(() =>
      expect(calls("PATCH", "/datasets/d1/archived")[0]!.body).toEqual({ archived: true }),
    );
    await waitFor(() => expect((within(drawer).getByRole("combobox") as HTMLSelectElement).value).toBe(""));

    // Vuelto a elegir, borrarlo también lo suelta: una corrida no puede recorrer lo que no está.
    fireEvent.change(within(drawer).getByRole("combobox"), { target: { value: "d1" } });
    await waitFor(() => expect((within(drawer).getByRole("combobox") as HTMLSelectElement).value).toBe("d1"));
    fireEvent.click(within(drawer).getByRole("button", { name: "Eliminar clientes" }));
    // El cajón de datos ya es un diálogo, así que el de la confirmación es el último que se abre.
    fireEvent.click(
      within((await screen.findAllByRole("dialog")).at(-1)!).getByRole("button", { name: "Eliminar" }),
    );
    await waitFor(() => expect(calls("DELETE", "/datasets/d1")).toHaveLength(1));
    await waitFor(() => expect((within(drawer).getByRole("combobox") as HTMLSelectElement).value).toBe(""));
  });

  test("el inspector independiza un nodo, cambia el entorno, lanza, abre los ajustes y borra el flujo", async () => {
    await ready();
    fireEvent.click(button("lienzo: abrir s1"));
    const inspector = await screen.findByTestId("inspector");
    expect(within(inspector).getByText("inspector: s1")).toBeTruthy();

    // Un nodo que no es petición no tiene nada que independizar.
    fireEvent.click(within(inspector).getByRole("button", { name: "inspector: independizar rama" }));
    // Una edición pendiente sobre la compartida no debe viajar tras independizar... salvo que otro
    // nodo aquí siga usándola (s1), que es el caso.
    fireEvent.click(within(inspector).getByRole("button", { name: "inspector: editar t1" }));
    fireEvent.click(within(inspector).getByRole("button", { name: "inspector: independizar s2" }));
    await waitFor(() =>
      expect(calls("POST", "/request-templates")).toEqual([
        expect.objectContaining({
          body: expect.objectContaining({ name: "Crear pedido (copia)", operationId: "op2", expectedStatus: 202 }),
        }),
      ]),
    );
    await waitFor(() => expect(within(inspector).getByText("usos de t1: 2")).toBeTruthy());

    fireEvent.click(within(inspector).getByRole("button", { name: "inspector: entorno e2" }));
    expect(within(inspector).getByText("entorno: e2")).toBeTruthy();
    fireEvent.click(within(inspector).getByRole("button", { name: "inspector: ejecutar" }));
    await waitFor(() =>
      expect(calls("POST", "/runs")[0]!.body).toEqual(expect.objectContaining({ environmentId: "e2" })),
    );

    fireEvent.click(within(inspector).getByRole("button", { name: "inspector: ajustes" }));
    expect(await screen.findByRole("dialog", { name: "Configurar ejecución" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Listo" }));

    // Cancelar el diálogo deja el flujo abierto donde estaba.
    fireEvent.click(within(inspector).getByRole("button", { name: "inspector: borrar" }));
    fireEvent.click(
      within((await screen.findAllByRole("dialog")).at(-1)!).getByRole("button", { name: "Cancelar" }),
    );
    expect(within(inspector).getByText("inspector: s1")).toBeTruthy();

    // Borrarlo lleva a la lista: el flujo ya no está para mostrarlo.
    fireEvent.click(within(inspector).getByRole("button", { name: "inspector: borrar" }));
    fireEvent.click(
      within((await screen.findAllByRole("dialog")).at(-1)!).getByRole("button", { name: "Eliminar" }),
    );
    await waitFor(() => expect(calls("DELETE", "/workflows/w1")).toHaveLength(1));
    expect(await screen.findByText("lista de flujos de p")).toBeTruthy();
  });

  test("archivar el flujo desde el diálogo escribe su estado y vuelve a la lista", async () => {
    await ready();
    fireEvent.click(button("lienzo: abrir s1"));
    const inspector = await screen.findByTestId("inspector");
    // Para un flujo, archivar **es** su `status`: la salida del diálogo escribe ese campo y no
    // llama a ninguna ruta de archivado.
    fireEvent.click(within(inspector).getByRole("button", { name: "inspector: borrar" }));
    fireEvent.click(
      within((await screen.findAllByRole("dialog")).at(-1)!).getByRole("button", { name: "Archivar" }),
    );
    await waitFor(() => expect(calls("PUT", "/workflows/w1")[0]!.body).toEqual({ status: "archived" }));
    expect(await screen.findByText("lista de flujos de p")).toBeTruthy();
  });
});

describe("WorkflowsPage: atajos, cierres y casos de borde", () => {
  /** Reemplaza el grafo abierto desde la vista JSON y vuelve al lienzo. */
  function setGraph(steps: WorkflowStepView[]) {
    fireEvent.click(button("JSON"));
    fireEvent.change(screen.getByRole("textbox"), { target: { value: JSON.stringify({ steps }) } });
    fireEvent.click(button("Diagrama"));
  }

  test("una «s» sin Ctrl no guarda; Ctrl+S guarda aunque sólo se haya tocado una petición", async () => {
    await ready();
    fireEvent.click(screen.getByTitle("Ajustes"));
    fireEvent.click(await screen.findByRole("button", { name: "inspector: tocar t1" }));
    fireEvent.keyDown(window, { key: "s" });
    expect(calls("PUT")).toHaveLength(0);

    fireEvent.keyDown(window, { key: "s", ctrlKey: true });
    await waitFor(() => expect(calls("PUT", "/workflows/w1")).toHaveLength(1));
    expect(calls("PATCH")).toHaveLength(0);
    expect(calls("PUT", "/workflows/w1")[0]!.body).toEqual(expect.objectContaining({ name: "Pedidos" }));
  });

  test("cada cajón se cierra con su botón del muelle o con «Cerrar»", async () => {
    await ready();
    for (const label of ["Biblioteca", "Datos"] as const) {
      await openDrawer(label);
      fireEvent.click(screen.getByTitle(label));
      expect(screen.queryByRole("dialog")).toBeNull();
      const drawer = await openDrawer(label);
      fireEvent.click(within(drawer).getByRole("button", { name: "Cerrar" }));
      expect(screen.queryByRole("dialog")).toBeNull();
    }
    fireEvent.click(button("lienzo: abrir s1"));
    const inspector = await screen.findByRole("dialog", { name: "Nodo" });
    fireEvent.click(within(inspector).getByRole("button", { name: "Cerrar" }));
    expect(screen.queryByTestId("inspector")).toBeNull();
  });

  test("mientras se lanza, «Ejecutar» dice «Lanzando…» y Ctrl+Enter no lanza otra vez", async () => {
    mocks.call.mockImplementation((path: string, options?: Options) =>
      options?.method === "POST" && path.endsWith("/runs") ? new Promise(() => {}) : respond(path, options),
    );
    await ready();
    fireEvent.click(play());
    await waitFor(() => expect(play().textContent).toContain("Lanzando…"));
    expect(play().disabled).toBe(true);
    fireEvent.keyDown(window, { key: "Enter", metaKey: true });
    expect(calls("POST", "/runs")).toHaveLength(1);
  });

  test("una pausa en un nodo de otro flujo se nombra por su id, y la pestaña «Ejecución» abre la corrida", async () => {
    server.run = { ...server.run, paused: { caseId: "c1", stepId: "sub-9" } };
    await ready();
    fireEvent.click(play());
    expect(await screen.findByText("sub-9", { selector: "span.font-semibold" })).toBeTruthy();
    fireEvent.click(button(/Ejecución/));
    expect(await screen.findByText("Flujo Pedidos")).toBeTruthy();
    expect(screen.queryByTestId("canvas")).toBeNull();
  });

  test("el diálogo de paradas nombra un nodo sin petición por su tipo, aunque la etiqueta no lo conozca", async () => {
    window.localStorage.setItem(
      "eq.run-settings.w1",
      JSON.stringify({ pauseMode: "breakpoints", breakpoints: ["s1"] }),
    );
    await ready();
    setGraph([
      { id: "s1", requestTemplateId: "t1" },
      { id: "x", kind: "script", dependsOn: ["s1"] } as WorkflowStepView,
      { id: "y", requestTemplateId: "borrada", dependsOn: ["s1"] },
    ]);
    fireEvent.click(screen.getByText("1 parada"));
    const dialog = await screen.findByRole("dialog", { name: "Configurar ejecución" });
    expect(within(dialog).getByText("script · x")).toBeTruthy();
    expect(within(dialog).getByText("script")).toBeTruthy();
    expect(within(dialog).getByText("Petición · y")).toBeTruthy();
  });

  test("un verbo sin estado habitual (HEAD) empieza esperando 200", async () => {
    await ready();
    const drawer = await openDrawer("Biblioteca");
    fireEvent.click(within(drawer).getByRole("button", { name: /\/health/ }));
    await waitFor(() =>
      expect(calls("POST", "/request-templates")[0]!.body).toEqual(
        expect.objectContaining({ name: "HEAD /health", operationId: "op3", expectedStatus: 200 }),
      ),
    );
  });

  test("independizar el último nodo que usaba una petición suelta su edición pendiente: guardar no la escribe", async () => {
    await ready();
    fireEvent.click(button("lienzo: abrir s1"));
    const inspector = await screen.findByTestId("inspector");
    fireEvent.click(within(inspector).getByRole("button", { name: "inspector: editar t1" }));
    fireEvent.click(within(inspector).getByRole("button", { name: "inspector: independizar s2" }));
    await waitFor(() => expect(within(inspector).getByText("usos de t1: 2")).toBeTruthy());
    fireEvent.click(within(inspector).getByRole("button", { name: "inspector: independizar s1" }));
    await waitFor(() => expect(within(inspector).getByText("usos de t1: 1")).toBeTruthy());
    expect(calls("POST", "/request-templates")).toHaveLength(2);
    expect(calls("POST", "/request-templates")[1]!.body).toEqual(
      expect.objectContaining({ name: "Crear pedido (copia)", operationId: "op1", expectedStatus: 202 }),
    );

    fireEvent.keyDown(window, { key: "s", ctrlKey: true });
    await waitFor(() => expect(calls("PUT", "/workflows/w1")).toHaveLength(1));
    expect(calls("PATCH")).toHaveLength(0);
    const saved = (calls("PUT", "/workflows/w1")[0]!.body as { definition: { steps: WorkflowStepView[] } }).definition
      .steps;
    expect(saved.map((step) => step.requestTemplateId)).not.toContain("t1");
  });

  test("un nodo que apunta a una petición que ya no existe no se puede independizar", async () => {
    await ready();
    setGraph([
      { id: "s1", requestTemplateId: "t1" },
      { id: "s2", requestTemplateId: "borrada", dependsOn: ["s1"] },
    ]);
    fireEvent.click(button("lienzo: abrir s1"));
    fireEvent.click(await screen.findByRole("button", { name: "inspector: independizar s2" }));
    await act(async () => {});
    expect(calls("POST", "/request-templates")).toHaveLength(0);
  });
});
