/**
 * Las pruebas de carga: los planes, una corrida y la comparación de dos.
 *
 * - El primer plan se elige solo, el entorno activo se propone, y no se ejecuta un plan con cambios
 *   sin guardar.
 * - Crear, guardar, eliminar y ejecutar mandan lo que deben al servidor; ejecutar lleva al detalle.
 * - El detalle sigue en vivo una corrida en curso (SSE) y se puede cancelar; una terminada enseña sus
 *   métricas, umbrales, timeline y endpoints, y se puede comparar con otra.
 * - La comparación pinta cada delta según la corrida a la que favorece.
 */
import { afterEach, describe, expect, test, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";

import { PerformanceComparePage, PerformancePage, PerformanceRunDetailPage } from "@/routes/performance";
import { emptyPlanDefinition } from "@/lib/performance";
import type {
  PerformanceComparisonView,
  PerformancePlanView,
  PerformanceRunDetailView,
  PerformanceRunSummaryView,
} from "@/lib/types";

type StreamHandlers = { onEvent: (event: { type: string; data: unknown }) => void; signal: AbortSignal };
type Options = { method?: string; body?: unknown };

const mocks = vi.hoisted(() => ({
  api: vi.fn(),
  streamRun: vi.fn(),
  canEdit: { value: true },
}));
vi.mock("@/lib/api", async (original) => ({
  ...(await original<object>()),
  api: mocks.api,
  streamRun: mocks.streamRun,
}));
vi.mock("@/lib/auth", () => ({
  useOrganization: () => ({ id: "o", name: "Org" }),
  useCan: () => mocks.canEdit.value,
}));

afterEach(() => {
  mocks.api.mockReset();
  mocks.streamRun.mockReset();
  mocks.canEdit.value = true;
});

const BASE = "/orgs/o/projects/p1";
const calls = () => mocks.api.mock.calls as [string, Options?][];

const plan = (patch: Partial<PerformancePlanView> = {}): PerformancePlanView => ({
  id: "pl1",
  name: "Catálogo",
  description: "Lectura del catálogo",
  definition: emptyPlanDefinition(),
  updatedAt: "2026-03-01T10:00:00.000Z",
  archivedAt: null,
  deletedAt: null,
  ...patch,
});

const summary = {
  requests: 1200,
  failures: 12,
  errorRate: 0.01,
  rps: 40,
  minMs: 5,
  maxMs: 2400,
  avgMs: 120,
  p50Ms: 100,
  p90Ms: 300,
  p95Ms: 450,
  p99Ms: 1500,
};

const runRow = (patch: Partial<PerformanceRunSummaryView> = {}): PerformanceRunSummaryView => ({
  id: "run1",
  planId: "pl1",
  planName: "Catálogo",
  status: "passed",
  summary,
  startedAt: "2026-03-01T10:00:00.000Z",
  finishedAt: "2026-03-01T10:01:00.000Z",
  ...patch,
});

const runDetail = (patch: Partial<PerformanceRunDetailView> = {}): PerformanceRunDetailView => ({
  id: "run1",
  projectId: "p1",
  planId: "pl1",
  planName: "Catálogo",
  environmentId: "env-1",
  status: "passed",
  definition: emptyPlanDefinition(),
  progress: { elapsedS: 30, totalS: 30, requests: 1200, vus: 10 },
  summary,
  windows: [
    { atS: 0, requests: 200, failures: 0, rps: 40, errorRate: 0, p95Ms: 400, vus: 10 },
    { atS: 5, requests: 200, failures: 2, rps: 38, errorRate: 0.01, p95Ms: 500, vus: 10 },
  ],
  endpoints: [
    { method: "GET", path: "/products", requests: 1000, failures: 12, errorRate: 0.012, p95Ms: 460, avgMs: 110 },
    { method: "GET", path: "/health", requests: 200, failures: 0, errorRate: 0, p95Ms: 20, avgMs: 10 },
  ],
  thresholds: [
    { label: "p95 < 500 ms", ok: true, actual: "450 ms", limit: "500 ms" },
    { label: "errores < 0.5%", ok: false, actual: "1%", limit: "0.5%" },
  ],
  error: null,
  startedAt: "2026-03-01T10:00:00.000Z",
  finishedAt: "2026-03-01T10:01:00.000Z",
  ...patch,
});

function Where() {
  const location = useLocation();
  return <p data-testid="where">{location.pathname}</p>;
}

function draw(path: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/p/:projectId/performance" element={<PerformancePage />} />
          <Route path="/p/:projectId/performance/:runId" element={<PerformanceRunDetailPage />} />
          <Route
            path="/p/:projectId/performance/compare/:baseRunId/:targetRunId"
            element={<PerformanceComparePage />}
          />
        </Routes>
        <Where />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const environments = [
  { id: "env-1", name: "staging", active: true, variables: [], credentials: [] },
  { id: "env-2", name: "producción", active: false, variables: [], credentials: [] },
];

/** La pantalla de planes pide los planes, los entornos y el historial del plan elegido. */
function answersPlans(
  plans: PerformancePlanView[] | (() => PerformancePlanView[]),
  extra: (path: string, options?: Options) => Promise<unknown> | undefined = () => undefined,
  envs: typeof environments = environments,
  runs: PerformanceRunSummaryView[] = [],
) {
  mocks.api.mockImplementation((path: string, options?: Options) => {
    const handled = extra(path, options);
    if (handled) return handled;
    if (options?.method) return Promise.resolve(undefined);
    if (path.endsWith("/performance/plans")) return Promise.resolve(typeof plans === "function" ? plans() : plans);
    if (path.endsWith("/environments")) return Promise.resolve(envs);
    if (path.includes("/performance/runs?planId=")) return Promise.resolve(runs);
    // Lo que no se contesta (la página a la que se navega) se queda pendiente.
    return new Promise(() => undefined);
  });
}

describe("los planes de carga", () => {
  test("mientras carga lo dice; sin planes invita a crear el primero", async () => {
    answersPlans([]);
    draw("/p/p1/performance");
    expect(screen.getByText("Cargando…")).toBeTruthy();
    await screen.findByText("Crea tu primer plan");
    expect(screen.getByText("Ninguno todavía.")).toBeTruthy();
    expect(screen.getByText("Sin corridas todavía.")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Ejecutar plan" }) as HTMLButtonElement).disabled).toBe(true);
  });

  test("elige el primer plan, propone el entorno activo y enseña su historial", async () => {
    answersPlans([plan(), plan({ id: "pl2", name: "Checkout" })], undefined, environments, [
      runRow(),
      runRow({ id: "run2", status: "failed", summary: null }),
    ]);
    draw("/p/p1/performance");
    await waitFor(() => expect((screen.getByLabelText("Nombre del plan") as HTMLInputElement).value).toBe("Catálogo"));
    expect((screen.getByLabelText("Descripción") as HTMLTextAreaElement).value).toBe("Lectura del catálogo");
    expect(screen.getAllByText("10 usuarios · 30 s").length).toBeGreaterThan(0);
    await waitFor(() => expect((screen.getByLabelText("Entorno") as HTMLSelectElement).value).toBe("env-1"));
    await screen.findByText("p95 450 ms · 40 req/s");
    expect(screen.getByText("Superada")).toBeTruthy();
    expect(screen.getByText("No superada")).toBeTruthy();
    expect(mocks.api).toHaveBeenCalledWith(`${BASE}/performance/runs?planId=pl1`);

    // Cambiar de plan pide su historial.
    fireEvent.click(screen.getByText("Checkout"));
    await waitFor(() => expect(mocks.api).toHaveBeenCalledWith(`${BASE}/performance/runs?planId=pl2`));
    await waitFor(() => expect((screen.getByLabelText("Nombre del plan") as HTMLInputElement).value).toBe("Checkout"));
  });

  test("una corrida del historial lleva a su detalle", async () => {
    answersPlans([plan()], undefined, environments, [runRow()]);
    draw("/p/p1/performance");
    fireEvent.click(await screen.findByText("p95 450 ms · 40 req/s"));
    await waitFor(() => expect(screen.getByTestId("where").textContent).toBe("/p/p1/performance/run1"));
  });

  test("sin entorno activo no se propone ninguno, y elegir uno lo activa", async () => {
    answersPlans(
      [plan()],
      undefined,
      environments.map((e) => ({ ...e, active: false })),
    );
    draw("/p/p1/performance");
    const select = (await screen.findByLabelText("Entorno")) as HTMLSelectElement;
    await screen.findByRole("option", { name: "producción" });
    expect(select.value).toBe("");
    expect((screen.getByRole("button", { name: "Ejecutar plan" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(select, { target: { value: "env-2" } });
    await waitFor(() =>
      expect(mocks.api).toHaveBeenCalledWith(`${BASE}/environments/env-2/activate`, { method: "POST" }),
    );
    expect((screen.getByRole("button", { name: "Ejecutar plan" }) as HTMLButtonElement).disabled).toBe(false);
  });

  test("editar deja el plan sin guardar: no se ejecuta hasta guardarlo, y guardar manda el borrador", async () => {
    let saved = plan();
    answersPlans(
      () => [saved],
      (path, options) => {
        if (options?.method !== "PUT") return undefined;
        const body = options.body as { name: string; description: string };
        saved = { ...saved, name: body.name, description: body.description, updatedAt: "2026-03-02T00:00:00.000Z" };
        return Promise.resolve(undefined);
      },
    );
    draw("/p/p1/performance");
    const name = (await screen.findByLabelText("Nombre del plan")) as HTMLInputElement;
    await waitFor(() => expect(name.value).toBe("Catálogo"));
    await waitFor(() => expect((screen.getByLabelText("Entorno") as HTMLSelectElement).value).toBe("env-1"));
    const save = screen.getByRole("button", { name: "Guardar" }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);

    fireEvent.change(name, { target: { value: "Catálogo v2" } });
    fireEvent.change(screen.getByLabelText("Descripción"), { target: { value: "Más carga" } });
    expect(screen.getByText("Guarda los cambios antes de ejecutar.")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Ejecutar plan" }) as HTMLButtonElement).disabled).toBe(true);
    expect(save.disabled).toBe(false);

    fireEvent.click(save);
    await waitFor(() => expect(screen.queryByText("Guarda los cambios antes de ejecutar.")).toBeNull());
    const put = calls().find(([, options]) => options?.method === "PUT");
    expect(put?.[0]).toBe(`${BASE}/performance/plans/pl1`);
    expect(put?.[1]?.body).toEqual({
      name: "Catálogo v2",
      description: "Más carga",
      definition: emptyPlanDefinition(),
    });
    expect((screen.getByRole("button", { name: "Ejecutar plan" }) as HTMLButtonElement).disabled).toBe(false);
  });

  test("un plan sin escenarios no se ejecuta", async () => {
    answersPlans([plan({ definition: { ...emptyPlanDefinition(), scenarios: [] } })]);
    draw("/p/p1/performance");
    await waitFor(() => expect((screen.getByLabelText("Entorno") as HTMLSelectElement).value).toBe("env-1"));
    expect((screen.getByRole("button", { name: "Ejecutar plan" }) as HTMLButtonElement).disabled).toBe(true);
  });

  test("ejecutar manda el entorno y lleva al detalle de la corrida", async () => {
    answersPlans([plan()], (path, options) =>
      options?.method === "POST" && path.endsWith("/runs") ? Promise.resolve({ runId: "run7" }) : undefined,
    );
    draw("/p/p1/performance");
    await waitFor(() => expect((screen.getByLabelText("Entorno") as HTMLSelectElement).value).toBe("env-1"));
    const launch = screen.getByRole("button", { name: "Ejecutar plan" }) as HTMLButtonElement;
    await waitFor(() => expect(launch.disabled).toBe(false));
    mocks.api.mockClear();
    fireEvent.click(launch);
    await waitFor(() => expect(screen.getByTestId("where").textContent).toBe("/p/p1/performance/run7"));
    expect(mocks.api).toHaveBeenCalledWith(`${BASE}/performance/plans/pl1/runs`, {
      method: "POST",
      body: { environmentId: "env-1" },
    });
  });

  test("si ejecutar falla, el error del servidor se enseña", async () => {
    answersPlans([plan()], (path, options) =>
      options?.method === "POST" && path.endsWith("/runs") ? Promise.reject(new Error("Entorno bloqueado")) : undefined,
    );
    draw("/p/p1/performance");
    const launch = (await screen.findByRole("button", { name: "Ejecutar plan" })) as HTMLButtonElement;
    await waitFor(() => expect(launch.disabled).toBe(false));
    fireEvent.click(launch);
    await screen.findByText("Entorno bloqueado");
  });

  test("crear un plan pide el nombre, lo manda con la definición vacía y lo elige", async () => {
    let list = [plan()];
    answersPlans(
      () => list,
      (path, options) => {
        if (options?.method !== "POST" || !path.endsWith("/performance/plans")) return undefined;
        list = [...list, plan({ id: "pl9", name: (options.body as { name: string }).name })];
        return Promise.resolve({ planId: "pl9" });
      },
    );
    draw("/p/p1/performance");
    fireEvent.click(await screen.findByRole("button", { name: "+ Nuevo" }));
    const input = await screen.findByPlaceholderText("Catálogo bajo carga");
    fireEvent.change(input, { target: { value: "Pico de ventas" } });
    fireEvent.click(screen.getByRole("button", { name: "Crear" }));
    await waitFor(() =>
      expect((screen.getByLabelText("Nombre del plan") as HTMLInputElement).value).toBe("Pico de ventas"),
    );
    expect(mocks.api).toHaveBeenCalledWith(`${BASE}/performance/plans`, {
      method: "POST",
      body: { name: "Pico de ventas", definition: emptyPlanDefinition() },
    });
  });

  test("cerrar el diálogo de nuevo plan no crea nada", async () => {
    answersPlans([plan()]);
    draw("/p/p1/performance");
    fireEvent.click(await screen.findByRole("button", { name: "+ Nuevo" }));
    await screen.findByPlaceholderText("Catálogo bajo carga");
    fireEvent.click(screen.getByRole("button", { name: "Cancelar" }));
    await waitFor(() => expect(screen.queryByPlaceholderText("Catálogo bajo carga")).toBeNull());
    expect(calls().some(([, options]) => options?.method === "POST")).toBe(false);
  });

  test("eliminar el plan lo borra y elige el siguiente", async () => {
    let list = [plan(), plan({ id: "pl2", name: "Checkout" })];
    answersPlans(
      () => list,
      (path, options) => {
        if (options?.method !== "DELETE") return undefined;
        list = list.filter((p) => !path.endsWith(`/${p.id}`));
        return Promise.resolve(undefined);
      },
    );
    draw("/p/p1/performance");
    await waitFor(() => expect((screen.getByLabelText("Nombre del plan") as HTMLInputElement).value).toBe("Catálogo"));
    // Borrar pregunta antes: el diálogo dice que las corridas se quedan y ofrece archivar.
    fireEvent.click(screen.getAllByRole("button", { name: "Eliminar" })[1]);
    expect(await screen.findByText(/sale de la lista de planes/)).toBeTruthy();
    const dialog = screen.getByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Eliminar" }));
    await waitFor(() => expect((screen.getByLabelText("Nombre del plan") as HTMLInputElement).value).toBe("Checkout"));
    expect(mocks.api).toHaveBeenCalledWith(`${BASE}/performance/plans/pl1`, { method: "DELETE" });
  });

  test("un lector ve el plan pero no puede crear, guardar ni eliminar", async () => {
    mocks.canEdit.value = false;
    answersPlans([plan()]);
    draw("/p/p1/performance");
    const name = (await screen.findByLabelText("Nombre del plan")) as HTMLInputElement;
    await waitFor(() => expect(name.value).toBe("Catálogo"));
    expect(name.disabled).toBe(true);
    expect(screen.queryByRole("button", { name: "+ Nuevo" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Guardar" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Eliminar plan" })).toBeNull();
  });
});

/** El detalle pide la corrida y las demás del proyecto (para comparar). */
function answersRun(
  run: PerformanceRunDetailView | (() => PerformanceRunDetailView) | null,
  others: PerformanceRunSummaryView[] = [],
  extra: (path: string, options?: Options) => Promise<unknown> | undefined = () => undefined,
) {
  mocks.api.mockImplementation((path: string, options?: Options) => {
    const handled = extra(path, options);
    if (handled) return handled;
    if (options?.method) return Promise.resolve(undefined);
    if (path.endsWith("/performance/runs")) return Promise.resolve(others);
    if (path.endsWith("/performance/runs/run1")) return Promise.resolve(typeof run === "function" ? run() : run);
    // Lo que no se contesta (la página a la que se navega) se queda pendiente.
    return new Promise(() => undefined);
  });
}

describe("el detalle de una corrida de carga", () => {
  test("mientras carga lo dice; si no existe, lo dice", async () => {
    answersRun(null);
    draw("/p/p1/performance/run1");
    expect(screen.getByText("Cargando…")).toBeTruthy();
    await screen.findByText("La corrida no existe.");
  });

  test("una corrida terminada enseña métricas, umbrales, timeline y endpoints", async () => {
    answersRun(runDetail());
    draw("/p/p1/performance/run1");
    await screen.findByText("Catálogo");
    expect(screen.getByText("Superada")).toBeTruthy();
    expect(screen.getByText("10 usuarios · 30 s", { exact: false })).toBeTruthy();
    expect(screen.getByText("1200")).toBeTruthy();
    expect(screen.getByText("1.00%")).toBeTruthy();
    expect(screen.getByText("1.50 s")).toBeTruthy();
    expect(screen.getByText(/✓ p95 < 500 ms: 450 ms/)).toBeTruthy();
    expect(screen.getByText(/✗ errores < 0.5%: 1%/)).toBeTruthy();
    expect(screen.getByRole("img", { name: "Evolución de la corrida" })).toBeTruthy();
    expect(screen.getByText("10 s")).toBeTruthy();
    expect(screen.getByText("GET /products")).toBeTruthy();
    expect(screen.getByText("1.20%")).toBeTruthy();
    expect(mocks.streamRun).not.toHaveBeenCalled();
    // Sin otras corridas no hay nada con qué comparar.
    expect(screen.queryByRole("combobox")).toBeNull();
  });

  test("una corrida en curso se sigue en vivo y se vuelve a pedir en cada evento", async () => {
    let handlers: StreamHandlers | null = null;
    mocks.streamRun.mockImplementation((_path: string, h: StreamHandlers) => {
      handlers = h;
      return new Promise(() => undefined);
    });
    let current = runDetail({
      status: "running",
      summary: null,
      windows: [],
      endpoints: [],
      thresholds: [],
      progress: { elapsedS: 5, totalS: 30, requests: 100, vus: 4 },
    });
    answersRun(() => current);
    draw("/p/p1/performance/run1");
    await screen.findByText(/5\/30 s · 100 peticiones/);
    expect(mocks.streamRun).toHaveBeenCalledWith(`${BASE}/performance/runs/run1/stream`, expect.anything());
    expect(screen.getByRole("button", { name: "Cancelar" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Eliminar" })).toBeNull();

    current = { ...current, progress: { elapsedS: 20, totalS: 30, requests: 800, vus: 10 } };
    act(() => handlers!.onEvent({ type: "tick", data: {} }));
    await screen.findByText(/20\/30 s · 800 peticiones/);

    const signal = handlers!.signal;
    current = runDetail();
    act(() => handlers!.onEvent({ type: "finished", data: {} }));
    expect(signal.aborted).toBe(true);
    await screen.findByRole("button", { name: "Eliminar" });
    expect(screen.getByText("GET /products")).toBeTruthy();
  });

  test("si el stream falla la página no se rompe", async () => {
    mocks.streamRun.mockRejectedValue(new Error("nope"));
    answersRun(runDetail({ status: "queued", summary: null }));
    draw("/p/p1/performance/run1");
    await screen.findByText("En cola");
  });

  test("cancelar una corrida en curso lo pide al servidor", async () => {
    mocks.streamRun.mockReturnValue(new Promise(() => undefined));
    answersRun(runDetail({ status: "running" }));
    draw("/p/p1/performance/run1");
    fireEvent.click(await screen.findByRole("button", { name: "Cancelar" }));
    await waitFor(() =>
      expect(mocks.api).toHaveBeenCalledWith(`${BASE}/performance/runs/run1/cancel`, { method: "POST" }),
    );
  });

  test("eliminar una corrida terminada la borra y vuelve a los planes", async () => {
    answersRun(runDetail({ error: "Umbral de errores superado", status: "failed" }));
    draw("/p/p1/performance/run1");
    await screen.findByText("Umbral de errores superado");
    fireEvent.click(screen.getByRole("button", { name: "Eliminar" }));
    await waitFor(() => expect(screen.getByTestId("where").textContent).toBe("/p/p1/performance"));
    expect(mocks.api).toHaveBeenCalledWith(`${BASE}/performance/runs/run1`, { method: "DELETE" });
  });

  test("un lector no puede eliminar ni cancelar", async () => {
    mocks.canEdit.value = false;
    answersRun(runDetail());
    draw("/p/p1/performance/run1");
    await screen.findByText("Catálogo");
    expect(screen.queryByRole("button", { name: "Eliminar" })).toBeNull();
  });

  test("«← Pruebas de carga» vuelve a los planes", async () => {
    answersRun(runDetail());
    draw("/p/p1/performance/run1");
    fireEvent.click(await screen.findByRole("button", { name: "← Pruebas de carga" }));
    await waitFor(() => expect(screen.getByTestId("where").textContent).toBe("/p/p1/performance"));
  });

  test("comparar ofrece solo otras corridas terminadas y lleva a la comparación", async () => {
    answersRun(runDetail(), [
      runRow(),
      runRow({ id: "run0", status: "failed" }),
      runRow({ id: "runX", status: "running" }),
    ]);
    draw("/p/p1/performance/run1");
    const select = (await screen.findByRole("combobox")) as HTMLSelectElement;
    const options = within(select).getAllByRole("option");
    expect(options.map((o) => (o as HTMLOptionElement).value)).toEqual(["", "run0"]);
    fireEvent.change(select, { target: { value: "" } });
    expect(screen.getByTestId("where").textContent).toBe("/p/p1/performance/run1");
    fireEvent.change(select, { target: { value: "run0" } });
    await waitFor(() => expect(screen.getByTestId("where").textContent).toBe("/p/p1/performance/compare/run0/run1"));
  });
});

const comparison = (patch: Partial<PerformanceComparisonView> = {}): PerformanceComparisonView => ({
  base: { id: "run0", planName: "Catálogo", status: "failed", startedAt: "2026-03-01T09:00:00.000Z", summary },
  target: { id: "run1", planName: "Catálogo v2", status: "passed", startedAt: "2026-03-01T10:00:00.000Z", summary },
  metrics: [
    { metric: "p95Ms", label: "p95", base: 600, target: 450, delta: -150, pct: -0.25, better: "target" },
    { metric: "rps", label: "req/s", base: 40, target: 35, delta: -5, pct: -0.125, better: "base" },
    { metric: "errorRate", label: "Errores", base: 0.01, target: 0.02, delta: 0.01, pct: 1, better: "base" },
    { metric: "avgMs", label: "media", base: 100, target: 100, delta: 0, pct: 0, better: "same" },
    { metric: "p99Ms", label: "p99", base: 1000, target: 1200, delta: 200, pct: null, better: "base" },
  ],
  endpoints: [
    {
      method: "GET",
      path: "/products",
      base: { method: "GET", path: "/products", requests: 1, failures: 0, errorRate: 0, p95Ms: 500, avgMs: 1 },
      target: { method: "GET", path: "/products", requests: 1, failures: 0, errorRate: 0, p95Ms: 400, avgMs: 1 },
      p95Delta: -100,
      errorRateDelta: 0.005,
    },
    {
      method: "GET",
      path: "/slow",
      base: { method: "GET", path: "/slow", requests: 1, failures: 0, errorRate: 0, p95Ms: 100, avgMs: 1 },
      target: { method: "GET", path: "/slow", requests: 1, failures: 0, errorRate: 0, p95Ms: 300, avgMs: 1 },
      p95Delta: 200,
      errorRateDelta: -0.01,
    },
    {
      method: "GET",
      path: "/same",
      base: { method: "GET", path: "/same", requests: 1, failures: 0, errorRate: 0, p95Ms: 100, avgMs: 1 },
      target: { method: "GET", path: "/same", requests: 1, failures: 0, errorRate: 0, p95Ms: 100, avgMs: 1 },
      p95Delta: 0,
      errorRateDelta: 0,
    },
    {
      method: "DELETE",
      path: "/old",
      base: { method: "DELETE", path: "/old", requests: 1, failures: 0, errorRate: 0, p95Ms: 50, avgMs: 1 },
      target: null,
      p95Delta: null,
      errorRateDelta: null,
    },
    {
      method: "POST",
      path: "/new",
      base: null,
      target: { method: "POST", path: "/new", requests: 1, failures: 0, errorRate: 0, p95Ms: 70, avgMs: 1 },
      p95Delta: null,
      errorRateDelta: null,
    },
  ],
  thresholds: [
    { label: "p95 < 500 ms", base: { ok: false, actual: "600 ms" }, target: { ok: true, actual: "450 ms" } },
    { label: "req/s > 30", base: null, target: { ok: true, actual: "35" } },
  ],
  ...patch,
});

function answersCompare(result: PerformanceComparisonView | Error) {
  mocks.api.mockImplementation((path: string) => {
    if (path.includes("/performance/compare?"))
      return result instanceof Error ? Promise.reject(result) : Promise.resolve(result);
    if (path.endsWith("/performance/runs"))
      return Promise.resolve([
        runRow({ id: "run0", planName: "Catálogo", status: "failed" }),
        runRow({ id: "run1", planName: "Catálogo v2" }),
        runRow({ id: "run2", planName: "Otro" }),
        runRow({ id: "runX", planName: "En marcha", status: "running" }),
      ]);
    // Lo que no se contesta (la página a la que se navega) se queda pendiente.
    return new Promise(() => undefined);
  });
}

describe("comparar dos corridas", () => {
  test("pide la comparación y pinta cada delta según a quién favorece", async () => {
    answersCompare(comparison());
    draw("/p/p1/performance/compare/run0/run1");
    expect(screen.getByText("Cargando…")).toBeTruthy();
    await screen.findByText("Catálogo v2");
    expect(mocks.api).toHaveBeenCalledWith(`${BASE}/performance/compare?base=run0&target=run1`);

    const row = (label: string) => screen.getByRole("cell", { name: label }).closest("tr")!;
    const p95 = within(row("p95")).getAllByRole("cell");
    expect(p95[1].textContent).toBe("600 ms");
    expect(p95[3].textContent).toBe("-150 ms(-25.0%)");
    expect(p95[3].className).toContain("text-emerald-600");

    const rps = within(row("req/s")).getAllByRole("cell");
    expect(rps[1].textContent).toBe("40");
    expect(rps[3].textContent).toBe("-5(-12.5%)");
    expect(rps[3].className).toContain("text-rose-600");

    // La tasa de error se da en puntos y sin porcentaje relativo.
    const errors = within(row("Errores")).getAllByRole("cell");
    expect(errors[1].textContent).toBe("1.00%");
    expect(errors[3].textContent).toBe("+1.00 pt");

    // Un empate es gris y se escribe «=».
    const avg = within(row("media")).getAllByRole("cell");
    expect(avg[3].textContent).toBe("=(0.0%)");
    expect(avg[3].className).toContain("text-slate-400");

    const p99 = within(row("p99")).getAllByRole("cell");
    expect(p99[3].textContent).toBe("+200 ms");
  });

  test("los endpoints dicen si mejoran, empeoran, desaparecen o son nuevos; los umbrales, lado a lado", async () => {
    answersCompare(comparison());
    draw("/p/p1/performance/compare/run0/run1");
    await screen.findByText("GET /products");
    const cells = (label: string) => within(screen.getByText(label).closest("tr")!).getAllByRole("cell");
    expect(cells("GET /products")[3].textContent).toBe("-100 ms");
    expect(cells("GET /products")[3].className).toContain("text-emerald-600");
    expect(cells("GET /products")[4].textContent).toBe("+0.50 pt");
    expect(cells("GET /slow")[3].textContent).toBe("+200 ms");
    expect(cells("GET /slow")[3].className).toContain("text-rose-600");
    expect(cells("GET /slow")[4].textContent).toBe("-1.00 pt");
    expect(cells("GET /same")[3].className).toContain("text-slate-400");
    expect(cells("DELETE /old")[2].textContent).toBe("—");
    expect(cells("DELETE /old")[3].textContent).toBe("quitado");
    expect(cells("DELETE /old")[4].textContent).toBe("—");
    expect(cells("POST /new")[1].textContent).toBe("—");
    expect(cells("POST /new")[3].textContent).toBe("nuevo");

    expect(screen.getByText("✗ 600 ms")).toBeTruthy();
    expect(screen.getAllByText("✓ 450 ms").length).toBe(1);
    expect(screen.getByText("req/s > 30")).toBeTruthy();
  });

  test("sin métricas lo dice", async () => {
    answersCompare(comparison({ metrics: [], endpoints: [], thresholds: [] }));
    draw("/p/p1/performance/compare/run0/run1");
    await screen.findByText("Sin resumen que comparar");
  });

  test("si la comparación falla se enseña el error", async () => {
    answersCompare(new Error("Las corridas son de otro proyecto"));
    draw("/p/p1/performance/compare/run0/run1");
    await screen.findByText("Las corridas son de otro proyecto");
  });

  test("los selectores ofrecen las terminadas y cambian la base o la comparada, nunca la misma en los dos", async () => {
    answersCompare(comparison());
    draw("/p/p1/performance/compare/run0/run1");
    await screen.findByText("Catálogo v2");
    const [base, target] = screen.getAllByRole("combobox") as HTMLSelectElement[];
    expect(
      within(base)
        .getAllByRole("option")
        .map((o) => (o as HTMLOptionElement).value),
    ).toEqual(["run0", "run1", "run2"]);
    expect(base.value).toBe("run0");
    expect(target.value).toBe("run1");

    fireEvent.change(base, { target: { value: "run1" } });
    expect(screen.getByTestId("where").textContent).toBe("/p/p1/performance/compare/run0/run1");

    fireEvent.change(target, { target: { value: "run2" } });
    await waitFor(() => expect(screen.getByTestId("where").textContent).toBe("/p/p1/performance/compare/run0/run2"));
    fireEvent.change(screen.getAllByRole("combobox")[0], { target: { value: "run1" } });
    await waitFor(() => expect(screen.getByTestId("where").textContent).toBe("/p/p1/performance/compare/run1/run2"));
  });

  test("«← Pruebas de carga» vuelve a los planes", async () => {
    answersCompare(comparison());
    draw("/p/p1/performance/compare/run0/run1");
    fireEvent.click(screen.getByRole("button", { name: "← Pruebas de carga" }));
    await waitFor(() => expect(screen.getByTestId("where").textContent).toBe("/p/p1/performance"));
  });
});

describe("pruebas de carga: casos de borde", () => {
  test("cambiar un umbral deja el plan sin guardar y guardar manda la definición nueva", async () => {
    answersPlans([plan({ description: null })]);
    draw("/p/p1/performance");
    await waitFor(() => expect((screen.getByLabelText("Nombre del plan") as HTMLInputElement).value).toBe("Catálogo"));
    // Sin descripción, la caja sale vacía.
    expect((screen.getByLabelText("Descripción") as HTMLTextAreaElement).value).toBe("");
    fireEvent.change(screen.getByLabelText("p95 (ms)"), { target: { value: "800" } });
    expect(screen.getByText("Guarda los cambios antes de ejecutar.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Guardar" }));
    await waitFor(() => expect(calls().some(([, options]) => options?.method === "PUT")).toBe(true));
    const put = calls().find(([, options]) => options?.method === "PUT");
    expect((put?.[1]?.body as { definition: { thresholds: object } }).definition.thresholds).toEqual({
      p95Ms: 800,
      maxErrorRate: 0.01,
    });
  });

  test("si crear un plan falla, el error se enseña", async () => {
    answersPlans([plan()], (path, options) =>
      options?.method === "POST" && path.endsWith("/performance/plans")
        ? Promise.reject(new Error("Nombre repetido"))
        : undefined,
    );
    draw("/p/p1/performance");
    fireEvent.click(await screen.findByRole("button", { name: "+ Nuevo" }));
    fireEvent.change(await screen.findByPlaceholderText("Catálogo bajo carga"), { target: { value: "Catálogo" } });
    fireEvent.click(screen.getByRole("button", { name: "Crear" }));
    expect(await screen.findByText("Nombre repetido")).toBeTruthy();
  });

  test("una corrida con una sola ventana se dibuja igual, y sin historial no ofrece comparar", async () => {
    answersRun(runDetail({ windows: [runDetail().windows[0]!] }), [], (path, options) =>
      !options && path.endsWith("/performance/runs") ? Promise.reject(new Error("500")) : undefined,
    );
    draw("/p/p1/performance/run1");
    const chart = await screen.findByRole("img", { name: "Evolución de la corrida" });
    expect(chart.querySelector("rect")?.getAttribute("x")).not.toBe("NaN");
    expect(screen.getByText("5 s")).toBeTruthy();
    await waitFor(() => expect(mocks.api).toHaveBeenCalledWith(`${BASE}/performance/runs`));
    expect(screen.queryByRole("combobox")).toBeNull();
  });

  test("un delta que sube lleva su signo más, en valor y en porcentaje", async () => {
    answersCompare(
      comparison({
        metrics: [{ metric: "rps", label: "req/s", base: 40, target: 45, delta: 5, pct: 0.125, better: "target" }],
        endpoints: [],
        thresholds: [],
      }),
    );
    draw("/p/p1/performance/compare/run0/run1");
    const cell = await screen.findByText("+5");
    expect(cell.textContent).toBe("+5(+12.5%)");
    expect(cell.className).toContain("text-emerald-600");
  });
});
