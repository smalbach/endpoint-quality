/**
 * El historial de corridas y una corrida seguida en vivo.
 *
 * Lo que decide algo:
 *
 * - **Cada corrida dice qué ejecutó**: la matriz (con sus etiquetas), un flujo (con sus datos) o una
 *   suite, y lo que ya no existe se dice en vez de callarse.
 * - **El stream mueve la pantalla**: los casos cambian de fila al llegar, los totales no vuelven a
 *   cero con un evento sin totales, y un reintento se ve como tal en vez de parecer colgado.
 * - **Si el stream no abre, se dice que se está consultando**, en vez de una barra quieta.
 * - **Una corrida en pausa ofrece «Siguiente paso» y «Continuar»**, y sólo a quien puede editar.
 * - **El detalle de un caso rojo empieza por el paso que falló** y distingue «no contestó» de «se
 *   retiró el cuerpo».
 */
import { afterEach, describe, expect, test, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";

import { RunDetailPage, RunsPage } from "@/routes/runs";
import type { Run, RunCase, RunCaseView, RunView } from "@/lib/types";

type StreamHandlers = { onEvent: (event: { type: string; data: unknown }) => void; signal: AbortSignal };

const mocks = vi.hoisted(() => ({
  call: vi.fn(),
  stream: vi.fn(),
  canEdit: { value: true },
  signedOut: { value: false },
}));
vi.mock("@/lib/api", async (original) => ({
  ...(await original<object>()),
  api: mocks.call,
  streamRun: mocks.stream,
}));
vi.mock("@/lib/auth", () => ({
  useOrganization: () => (mocks.signedOut.value ? null : { id: "o", name: "Org" }),
  useCan: () => mocks.canEdit.value,
}));

const call = mocks.call;

afterEach(() => {
  mocks.canEdit.value = true;
  mocks.signedOut.value = false;
  call.mockReset();
  mocks.stream.mockReset();
});

const totals = (patch: Partial<RunView["totals"]> = {}) => ({
  cases: 4,
  completed: 0,
  passed: 0,
  failed: 0,
  skipped: 0,
  ...patch,
});

const runRow = (patch: Partial<Run>): Run => ({
  id: "r1",
  projectId: "p",
  environmentId: "e",
  status: "passed",
  totals: totals({ completed: 4, passed: 4 }),
  source: { kind: "matrix", operationIds: [], labels: [] },
  startedAt: "2026-03-01T10:00:00.000Z",
  finishedAt: "2026-03-01T10:01:00.000Z",
  error: null,
  ...patch,
});

const runCase = (patch: Partial<RunCase> & { id: string }): RunCase => ({
  operationId: "op",
  scenarioId: "happy",
  method: "GET",
  path: `/items/${patch.id}`,
  status: "queued",
  failure: null,
  position: 0,
  durationMs: null,
  ...patch,
});

function renderRuns(path = "/p/p/runs") {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/p/:projectId/runs" element={<RunsPage />} />
          <Route path="/p/:projectId/runs/:runId" element={<RunDetailPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return client;
}

/**
 * Deja el stream abierto y devuelve lo que hace falta para empujar eventos y cerrarlo (bien o mal).
 */
function openStream() {
  const state: { handlers?: StreamHandlers; path?: string; fail?: (error: Error) => void; end?: () => void } = {};
  mocks.stream.mockImplementation(
    (path: string, handlers: StreamHandlers) =>
      new Promise<void>((resolve, reject) => {
        state.path = path;
        state.handlers = handlers;
        state.fail = reject;
        state.end = resolve;
      }),
  );
  return {
    state,
    emit: (type: string, data: unknown) => act(() => state.handlers!.onEvent({ type, data })),
  };
}

describe("RunsPage", () => {
  test("mientras carga lo dice, y sin corridas explica para qué sirven", async () => {
    let answer: (value: Run[]) => void = () => {};
    call.mockImplementation(() => new Promise<Run[]>((resolve) => (answer = resolve)));
    renderRuns();
    expect(screen.getByText("Cargando…")).toBeTruthy();
    // Las pestañas de la sección están también mientras carga.
    expect(screen.getByRole("link", { name: "Contrato" })).toBeTruthy();
    await act(async () => answer([]));
    expect(await screen.findByText("Ninguna corrida todavía")).toBeTruthy();
    expect(call).toHaveBeenCalledWith("/orgs/o/projects/p/runs");
  });

  test("cada fila dice qué ejecutó, y lo que ya no existe se nombra como eliminado", async () => {
    call.mockResolvedValue([
      runRow({ id: "a", source: { kind: "matrix", operationIds: ["x", "y"], labels: ["crítico", "pagos"] } }),
      runRow({ id: "b", source: { kind: "matrix", operationIds: [], labels: [] } }),
      runRow({
        id: "c",
        status: "failed",
        totals: totals({ completed: 4, passed: 1, failed: 2, skipped: 1 }),
        source: {
          kind: "workflow",
          workflowId: "w",
          name: "Pedidos",
          datasetId: "d",
          datasetName: null,
          rows: 3,
        },
      }),
      runRow({
        id: "d",
        source: { kind: "workflow", workflowId: "w", name: null, datasetId: null, datasetName: null, rows: 1 },
      }),
      runRow({ id: "e", source: { kind: "suite", suiteId: "s", name: null, flowNames: ["a", null] } }),
      runRow({ id: "f", source: { kind: "channel", channelId: "ch", name: null } }),
      runRow({ id: "g", source: { kind: "channel", channelId: "ch", name: "Chat" } }),
    ]);
    renderRuns();
    expect(await screen.findByText("Matriz · crítico, pagos · 2 operaciones")).toBeTruthy();
    expect(screen.getByText("Matriz completa")).toBeTruthy();
    expect(screen.getByText("Flujo Pedidos · (datos eliminados), 3 filas")).toBeTruthy();
    expect(screen.getByText("Flujo (eliminado)")).toBeTruthy();
    expect(screen.getByText("Suite (eliminada) · 2 flujos")).toBeTruthy();
    expect(screen.getByText("Canal (eliminado)")).toBeTruthy();
    expect(screen.getByText("Canal Chat")).toBeTruthy();
    // Los fallos y los no ejecutados sólo aparecen cuando los hay.
    expect(screen.getByText("2 ✗")).toBeTruthy();
    expect(screen.getByText("1 ⃠")).toBeTruthy();
    expect(screen.getAllByText(/✗/)).toHaveLength(1);
    const links = screen.getAllByRole("link", { name: "Ver" });
    expect(links.map((link) => link.getAttribute("href"))).toEqual([
      "/p/p/runs/a",
      "/p/p/runs/b",
      "/p/p/runs/c",
      "/p/p/runs/d",
      "/p/p/runs/e",
      "/p/p/runs/f",
      "/p/p/runs/g",
    ]);
  });
});

const liveRun = (patch: Partial<RunView> = {}): RunView => ({
  ...runRow({
    id: "r1",
    status: "running",
    totals: totals(),
    source: { kind: "workflow", workflowId: "w", name: "Pedidos", datasetId: null, datasetName: null, rows: 1 },
    finishedAt: null,
  }),
  cases: [runCase({ id: "c1", position: 0 }), runCase({ id: "c2", position: 1, method: "POST", path: "/orders" })],
  ...patch,
});

describe("RunDetailPage", () => {
  test("sin organización todavía no pide nada: espera", () => {
    mocks.signedOut.value = true;
    renderRuns("/p/p/runs/r1");
    expect(screen.getByText("Cargando…")).toBeTruthy();
    expect(call).not.toHaveBeenCalled();
  });

  test("una corrida sin casos enseña el progreso a 0 %, no NaN", async () => {
    openStream();
    call.mockResolvedValue(liveRun({ totals: totals({ cases: 0 }), cases: [] }));
    renderRuns("/p/p/runs/r1");
    expect(await screen.findByText("0/0 · 0%")).toBeTruthy();
  });

  test("una corrida que no existe lo dice", async () => {
    openStream();
    call.mockRejectedValue(new Error("404"));
    renderRuns("/p/p/runs/r1");
    expect(screen.getByText("Cargando…")).toBeTruthy();
    expect(await screen.findByText("No se encontró la corrida.")).toBeTruthy();
  });

  test("el stream mueve filas, totales y reintentos, y al terminar vuelve a pedir la corrida", async () => {
    const { state, emit } = openStream();
    call.mockResolvedValue(liveRun());
    renderRuns("/p/p/runs/r1");

    expect(await screen.findByText("conectando…")).toBeTruthy();
    expect(state.path).toBe("/orgs/o/projects/p/runs/r1/stream");
    expect(screen.getByText("Flujo Pedidos")).toBeTruthy();
    expect(screen.getByText("0/4 · 0%")).toBeTruthy();

    // La foto inicial: un caso en marcha y los totales de ahora.
    emit("snapshot", {
      totals: totals({ completed: 1, passed: 1 }),
      case: runCase({ id: "c1", status: "running", position: 0 }),
    });
    expect(screen.getByText("en vivo")).toBeTruthy();
    expect(screen.getByText("ejecutando")).toBeTruthy();
    expect(screen.getByText("1/4 · 25%")).toBeTruthy();

    // Un evento sin totales no pone la barra a cero.
    emit("case", { case: runCase({ id: "c2", status: "running", position: 1, method: "POST", path: "/orders" }) });
    expect(screen.getByText("1/4 · 25%")).toBeTruthy();
    expect(screen.getAllByText("ejecutando")).toHaveLength(2);

    // Un evento vacío no cambia nada.
    emit("noise", {});
    expect(screen.getByText("1/4 · 25%")).toBeTruthy();

    // Un reintento se ve con su número, en vez de una fila colgada.
    emit("retry", { caseId: "c1", attempt: 2, attempts: 3, waitMs: 1000 });
    expect(screen.getByText(/intento 2\/3/)).toBeTruthy();

    // El caso termina: el reintento queda como nota de cuántos intentos llevó.
    emit("case", {
      case: runCase({ id: "c1", status: "failed", failure: "contract", durationMs: 42, position: 0 }),
      totals: totals({ completed: 2, passed: 1, failed: 1 }),
    });
    expect(screen.queryByText(/intento 2\/3/)).toBeNull();
    expect(screen.getByText("↻ 2 intentos")).toBeTruthy();
    expect(screen.getByText("42 ms")).toBeTruthy();
    expect(screen.getByText("contrato")).toBeTruthy();
    expect(screen.getByText("1 × contrato")).toBeTruthy();
    expect(screen.getByText("1 fallidos")).toBeTruthy();

    emit("case", {
      case: runCase({ id: "c2", status: "failed", failure: "contract", position: 1, method: "POST", path: "/orders" }),
      totals: totals({ completed: 3, passed: 1, failed: 2 }),
    });
    expect(screen.getByText("2 × contrato")).toBeTruthy();

    // Un caso que el primer fetch no conocía (un bucle) entra en su sitio por `position`.
    emit("case", { case: runCase({ id: "c3", status: "passed", position: 2, path: "/loop" }) });
    expect(screen.getByText("/loop")).toBeTruthy();

    // El final: la corrida guardada manda, y se vuelve a pedir.
    const fetchesBefore = call.mock.calls.length;
    call.mockResolvedValue(liveRun({ status: "failed", totals: totals({ completed: 4, passed: 2, failed: 2 }) }));
    emit("done", { status: "failed", totals: totals({ completed: 4, passed: 2, failed: 2 }) });
    await waitFor(() => expect(call.mock.calls.length).toBeGreaterThan(fetchesBefore));
    await waitFor(() => expect(screen.queryByText("en vivo")).toBeNull());
    expect(screen.queryByRole("button", { name: "Cancelar" })).toBeNull();
    // Cerrar el stream bien después del final no lo marca como caído.
    await act(async () => state.end!());
  });

  test("si el stream no abre, dice que consulta cada 2 s", async () => {
    const { state } = openStream();
    call.mockResolvedValue(liveRun());
    renderRuns("/p/p/runs/r1");
    await screen.findByText("conectando…");
    await act(async () => state.fail!(new Error("buffered")));
    expect(await screen.findByText("consultando cada 2 s (el stream no está disponible)")).toBeTruthy();
  });

  test("un nodo webhook que se pone a esperar vuelve a pedir la corrida, que trae su URL", async () => {
    const { emit } = openStream();
    call.mockResolvedValue(liveRun());
    renderRuns("/p/p/runs/r1");
    await screen.findByText("conectando…");
    const before = call.mock.calls.filter(([path]) => path === "/orgs/o/projects/p/runs/r1").length;
    emit("waiting", { stepId: "hook" });
    await waitFor(() =>
      expect(call.mock.calls.filter(([path]) => path === "/orgs/o/projects/p/runs/r1").length).toBe(before + 1),
    );
    expect(screen.getByText("en vivo")).toBeTruthy();
  });

  test("cancelar manda el POST; sin permiso de edición no hay botón", async () => {
    openStream();
    call.mockImplementation((_path: string, options?: { method?: string }) =>
      Promise.resolve(options?.method === "POST" ? undefined : liveRun({ error: "El entorno no responde" })),
    );
    renderRuns("/p/p/runs/r1");
    expect(await screen.findByText("El entorno no responde")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Cancelar" }));
    await waitFor(() => expect(call).toHaveBeenCalledWith("/orgs/o/projects/p/runs/r1/cancel", { method: "POST" }));
  });

  test("quien sólo mira no ve los controles", async () => {
    mocks.canEdit.value = false;
    openStream();
    call.mockResolvedValue(liveRun({ paused: { caseId: "c2", stepId: "s2" } }));
    renderRuns("/p/p/runs/r1");
    await screen.findByText("conectando…");
    expect(screen.queryByRole("button", { name: "Cancelar" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Siguiente paso" })).toBeNull();
  });

  test("una corrida en pausa nombra el caso que espera y se reanuda paso a paso o hasta el final", async () => {
    const { emit } = openStream();
    call.mockImplementation((_path: string, options?: { method?: string }) =>
      Promise.resolve(options?.method === "POST" ? undefined : liveRun({ paused: { caseId: "c2", stepId: "s2" } })),
    );
    renderRuns("/p/p/runs/r1");
    // Abierta a mitad de la pausa: la corrida pedida dice dónde espera.
    expect(await screen.findByText("POST /orders")).toBeTruthy();
    expect(screen.getByText(/En pausa antes de/)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Siguiente paso" }));
    await waitFor(() =>
      expect(call).toHaveBeenCalledWith("/orgs/o/projects/p/runs/r1/resume", {
        method: "POST",
        body: { mode: "step" },
      }),
    );
    // Al aceptarse, la pausa se quita sin esperar al stream.
    await waitFor(() => expect(screen.queryByRole("button", { name: "Siguiente paso" })).toBeNull());

    // El stream anuncia otra pausa, ante un caso que no está en la lista.
    emit("paused", { pausedAt: { caseId: "zz", stepId: null } });
    expect(screen.getByText("el siguiente paso")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Continuar" }));
    await waitFor(() =>
      expect(call).toHaveBeenCalledWith("/orgs/o/projects/p/runs/r1/resume", {
        method: "POST",
        body: { mode: "continue" },
      }),
    );

    // Y «resumed» la cierra también.
    emit("paused", { pausedAt: { caseId: "c1", stepId: "s1" } });
    expect(screen.getByText("GET /items/c1")).toBeTruthy();
    emit("resumed", {});
    expect(screen.queryByText(/En pausa antes de/)).toBeNull();

    // La foto del stream también sabe si está en pausa.
    emit("snapshot", { pausedAt: { caseId: "c2", stepId: "s2" } });
    expect(screen.getByText("POST /orders")).toBeTruthy();
  });

  test("el detalle de un caso rojo empieza por el paso que falló", async () => {
    openStream();
    const detail: RunCaseView = {
      ...runCase({ id: "c1", status: "failed", failure: "server" }),
      steps: [
        {
          id: "s1",
          index: 0,
          purpose: "crear",
          label: "Crear pedido",
          request: { method: "POST", url: "http://api/orders", headers: { a: "b" }, body: { x: 1 } },
          expected: { status: 201, shape: "", operationPath: "/orders" },
          actual: { status: 201, contentType: "application/json", headers: {}, body: { id: 7 } },
          assertions: [{ label: "estado 201", pass: true, detail: "201" }],
          latency: { samples: [10, 12, 14], budgetMs: null, timing: { dnsMs: 3, ttfbMs: 8, downloadMs: 1 } },
          ok: true,
          durationMs: 12,
        },
        {
          id: "s2",
          index: 1,
          purpose: "leer",
          label: "Leer pedido",
          request: { method: "GET", url: "http://api/orders/7", headers: {}, body: null },
          expected: { status: 200, shape: "", operationPath: "/orders/{id}" },
          actual: { status: 500, contentType: "text/plain", headers: {}, body: "boom" },
          assertions: [{ label: "estado 200", pass: false, detail: "Se esperaba 200 y llegó 500" }],
          latency: { samples: [30], budgetMs: null, timing: { dnsMs: 0, ttfbMs: 30, downloadMs: 0 } },
          ok: false,
          durationMs: 30,
        },
        {
          id: "s3",
          index: 2,
          purpose: "limpiar",
          label: "Borrar pedido",
          request: null,
          expected: null,
          actual: null,
          assertions: [],
          latency: null,
          ok: true,
          durationMs: 1500,
          prunedAt: "2026-03-10T10:00:00.000Z",
        },
        {
          id: "s4",
          index: 3,
          purpose: "otra",
          label: "Sin respuesta",
          request: { method: "GET", url: "http://api/x", headers: {}, body: null },
          expected: null,
          actual: null,
          assertions: [],
          latency: null,
          ok: true,
          durationMs: 5,
        },
      ],
    };
    call.mockImplementation((path: string) =>
      Promise.resolve(
        path.endsWith("/cases/c1")
          ? detail
          : liveRun({ status: "failed", cases: [runCase({ id: "c1", status: "failed", failure: "server" })] }),
      ),
    );
    renderRuns("/p/p/runs/r1");
    expect(await screen.findByText(/Elige un caso/)).toBeTruthy();
    // Sin corrida en marcha no hay indicador del stream.
    expect(screen.queryByText("conectando…")).toBeNull();
    expect(screen.getByText("1 × 5xx")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /\/items\/c1/ }));
    expect(await screen.findByText("Falló en «Leer pedido»")).toBeTruthy();
    expect(call).toHaveBeenCalledWith("/orgs/o/projects/p/runs/r1/cases/c1");
    expect(screen.getAllByText("Se esperaba 200 y llegó 500").length).toBeGreaterThan(0);
    expect(screen.getByText("respondió 500")).toBeTruthy();
    // Las muestras sólo con varias; el desglose sólo cuando alguna parte es visible.
    expect(screen.getByText("muestras: 10, 12, 14 ms")).toBeTruthy();
    expect(screen.getAllByText(/^dns /)).toHaveLength(1);
    // Un cuerpo retirado no se lee como «no contestó».
    expect(screen.getByText("petición retirada")).toBeTruthy();
    expect(screen.getByText(/se retiraron el/)).toBeTruthy();
    expect(screen.getByText("1.5 s")).toBeTruthy();
    expect(screen.getByText("sin respuesta")).toBeTruthy();
    expect(screen.getByText("POST http://api/orders")).toBeTruthy();
  });

  test("un caso rojo sin aserción rota lo dice igualmente", async () => {
    openStream();
    const detail: RunCaseView = {
      ...runCase({ id: "c1", status: "failed" }),
      steps: [
        {
          id: "s1",
          index: 0,
          purpose: "crear",
          label: "Crear",
          request: null,
          expected: null,
          actual: null,
          assertions: [],
          latency: null,
          ok: false,
          durationMs: 1,
        },
      ],
    };
    call.mockImplementation((path: string) =>
      Promise.resolve(
        path.endsWith("/cases/c1") ? detail : liveRun({ status: "passed", cases: [runCase({ id: "c1" })] }),
      ),
    );
    renderRuns("/p/p/runs/r1");
    fireEvent.click(await screen.findByRole("button", { name: /\/items\/c1/ }));
    expect(await screen.findByText("El paso no pasó. Mira sus aserciones más abajo.")).toBeTruthy();
  });
});
