/**
 * Las corridas de seguridad: la lista y el detalle.
 *
 * - La lista dice el estado, la puntuación y los hallazgos por severidad de cada corrida, y lanzar una
 *   nueva lleva a su detalle.
 * - El detalle sigue en vivo una corrida en curso (SSE) y la puede cancelar; una terminada se puede
 *   compartir, analizar, abrir como informe o eliminar (con confirmación).
 * - Los filtros y la página de peticiones viajan en la consulta al servidor.
 */
import { afterEach, describe, expect, test, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";

import { SecurityRunDetailPage, SecurityRunsPage } from "@/routes/security-runs";
import { ToastProvider } from "@/components/toast";
import type { SecurityFinding, SecurityProbe, SecurityRunDetailView, SecurityRunSummaryView } from "@/lib/types";

type StreamHandlers = { onEvent: (event: { type: string; data: unknown }) => void; signal: AbortSignal };

const mocks = vi.hoisted(() => ({
  api: vi.fn(),
  streamRun: vi.fn(),
  openReport: vi.fn(),
  canEdit: { value: true },
}));
vi.mock("@/lib/api", async (original) => ({
  ...(await original<object>()),
  api: mocks.api,
  streamRun: mocks.streamRun,
  openReport: mocks.openReport,
}));
vi.mock("@/lib/auth", () => ({
  useOrganization: () => ({ id: "o", name: "Org" }),
  useCan: () => mocks.canEdit.value,
}));

afterEach(() => {
  mocks.api.mockReset();
  mocks.streamRun.mockReset();
  mocks.openReport.mockReset();
  mocks.canEdit.value = true;
});

const BASE = "/orgs/o/projects/p1";

const summaryRun = (patch: Partial<SecurityRunSummaryView> = {}): SecurityRunSummaryView => ({
  id: "r1",
  label: "nocturna",
  status: "failed",
  score: 62,
  risk: "high",
  summary: {
    score: 62,
    risk: "high",
    findings: 3,
    bySeverity: { critical: 1, high: 2, medium: 0, low: 0, info: 4 },
    endpointsTested: 5,
    unprotected: [],
  },
  visibility: "private",
  startedAt: "2026-03-01T10:00:00.000Z",
  finishedAt: "2026-03-01T10:05:00.000Z",
  ...patch,
});

const finding = (patch: Partial<SecurityFinding> = {}): SecurityFinding => ({
  ruleKey: "bola_idor",
  ruleId: "BOLA-1",
  ruleName: "BOLA",
  category: "authz",
  severity: "critical",
  endpointId: "e1",
  title: "Un usuario lee pedidos ajenos",
  detail: "El pedido 2 se devolvió con el token del usuario 1.",
  remediation: "Comprueba el dueño del recurso.",
  references: ["https://owasp.org/API1"],
  reproduce: ["GET /orders/2 con token de u1"],
  evidence: {},
  ...patch,
});

const probe = (patch: Partial<SecurityProbe> = {}): SecurityProbe => ({
  id: "pr1",
  endpointId: "e1",
  testType: "no_auth",
  method: "GET",
  path: "/orders/2",
  credential: null,
  headers: {},
  body: null,
  status: 200,
  responseHeaders: {},
  bodyText: '{"id":2}',
  bodyBytes: 8,
  durationMs: 42,
  error: null,
  note: "",
  ...patch,
});

const detail = (patch: Partial<SecurityRunDetailView> = {}): SecurityRunDetailView => ({
  id: "r1",
  projectId: "p1",
  environmentId: "env-1",
  label: "nocturna",
  status: "failed",
  rules: {},
  options: {
    rateLimitIterations: 20,
    requestTimeoutMs: 5000,
    crossUserPermutations: false,
    endpointIds: [],
    adminRole: null,
  },
  progress: { phase: "hecho", percentage: 100, detail: "", endpointsTested: 5, endpointsTotal: 5 },
  score: 62,
  risk: "high",
  summary: {
    score: 62,
    risk: "high",
    findings: 3,
    bySeverity: { critical: 1, high: 2, medium: 0, low: 0, info: 0 },
    endpointsTested: 5,
    unprotected: [{ endpointId: "e1", method: "GET", path: "/orders/:id", status: 200 }],
  },
  findings: [finding()],
  findingsTotal: 1,
  probes: { data: [probe()], page: 1, pageSize: 50, total: 1 },
  ai: null,
  visibility: "private",
  shareToken: null,
  startedAt: "2026-03-01T10:00:00.000Z",
  finishedAt: "2026-03-01T10:05:00.000Z",
  error: null,
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
      <ToastProvider>
        <MemoryRouter initialEntries={[path]}>
          <Routes>
            <Route path="/p/:projectId/security" element={<SecurityRunsPage />} />
            <Route path="/p/:projectId/security/:runId" element={<SecurityRunDetailPage />} />
            <Route path="*" element={null} />
          </Routes>
          <Where />
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

const calls = () => mocks.api.mock.calls as [string, { method?: string; body?: unknown }?][];

describe("la lista de corridas de seguridad", () => {
  test("mientras carga lo dice, y sin corridas invita a lanzar la primera", async () => {
    let resolve: (value: SecurityRunSummaryView[]) => void = () => undefined;
    mocks.api.mockImplementation(() => new Promise((r) => (resolve = r)));
    draw("/p/p1/security");
    expect(screen.getByText("Cargando…")).toBeTruthy();
    act(() => resolve([]));
    await waitFor(() => expect(screen.getByText("Ninguna corrida de seguridad todavía")).toBeTruthy());
    expect(mocks.api).toHaveBeenCalledWith(`${BASE}/security-runs`);
    // El botón de cabecera y el del vacío.
    expect(screen.getAllByRole("button", { name: "Nueva corrida" })).toHaveLength(2);
  });

  test("sin permiso de edición no ofrece lanzar", async () => {
    mocks.canEdit.value = false;
    mocks.api.mockResolvedValue([]);
    draw("/p/p1/security");
    await waitFor(() => expect(screen.getByText("Ninguna corrida de seguridad todavía")).toBeTruthy());
    expect(screen.queryByRole("button", { name: "Nueva corrida" })).toBeNull();
  });

  test("enseña estado, puntuación, riesgo y hallazgos por severidad (sin contar info)", async () => {
    mocks.api.mockResolvedValue([
      summaryRun(),
      summaryRun({
        id: "r2",
        label: "limpia",
        status: "passed",
        score: 100,
        risk: "low",
        summary: {
          score: 100,
          risk: "low",
          findings: 0,
          bySeverity: { critical: 0, high: 0, medium: 0, low: 0, info: 2 },
          endpointsTested: 5,
          unprotected: [],
        },
      }),
      summaryRun({ id: "r3", label: "en marcha", status: "running", score: null, risk: null, summary: null }),
    ]);
    draw("/p/p1/security");
    await waitFor(() => expect(screen.getByText("nocturna")).toBeTruthy());
    const rows = screen.getAllByRole("row").slice(1);
    expect(within(rows[0]).getByText("Con hallazgos")).toBeTruthy();
    expect(within(rows[0]).getByText("62")).toBeTruthy();
    expect(within(rows[0]).getByText("Alto")).toBeTruthy();
    expect(within(rows[0]).getByText("1 Crítico")).toBeTruthy();
    expect(within(rows[0]).getByText("2 Alto")).toBeTruthy();
    expect(within(rows[0]).queryByText(/Info/)).toBeNull();
    expect(within(rows[1]).getByText("sin hallazgos")).toBeTruthy();
    expect(within(rows[1]).getByText("Sin fallos")).toBeTruthy();
    expect(within(rows[2]).getByText("En curso")).toBeTruthy();
    expect(within(rows[2]).getAllByText("—")).toHaveLength(2);
  });

  test("pulsar una fila o «Ver» lleva al detalle", async () => {
    mocks.api.mockImplementation((path: string) =>
      path.endsWith("/security-runs") ? Promise.resolve([summaryRun()]) : new Promise(() => undefined),
    );
    draw("/p/p1/security");
    await waitFor(() => expect(screen.getByText("nocturna")).toBeTruthy());
    fireEvent.click(screen.getByText("nocturna"));
    await waitFor(() => expect(screen.getByTestId("where").textContent).toBe("/p/p1/security/r1"));
  });

  test("«Ver» es un enlace al detalle", async () => {
    mocks.api.mockImplementation((path: string) =>
      path.endsWith("/security-runs") ? Promise.resolve([summaryRun()]) : new Promise(() => undefined),
    );
    draw("/p/p1/security");
    await waitFor(() => expect(screen.getByText("nocturna")).toBeTruthy());
    fireEvent.click(screen.getByRole("link", { name: "Ver" }));
    await waitFor(() => expect(screen.getByTestId("where").textContent).toBe("/p/p1/security/r1"));
  });

  test("lanzar una corrida la manda al servidor y lleva a su detalle", async () => {
    mocks.api.mockImplementation((path: string, options?: { method?: string }) => {
      if (options?.method === "POST") return Promise.resolve({ runId: "r9" });
      if (path.endsWith("/security-runs")) return Promise.resolve([]);
      if (path.endsWith("/environments"))
        return Promise.resolve([{ id: "env-1", name: "staging", active: true, credentials: [], variables: [] }]);
      if (path.endsWith("/roles")) return Promise.resolve([]);
      if (path.includes("/endpoints")) return Promise.resolve({ data: [] });
      return new Promise(() => undefined);
    });
    draw("/p/p1/security");
    await waitFor(() => expect(screen.getByText("Ninguna corrida de seguridad todavía")).toBeTruthy());
    fireEvent.click(screen.getAllByRole("button", { name: "Nueva corrida" })[0]);
    const launch = await screen.findByRole("button", { name: "Lanzar corrida" });
    await waitFor(() => expect((launch as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(launch);
    await waitFor(() => expect(screen.getByTestId("where").textContent).toBe("/p/p1/security/r9"));
    const post = calls().find(([, options]) => options?.method === "POST");
    expect(post?.[0]).toBe(`${BASE}/security-runs`);
    expect(post?.[1]?.body).toMatchObject({ environmentId: "env-1" });
  });

  test("cerrar el diálogo de nueva corrida no lanza nada", async () => {
    mocks.api.mockImplementation((path: string) => {
      if (path.endsWith("/security-runs")) return Promise.resolve([]);
      if (path.endsWith("/environments")) return Promise.resolve([]);
      if (path.endsWith("/roles")) return Promise.resolve([]);
      return Promise.resolve({ data: [] });
    });
    draw("/p/p1/security");
    await waitFor(() => expect(screen.getByText("Ninguna corrida de seguridad todavía")).toBeTruthy());
    fireEvent.click(screen.getAllByRole("button", { name: "Nueva corrida" })[1]);
    await screen.findByRole("button", { name: "Lanzar corrida" });
    fireEvent.click(screen.getByRole("button", { name: "Cancelar" }));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Lanzar corrida" })).toBeNull());
    expect(calls().some(([, options]) => options?.method === "POST")).toBe(false);
  });
});

/** El detalle pide dos cosas: la corrida (con su consulta) y los endpoints, para nombrarlos. */
function answersDetail(
  run: SecurityRunDetailView | (() => SecurityRunDetailView),
  extra: (path: string, options?: { method?: string; body?: unknown }) => Promise<unknown> | undefined = () =>
    undefined,
) {
  mocks.api.mockImplementation((path: string, options?: { method?: string; body?: unknown }) => {
    const handled = extra(path, options);
    if (handled) return handled;
    if (path.includes("/endpoints?"))
      return Promise.resolve({ data: [{ id: "e1", method: "GET", path: "/orders/:id" }] });
    if (path.includes("/security-runs/r1?")) return Promise.resolve(typeof run === "function" ? run() : run);
    if (options?.method) return Promise.resolve(undefined);
    // Lo que no se contesta (la lista a la que se vuelve) se queda pendiente.
    return new Promise(() => undefined);
  });
}

describe("el detalle de una corrida", () => {
  test("mientras carga lo dice; si no existe, lo dice", async () => {
    mocks.api.mockImplementation((path: string) =>
      path.includes("/security-runs/") ? Promise.reject(new Error("404")) : Promise.resolve({ data: [] }),
    );
    draw("/p/p1/security/r1");
    expect(screen.getByText("Cargando…")).toBeTruthy();
    await waitFor(() => expect(screen.getByText("No se encontró la corrida.")).toBeTruthy());
  });

  test("una corrida terminada enseña métricas, sin proteger, hallazgos y peticiones con el nombre del endpoint", async () => {
    answersDetail(detail());
    draw("/p/p1/security/r1");
    await waitFor(() => expect(screen.getByText("nocturna")).toBeTruthy());
    expect(mocks.api).toHaveBeenCalledWith(`${BASE}/security-runs/r1?page=1&pageSize=50`);
    expect(mocks.api).toHaveBeenCalledWith(`${BASE}/endpoints?status=all&limit=500`);
    expect(screen.getByText("Puntuación")).toBeTruthy();
    expect(screen.getByText("1 críticos")).toBeTruthy();
    expect(screen.getByText("Endpoints sin proteger")).toBeTruthy();
    expect(screen.getByText("Un usuario lee pedidos ajenos")).toBeTruthy();
    // El endpoint se nombra por método y ruta, no por id.
    await waitFor(() => expect(screen.getAllByText("GET /orders/:id").length).toBeGreaterThan(0));
    // Terminada: no se sigue en vivo.
    expect(mocks.streamRun).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Cancelar" })).toBeNull();
  });

  test("abrir un hallazgo enseña el detalle, cómo corregirlo, cómo reproducirlo y las referencias", async () => {
    answersDetail(detail());
    draw("/p/p1/security/r1");
    fireEvent.click(await screen.findByText("Un usuario lee pedidos ajenos"));
    expect(screen.getByText("El pedido 2 se devolvió con el token del usuario 1.")).toBeTruthy();
    expect(screen.getByText("Comprueba el dueño del recurso.")).toBeTruthy();
    expect(screen.getByText("GET /orders/2 con token de u1")).toBeTruthy();
    expect(screen.getByRole("link", { name: "owasp.org" }).getAttribute("href")).toBe("https://owasp.org/API1");
    fireEvent.click(screen.getByText("Un usuario lee pedidos ajenos"));
    expect(screen.queryByText("Comprueba el dueño del recurso.")).toBeNull();
  });

  test("un hallazgo sin endpoint ni pasos se enseña sin ellos, y un endpoint desconocido por su id corto", async () => {
    answersDetail(
      detail({
        findings: [
          finding({ endpointId: null, title: "Global", reproduce: [], references: [] }),
          finding({ endpointId: "abcdef1234567890", title: "Otro", ruleKey: "inexistente", ruleName: "Regla X" }),
        ],
      }),
    );
    draw("/p/p1/security/r1");
    fireEvent.click(await screen.findByText("Global"));
    expect(screen.queryByText("Reproducir")).toBeNull();
    expect(screen.getByText("abcdef12")).toBeTruthy();
    expect(screen.getByText("Regla X")).toBeTruthy();
  });

  test("una petición se abre para ver el cuerpo o el error; sin respuesta se dice así", async () => {
    answersDetail(
      detail({
        probes: {
          data: [probe(), probe({ id: "pr2", status: 0, bodyText: "", error: "ECONNRESET", path: "/boom" })],
          page: 1,
          pageSize: 50,
          total: 2,
        },
      }),
    );
    draw("/p/p1/security/r1");
    await screen.findByText("/boom");
    expect(screen.getByText("sin respuesta")).toBeTruthy();
    fireEvent.click(screen.getByText("/orders/2"));
    expect(screen.getByText('{"id":2}')).toBeTruthy();
    fireEvent.click(screen.getByText("/boom"));
    expect(screen.getByText("ECONNRESET")).toBeTruthy();
    expect(screen.getByText("(sin cuerpo)")).toBeTruthy();
  });

  test("sin hallazgos: una corrida limpia lo celebra, un filtro vacío lo dice", async () => {
    answersDetail(detail({ status: "passed", findings: [], findingsTotal: 0, summary: null }));
    draw("/p/p1/security/r1");
    await waitFor(() => expect(screen.getByText(/Sin hallazgos: la matriz no encontró nada/)).toBeTruthy());
  });

  test("los filtros de severidad, método y código viajan en la consulta", async () => {
    answersDetail(detail({ findings: [], status: "failed" }));
    draw("/p/p1/security/r1");
    await screen.findByText("Ningún hallazgo con este filtro.");
    const [severity, method, family] = screen.getAllByRole("combobox");
    fireEvent.change(severity, { target: { value: "critical" } });
    await waitFor(() =>
      expect(mocks.api).toHaveBeenCalledWith(`${BASE}/security-runs/r1?severity=critical&page=1&pageSize=50`),
    );
    fireEvent.change(method, { target: { value: "POST" } });
    await waitFor(() =>
      expect(mocks.api).toHaveBeenCalledWith(
        `${BASE}/security-runs/r1?severity=critical&method=POST&page=1&pageSize=50`,
      ),
    );
    fireEvent.change(family, { target: { value: "5" } });
    await waitFor(() =>
      expect(mocks.api).toHaveBeenCalledWith(
        `${BASE}/security-runs/r1?severity=critical&method=POST&statusFamily=5&page=1&pageSize=50`,
      ),
    );
  });

  test("la paginación de peticiones pide la página siguiente y la anterior", async () => {
    answersDetail(() => {
      const last =
        calls()
          .filter(([path]) => path.includes("/security-runs/r1?"))
          .at(-1)?.[0] ?? "";
      const page = Number(new URLSearchParams(last.split("?")[1]).get("page"));
      return detail({ probes: { data: [probe()], page, pageSize: 50, total: 120 } });
    });
    draw("/p/p1/security/r1");
    await screen.findByText("1 / 3");
    expect((screen.getByRole("button", { name: "Anterior" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Siguiente" }));
    await screen.findByText("2 / 3");
    expect(mocks.api).toHaveBeenCalledWith(`${BASE}/security-runs/r1?page=2&pageSize=50`);
    fireEvent.click(screen.getByRole("button", { name: "Siguiente" }));
    await screen.findByText("3 / 3");
    expect((screen.getByRole("button", { name: "Siguiente" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Anterior" }));
    await screen.findByText("2 / 3");
  });

  test("una corrida en curso se sigue en vivo: el progreso del stream y, al terminar, se vuelve a pedir", async () => {
    let handlers: StreamHandlers | null = null;
    mocks.streamRun.mockImplementation((_path: string, h: StreamHandlers) => {
      handlers = h;
      return new Promise(() => undefined);
    });
    let status: SecurityRunDetailView["status"] = "running";
    answersDetail(() =>
      detail({
        status,
        summary: null,
        findings: [],
        progress: { phase: "descubriendo", percentage: 10, detail: "1/5", endpointsTested: 1, endpointsTotal: 5 },
      }),
    );
    draw("/p/p1/security/r1");
    await screen.findByText("descubriendo");
    expect(mocks.streamRun).toHaveBeenCalledWith(`${BASE}/security-runs/r1/stream`, expect.anything());
    expect(screen.getByRole("button", { name: "Cancelar" })).toBeTruthy();
    // Ni informe ni eliminar hasta que termine.
    expect(screen.queryByRole("button", { name: "Informe" })).toBeNull();

    const before = calls().filter(([path]) => path.includes("/security-runs/r1?")).length;
    act(() =>
      handlers!.onEvent({ type: "progress", data: { progress: { percentage: 60, phase: "atacando", detail: "3/5" } } }),
    );
    await screen.findByText("atacando");
    expect(screen.getByText("3/5")).toBeTruthy();
    await waitFor(() =>
      expect(calls().filter(([path]) => path.includes("/security-runs/r1?")).length).toBeGreaterThan(before),
    );

    status = "passed";
    const signal = handlers!.signal;
    act(() => handlers!.onEvent({ type: "finished", data: {} }));
    await screen.findByRole("button", { name: "Informe" });
    expect(screen.queryByText("atacando")).toBeNull();
    // Al terminar se deja de escuchar.
    expect(signal.aborted).toBe(true);
  });

  test("si el stream no abre, la página no se rompe", async () => {
    mocks.streamRun.mockRejectedValue(new Error("no stream"));
    answersDetail(detail({ status: "queued", summary: null }));
    draw("/p/p1/security/r1");
    await screen.findByText("hecho");
    expect(screen.getByText("En cola")).toBeTruthy();
  });

  test("cancelar una corrida en curso lo pide al servidor y lo avisa", async () => {
    mocks.streamRun.mockReturnValue(new Promise(() => undefined));
    answersDetail(detail({ status: "running", summary: null }), (path, options) =>
      options?.method === "POST" ? Promise.resolve(undefined) : undefined,
    );
    draw("/p/p1/security/r1");
    fireEvent.click(await screen.findByRole("button", { name: "Cancelar" }));
    await screen.findByText("Cancelando…");
    expect(mocks.api).toHaveBeenCalledWith(`${BASE}/security-runs/r1/cancel`, { method: "POST" });
  });

  test("un lector no puede cancelar ni eliminar, pero sí abrir el informe", async () => {
    mocks.canEdit.value = false;
    answersDetail(detail());
    draw("/p/p1/security/r1");
    await screen.findByRole("button", { name: "Informe" });
    expect(screen.queryByRole("button", { name: "Eliminar" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Compartir" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Analizar con IA" })).toBeNull();
  });

  test("«Informe» abre el HTML de la corrida", async () => {
    mocks.openReport.mockResolvedValue(undefined);
    answersDetail(detail());
    draw("/p/p1/security/r1");
    fireEvent.click(await screen.findByRole("button", { name: "Informe" }));
    expect(mocks.openReport).toHaveBeenCalledWith(`${BASE}/security-runs/r1/report?format=html`);
  });

  test("compartir la hace pública y enseña el enlace; hacerla privada lo pide al revés", async () => {
    let visibility: "private" | "public" = "private";
    answersDetail(
      () => detail({ visibility, shareToken: visibility === "public" ? "tok123" : null }),
      (path, options) => {
        if (options?.method !== "PATCH") return undefined;
        visibility = (options.body as { visibility: "private" | "public" }).visibility;
        return Promise.resolve({ visibility, shareToken: "tok123" });
      },
    );
    draw("/p/p1/security/r1");
    fireEvent.click(await screen.findByRole("button", { name: "Compartir" }));
    await screen.findByText(/Enlace público: .*\/shared\/security-runs\/tok123/);
    expect(mocks.api).toHaveBeenCalledWith(`${BASE}/security-runs/r1/visibility`, {
      method: "PATCH",
      body: { visibility: "public" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Hacer privada" }));
    await waitFor(() => expect(screen.queryByText(/Enlace público/)).toBeNull());
    expect(mocks.api).toHaveBeenCalledWith(`${BASE}/security-runs/r1/visibility`, {
      method: "PATCH",
      body: { visibility: "private" },
    });
  });

  test("analizar con IA pide el análisis y enseña el resumen y lo más grave", async () => {
    let analysed = false;
    answersDetail(
      () =>
        detail({
          ai: analysed
            ? {
                executiveSummary: "La API expone pedidos ajenos.",
                scoreJustification: "Un crítico baja la nota.",
                top: [{ title: "BOLA en pedidos", description: "Cualquiera lee cualquiera.", severity: "critical" }],
                groups: [],
              }
            : null,
        }),
      (path) => {
        if (!path.endsWith("/ai")) return undefined;
        analysed = true;
        return Promise.resolve(undefined);
      },
    );
    draw("/p/p1/security/r1");
    fireEvent.click(await screen.findByRole("button", { name: "Analizar con IA" }));
    await screen.findByText("La API expone pedidos ajenos.");
    expect(mocks.api).toHaveBeenCalledWith(`${BASE}/security-runs/r1/ai`, { method: "POST" });
    expect(screen.getByText("Un crítico baja la nota.")).toBeTruthy();
    expect(screen.getByText("BOLA en pedidos")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Reanalizar" })).toBeTruthy();
  });

  test("si el análisis falla, se avisa con el error del servidor", async () => {
    answersDetail(detail(), (path) =>
      path.endsWith("/ai") ? Promise.reject(new Error("Sin clave de IA")) : undefined,
    );
    draw("/p/p1/security/r1");
    fireEvent.click(await screen.findByRole("button", { name: "Analizar con IA" }));
    await screen.findByText("Sin clave de IA");
  });

  test("eliminar pide confirmación; confirmado, borra y vuelve a la lista", async () => {
    answersDetail(detail(), (path, options) => (options?.method === "DELETE" ? Promise.resolve(undefined) : undefined));
    draw("/p/p1/security/r1");
    fireEvent.click(await screen.findByRole("button", { name: "Eliminar" }));
    const dialog = await screen.findByText("La corrida y sus hallazgos se eliminan. No se puede deshacer.");
    expect(dialog).toBeTruthy();
    expect(calls().some(([, options]) => options?.method === "DELETE")).toBe(false);
    const buttons = screen.getAllByRole("button", { name: "Eliminar" });
    fireEvent.click(buttons[buttons.length - 1]);
    await waitFor(() => expect(screen.getByTestId("where").textContent).toBe("/p/p1/security"));
    expect(mocks.api).toHaveBeenCalledWith(`${BASE}/security-runs/r1`, { method: "DELETE" });
  });

  test("cerrar la confirmación no borra; si el borrado falla, se avisa", async () => {
    answersDetail(detail(), (path, options) =>
      options?.method === "DELETE" ? Promise.reject(new Error("No se pudo eliminar")) : undefined,
    );
    draw("/p/p1/security/r1");
    fireEvent.click(await screen.findByRole("button", { name: "Eliminar" }));
    fireEvent.click(await screen.findByRole("button", { name: "Cancelar" }));
    await waitFor(() => expect(screen.queryByText(/No se puede deshacer/)).toBeNull());
    expect(calls().some(([, options]) => options?.method === "DELETE")).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: "Eliminar" }));
    const buttons = await screen.findAllByRole("button", { name: "Eliminar" });
    fireEvent.click(buttons[buttons.length - 1]);
    await screen.findByText("No se pudo eliminar");
    expect(screen.getByTestId("where").textContent).toBe("/p/p1/security/r1");
  });

  test("el error de la corrida se enseña", async () => {
    answersDetail(detail({ status: "error", error: "El entorno no respondió" }));
    draw("/p/p1/security/r1");
    await screen.findByText("El entorno no respondió");
  });
});

describe("casos de borde de las corridas de seguridad", () => {
  test("fuera de un proyecto la lista no pinta nada", () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { container } = render(
      <QueryClientProvider client={client}>
        <ToastProvider>
          <MemoryRouter initialEntries={["/security"]}>
            <Routes>
              <Route path="/security" element={<SecurityRunsPage />} />
            </Routes>
          </MemoryRouter>
        </ToastProvider>
      </QueryClientProvider>,
    );
    expect(container.textContent).toBe("");
    expect(mocks.api).not.toHaveBeenCalled();
  });

  test("si la lista no se puede pedir, se queda en el vacío en vez de romperse", async () => {
    mocks.api.mockRejectedValue(new Error("500"));
    draw("/p/p1/security");
    await waitFor(() => expect(screen.getByText("Ninguna corrida de seguridad todavía")).toBeTruthy());
  });

  test("una referencia que no es una URL absoluta se enseña tal cual y no rompe el detalle", async () => {
    answersDetail(detail({ findings: [finding({ references: ["/docs/api1", "https://owasp.org/API1"] })] }));
    draw("/p/p1/security/r1");
    fireEvent.click(await screen.findByText("Un usuario lee pedidos ajenos"));
    expect(screen.getByRole("link", { name: "/docs/api1" }).getAttribute("href")).toBe("/docs/api1");
    expect(screen.getByRole("link", { name: "owasp.org" })).toBeTruthy();
  });

  test("sin riesgo la puntuación va sola, y mientras se analiza el botón lo dice", async () => {
    answersDetail(detail({ risk: null }), (path) => (path.endsWith("/ai") ? new Promise(() => undefined) : undefined));
    draw("/p/p1/security/r1");
    const score = await screen.findByText("Puntuación");
    expect(score.parentElement?.textContent).toBe("Puntuación62");
    fireEvent.click(screen.getByRole("button", { name: "Analizar con IA" }));
    const busy = await screen.findByRole("button", { name: "Analizando…" });
    expect((busy as HTMLButtonElement).disabled).toBe(true);
  });
});
