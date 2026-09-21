/**
 * Las pantallas de colecciones: la lista, el editor y el informe de una corrida.
 *
 * Lo que fijan:
 * - La lista enseña lo que hay dentro y cómo acabó la última corrida, y «Importar» abre la puerta
 *   de import de siempre en vez de inventarse otra.
 * - El editor pinta el árbol, deja añadir, renombrar y borrar antes de guardar, y guarda el
 *   documento entero de una vez. «Enviar» manda la petición de pantalla con su `itemId`, que es lo
 *   que permite al servidor componer los scripts de encima.
 * - El informe crece en vivo con lo que llega por SSE y se puede cancelar.
 */
import { afterEach, describe, expect, test, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";

import { CollectionPage, CollectionRunPage, CollectionsPage } from "@/routes/collections";
import type {
  CollectionRunResultView,
  CollectionRunView,
  CollectionSummary,
  CollectionView,
} from "@/lib/types";

type Options = { method?: string; body?: unknown };
type StreamHandlers = { onEvent: (event: { type: string; data: unknown }) => void; signal: AbortSignal };

const mocks = vi.hoisted(() => ({
  api: vi.fn(),
  streamRun: vi.fn(),
  openImport: vi.fn(),
  canEdit: { value: true },
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
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
vi.mock("@/components/import-provider", () => ({ useImport: () => ({ open: mocks.openImport }) }));
vi.mock("@/components/toast", () => ({ useToast: () => mocks.toast }));

afterEach(() => {
  mocks.api.mockReset();
  mocks.streamRun.mockReset();
  mocks.openImport.mockReset();
  mocks.canEdit.value = true;
});

const BASE = "/orgs/o/projects/p1";
const calls = () => mocks.api.mock.calls as [string, Options?][];

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
          <Route path="/p/:projectId/collections" element={<CollectionsPage />} />
          <Route path="/p/:projectId/collections/:collectionId" element={<CollectionPage />} />
          <Route path="/p/:projectId/collections/runs/:runId" element={<CollectionRunPage />} />
        </Routes>
        <Where />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const summary = (patch: Partial<CollectionSummary> = {}): CollectionSummary => ({
  id: "col1",
  name: "Catálogo",
  description: "Los checks del catálogo",
  requests: 81,
  folders: 7,
  updatedAt: "2026-09-20T10:00:00.000Z",
  lastRun: { id: "run1", status: "failed", startedAt: "2026-09-20T11:00:00.000Z", failed: 2 },
  ...patch,
});

const view = (patch: Partial<CollectionView> = {}): CollectionView => ({
  id: "col1",
  projectId: "p1",
  name: "Catálogo",
  description: "",
  auth: { type: "bearer", params: { token: "{{token}}" } },
  variables: [{ key: "chk_run", value: "", enabled: true }],
  preRequestScript: "",
  postResponseScript: "",
  requests: 2,
  folders: 1,
  createdAt: "2026-09-01T10:00:00.000Z",
  updatedAt: "2026-09-20T10:00:00.000Z",
  items: [
    {
      id: "f1",
      kind: "folder",
      name: "01 · Productos",
      description: "",
      preRequestScript: "",
      postResponseScript: "",
      auth: { type: "inherit", params: {} },
      request: null,
      items: [
        {
          id: "r1",
          kind: "request",
          name: "Crear producto",
          description: "",
          preRequestScript: "",
          postResponseScript: "pm.test('crea', () => {});",
          auth: null,
          request: {
            method: "POST",
            url: "{{baseUrl}}/v1/products",
            pathParameters: [],
            query: [],
            headers: [{ name: "Accept", value: "application/json", enabled: true }],
            body: { mode: "json", text: '{"a":1}', contentType: "application/json", fields: [] },
            auth: { type: "inherit", params: {} },
          },
          items: [],
        },
        {
          id: "r2",
          kind: "request",
          name: "Leerlo",
          description: "",
          preRequestScript: "",
          postResponseScript: "",
          auth: null,
          request: {
            method: "GET",
            url: "{{baseUrl}}/v1/products/{{id}}",
            pathParameters: [],
            query: [],
            headers: [],
            body: { mode: "none", text: "", contentType: "text/plain", fields: [] },
            auth: { type: "inherit", params: {} },
          },
          items: [],
        },
      ],
    },
  ],
  ...patch,
});

const environments = [{ id: "env-1", name: "local", active: true, variables: {}, credentials: [] }];

/** Una petición del informe, con todo lo que el runner guarda de ella. */
const result = (patch: Partial<CollectionRunResultView> = {}): CollectionRunResultView => ({
  iteration: 1,
  itemId: "r1",
  name: "Crear producto",
  folder: "01 · Productos",
  method: "POST",
  url: "https://api/v1/products",
  status: 200,
  durationMs: 10,
  sizeBytes: 20,
  tests: [],
  error: null,
  logs: [],
  sent: null,
  received: null,
  auth: "",
  cookies: { sent: [], stored: [], rejected: [] },
  writes: [],
  scripts: { pre: null, post: null },
  ...patch,
});

const runView = (patch: Partial<CollectionRunView> = {}): CollectionRunView => ({
  id: "run1",
  collectionId: "col1",
  collectionName: "Catálogo",
  environmentId: "env-1",
  environmentName: "local",
  status: "passed",
  iterations: 1,
  delayMs: 0,
  stopOnFailure: false,
  folderId: null,
  folderName: null,
  totals: { requests: 2, failed: 1, tests: 3, testsPassed: 2, testsFailed: 1 },
  startedAt: "2026-09-20T11:00:00.000Z",
  finishedAt: "2026-09-20T11:00:30.000Z",
  error: null,
  results: [
    result({
      itemId: "r1",
      name: "Crear producto",
      method: "POST",
      url: "{{baseUrl}}/v1/products",
      status: 201,
      durationMs: 42,
      sizeBytes: 100,
      tests: [{ name: "crea", passed: true, message: null }],
      sent: {
        method: "POST",
        url: "https://api/v1/products",
        headers: { "Content-Type": "application/json" },
        body: '{"sku":"A1"}',
        bodyTruncated: false,
      },
      received: {
        status: 201,
        headers: { "x-request-id": "abc" },
        body: '{"id":7}',
        bodyTruncated: false,
        sizeBytes: 100,
        durationMs: 42,
        timing: { dnsMs: 1, ttfbMs: 40, downloadMs: 1 },
      },
      auth: "Bearer del entorno «local»",
      cookies: { sent: ["sid=api/"], stored: ["sid"], rejected: [{ line: "a=b; Domain=otro", why: "otro dominio" }] },
      writes: [{ key: "product_id", value: "7" }],
      scripts: { pre: { error: null, durationMs: 3 }, post: { error: null, durationMs: 5 } },
    }),
    result({
      itemId: "r2",
      name: "Leerlo",
      method: "GET",
      url: "https://api/v1/products/7",
      status: 404,
      durationMs: 10,
      sizeBytes: 20,
      tests: [{ name: "existe", passed: false, message: "esperaba 200" }],
      logs: [{ level: "warn", text: "ojo" }],
      sent: { method: "GET", url: "https://api/v1/products/7", headers: {}, body: null, bodyTruncated: false },
      received: {
        status: 404,
        headers: {},
        body: '{"detail":"no está"}',
        bodyTruncated: false,
        sizeBytes: 20,
        durationMs: 10,
        timing: { dnsMs: 0, ttfbMs: 9, downloadMs: 1 },
      },
    }),
  ],
  ...patch,
});

describe("la lista de colecciones", () => {
  test("enseña lo que hay dentro, el veredicto de la última corrida y abre el import de siempre", async () => {
    mocks.api.mockImplementation((path: string) =>
      path === `${BASE}/collections` ? Promise.resolve([summary()]) : Promise.resolve([]),
    );
    draw("/p/p1/collections");

    expect(await screen.findByText("Catálogo")).toBeTruthy();
    expect(screen.getByText("81 peticiones · 7 carpetas")).toBeTruthy();
    expect(screen.getByText("Rojo · 2 rojas")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Importar colección" }));
    expect(mocks.openImport).toHaveBeenCalled();
  });

  test("una colección sin carpetas ni corridas se enseña igual, sin inventarse nada", async () => {
    mocks.api.mockResolvedValue([summary({ folders: 0, description: "", lastRun: null })]);
    draw("/p/p1/collections");
    expect(await screen.findByText("81 peticiones")).toBeTruthy();
    expect(screen.getByText("Sin corridas")).toBeTruthy();
  });

  test("una última corrida en verde no cuenta rojas", async () => {
    mocks.api.mockResolvedValue([
      summary({ lastRun: { id: "run1", status: "passed", startedAt: "2026-09-20T11:00:00.000Z", failed: 0 } }),
    ]);
    draw("/p/p1/collections");
    expect(await screen.findByText("Verde")).toBeTruthy();
  });

  test("sin ninguna, lo dice y ofrece traerla; crear una lleva a su editor", async () => {
    mocks.api.mockImplementation((path: string, options?: Options) => {
      if (path === `${BASE}/collections` && !options) return Promise.resolve([]);
      if (options?.method === "POST") return Promise.resolve({ id: "nueva" });
      return Promise.resolve([]);
    });
    draw("/p/p1/collections");

    expect(await screen.findByText("Todavía no hay ninguna colección")).toBeTruthy();
    // El botón de la pantalla vacía es la misma puerta que el de la cabecera.
    fireEvent.click(screen.getAllByRole("button", { name: "Importar colección" })[1]);
    expect(mocks.openImport).toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Nueva colección" }));
    // Y se puede cerrar sin crear nada.
    fireEvent.click(screen.getByRole("button", { name: "Cancelar" }));
    expect(screen.queryByLabelText("Nombre")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Nueva colección" }));
    fireEvent.change(screen.getByLabelText("Nombre"), { target: { value: "Mía" } });
    fireEvent.click(screen.getByRole("button", { name: "Crear" }));

    await waitFor(() => expect(screen.getByTestId("where").textContent).toBe("/p/p1/collections/nueva"));
    expect(calls().find(([, options]) => options?.method === "POST")?.[1]?.body).toEqual({ name: "Mía" });
  });

  test("un fallo sin mensaje al crear tiene el suyo", async () => {
    mocks.api.mockImplementation((path: string, options?: Options) => {
      if (options?.method === "POST") return Promise.reject("nada");
      return Promise.resolve([]);
    });
    draw("/p/p1/collections");
    await screen.findByText("Todavía no hay ninguna colección");
    fireEvent.click(screen.getByRole("button", { name: "Nueva colección" }));
    fireEvent.change(screen.getByLabelText("Nombre"), { target: { value: "Mía" } });
    fireEvent.click(screen.getByRole("button", { name: "Crear" }));
    await waitFor(() => expect(mocks.toast.error).toHaveBeenCalledWith("No se pudo crear"));
  });

  test("quien solo mira no ve el botón de crear", async () => {
    mocks.canEdit.value = false;
    mocks.api.mockResolvedValue([summary()]);
    draw("/p/p1/collections");
    await screen.findByText("Catálogo");
    expect(screen.queryByRole("button", { name: "Nueva colección" })).toBeNull();
  });
});

describe("el editor de una colección", () => {
  const answers = (over: (path: string, options?: Options) => unknown = () => undefined) =>
    mocks.api.mockImplementation((path: string, options?: Options) => {
      const custom = over(path, options);
      if (custom !== undefined) return Promise.resolve(custom);
      if (path === `${BASE}/collections/col1`) return Promise.resolve(view());
      if (path === `${BASE}/environments`) return Promise.resolve(environments);
      return Promise.resolve({});
    });

  test("pinta el árbol y abre una petición con su método, su URL y sus tests", async () => {
    answers();
    draw("/p/p1/collections/col1");

    expect(await screen.findByText("01 · Productos")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Crear producto" }));

    expect((screen.getByLabelText("URL") as HTMLInputElement).value).toBe("{{baseUrl}}/v1/products");
    expect((screen.getByLabelText("Método") as HTMLSelectElement).value).toBe("POST");
    fireEvent.click(screen.getByRole("button", { name: "Scripts" }));
    expect((screen.getByLabelText("Tests") as HTMLTextAreaElement).value).toBe("pm.test('crea', () => {});");
  });

  test("añadir una petición marca el borrador y guardar manda el documento entero", async () => {
    answers();
    draw("/p/p1/collections/col1");
    await screen.findByText("01 · Productos");

    fireEvent.click(screen.getByRole("button", { name: "Nueva petición" }));
    expect(screen.getByText("Sin guardar")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Guardar" }));
    await waitFor(() => expect(calls().some(([, options]) => options?.method === "PUT")).toBe(true));
    const [path, options] = calls().find(([, item]) => item?.method === "PUT")!;
    expect(path).toBe(`${BASE}/collections/col1`);
    const body = options!.body as { document: { items: { id: string }[] } };
    expect(body.document.items).toHaveLength(2);
  });

  test("borrar un nodo pide confirmación y se queda en el borrador", async () => {
    answers();
    draw("/p/p1/collections/col1");
    await screen.findByText("01 · Productos");

    fireEvent.click(screen.getByRole("button", { name: "Eliminar Crear producto" }));
    expect(screen.getByText("Eliminar Crear producto")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Eliminar" }));

    await waitFor(() => expect(screen.queryByRole("button", { name: "Crear producto" })).toBeNull());
    expect(screen.getByText("Sin guardar")).toBeTruthy();
  });

  test("«Enviar» manda lo que hay en pantalla con el itemId de dónde vive", async () => {
    answers((path, options) =>
      path === `${BASE}/collections/col1/send` && options?.method === "POST"
        ? {
            request: { method: "POST", url: "https://api/v1/products", headers: {}, body: null },
            response: { status: 201, headers: {}, body: '{"id":7}', sizeBytes: 8, durationMs: 12, timing: { dnsMs: 0, ttfbMs: 0, downloadMs: 0 } },
            error: null,
            auth: "—",
            environment: { id: "env-1", name: "local" },
            scripts: { pre: null, post: { error: null, logs: [], tests: [{ name: "crea", passed: true, message: null }], environmentUpdates: [], visualization: null, durationMs: 1 } },
            sessionToken: null,
            cookies: { sent: [], stored: [], rejected: [] },
            variables: { id: "7" },
          }
        : undefined,
    );
    draw("/p/p1/collections/col1");
    await screen.findByText("01 · Productos");
    fireEvent.click(screen.getByRole("button", { name: "Crear producto" }));
    fireEvent.click(screen.getByRole("button", { name: "Enviar" }));

    await waitFor(() => expect(screen.getByText("201")).toBeTruthy());
    const sent = calls().find(([path]) => path.endsWith("/send"))![1]!.body as { itemId: string };
    expect(sent.itemId).toBe("r1");
    fireEvent.click(screen.getByRole("button", { name: "Tests" }));
    expect(screen.getByText(/✓ crea/)).toBeTruthy();
  });

  test("«Correr» pregunta contra qué y lleva al informe", async () => {
    answers((path, options) =>
      path === `${BASE}/collections/col1/runs` && options?.method === "POST" ? { runId: "run9" } : undefined,
    );
    draw("/p/p1/collections/col1");
    await screen.findByText("01 · Productos");

    fireEvent.click(screen.getByRole("button", { name: "Correr" }));
    fireEvent.change(screen.getByLabelText("Vueltas"), { target: { value: "3" } });
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Correr" }));

    await waitFor(() => expect(screen.getByTestId("where").textContent).toBe("/p/p1/collections/runs/run9"));
    expect(calls().find(([path]) => path.endsWith("/runs"))![1]!.body).toEqual({
      environmentId: "env-1",
      iterations: 3,
      delayMs: 0,
      stopOnFailure: false,
      folderId: null,
    });
  });

  test("correr una carpeta manda su id", async () => {
    answers((path, options) =>
      path === `${BASE}/collections/col1/runs` && options?.method === "POST" ? { runId: "run9" } : undefined,
    );
    draw("/p/p1/collections/col1");
    await screen.findByText("01 · Productos");

    fireEvent.click(screen.getByRole("button", { name: "Correr 01 · Productos" }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Correr" }));
    await waitFor(() => expect(calls().some(([path]) => path.endsWith("/runs"))).toBe(true));
    expect((calls().find(([path]) => path.endsWith("/runs"))![1]!.body as { folderId: string }).folderId).toBe("f1");
  });
});

describe("el informe de una corrida", () => {
  test("enseña los totales y cada petición con sus tests", async () => {
    mocks.api.mockResolvedValue(runView());
    draw("/p/p1/collections/runs/run1");

    expect(await screen.findByText("Catálogo")).toBeTruthy();
    expect(screen.getByText("Verde")).toBeTruthy();
    expect(screen.getByText("Crear producto")).toBeTruthy();
    expect(screen.getByText("404")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /Leerlo/ }));
    // El resumen es lo primero: por qué falló, con qué credencial fue y qué dejó escrito.
    // El estado sale dos veces: en la fila y en el resumen de la que está abierta.
    expect(screen.getAllByText("404").length).toBe(2);
    expect(screen.getByText("existe — esperaba 200")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Tests (1)" }));
    expect(screen.getByText(/✕ existe — esperaba 200/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Consola (1)" }));
    expect(screen.getByText(/\[warn\] ojo/)).toBeTruthy();
  });

  test("una corrida en marcha crece con lo que llega por el stream, y se puede cancelar", async () => {
    let push: StreamHandlers["onEvent"] = () => {};
    mocks.streamRun.mockImplementation((_path: string, handlers: StreamHandlers) => {
      push = handlers.onEvent;
      return new Promise(() => {});
    });
    mocks.api.mockImplementation((path: string, options?: Options) =>
      options?.method === "POST"
        ? Promise.resolve(undefined)
        : Promise.resolve(runView({ status: "running", results: [], totals: { requests: 0, failed: 0, tests: 0, testsPassed: 0, testsFailed: 0 } })),
    );
    draw("/p/p1/collections/runs/run1");

    await waitFor(() => expect(mocks.streamRun).toHaveBeenCalled());
    expect(screen.getByText("Todavía no ha terminado ninguna.")).toBeTruthy();

    act(() =>
      push({
        type: "result",
        data: {
          status: "running",
          totals: { requests: 1, failed: 0, tests: 1, testsPassed: 1, testsFailed: 0 },
          result: runView().results[0],
        },
      }),
    );
    await waitFor(() => expect(screen.getByText("Crear producto")).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: "Cancelar" }));
    await waitFor(() => expect(calls().some(([path]) => path.endsWith("/cancel"))).toBe(true));
  });
});

describe("la colección misma", () => {
  const answers = (over: (path: string, options?: Options) => unknown = () => undefined) =>
    mocks.api.mockImplementation((path: string, options?: Options) => {
      const custom = over(path, options);
      if (custom !== undefined) return Promise.resolve(custom);
      if (path === `${BASE}/collections/col1`) return Promise.resolve(view());
      if (path === `${BASE}/environments`) return Promise.resolve(environments);
      return Promise.resolve({});
    });

  test("mientras carga no pinta el editor", () => {
    mocks.api.mockImplementation(() => new Promise(() => {}));
    draw("/p/p1/collections/col1");
    expect(screen.getByText("Cargando…")).toBeTruthy();
  });

  test("sin nada elegido se edita la colección: descripción, variables, auth y scripts", async () => {
    answers();
    draw("/p/p1/collections/col1");
    await screen.findByText("01 · Productos");

    fireEvent.change(screen.getByDisplayValue("Catálogo"), { target: { value: "Catálogo v2" } });
    const description = screen.getAllByRole("textbox").find((node) => node.tagName === "TEXTAREA")!;
    fireEvent.change(description, { target: { value: "Los checks" } });
    fireEvent.change(screen.getByLabelText("Tipo"), { target: { value: "none" } });
    fireEvent.change(screen.getByLabelText("Script previo"), { target: { value: "const a = 1" } });

    fireEvent.click(screen.getByRole("button", { name: "Guardar" }));
    await waitFor(() => expect(calls().some(([, options]) => options?.method === "PUT")).toBe(true));
    const body = calls().find(([, options]) => options?.method === "PUT")![1]!.body as {
      name: string;
      description: string;
      document: { auth: { type: string }; preRequestScript: string };
    };
    expect(body.name).toBe("Catálogo v2");
    expect(body.description).toBe("Los checks");
    expect(body.document.auth.type).toBe("none");
    expect(body.document.preRequestScript).toBe("const a = 1");
    expect(mocks.toast.success).toHaveBeenCalledWith("Colección guardada");
  });

  test("elegir «La colección» vuelve a sus ajustes desde una petición", async () => {
    answers();
    draw("/p/p1/collections/col1");
    await screen.findByText("01 · Productos");
    fireEvent.click(screen.getByRole("button", { name: "Crear producto" }));
    expect(screen.getByLabelText("URL")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "La colección" }));
    expect(screen.queryByLabelText("URL")).toBeNull();
  });

  test("guardar un nombre que ya existe enseña lo que dijo el servidor", async () => {
    answers((path, options) => {
      if (options?.method === "PUT") return Promise.reject(new Error("Ya hay una colección llamada «Catálogo»"));
      return undefined;
    });
    draw("/p/p1/collections/col1");
    await screen.findByText("01 · Productos");
    fireEvent.click(screen.getByRole("button", { name: "Nueva carpeta" }));
    fireEvent.click(screen.getByRole("button", { name: "Guardar" }));
    await waitFor(() => expect(mocks.toast.error).toHaveBeenCalledWith("Ya hay una colección llamada «Catálogo»"));
  });

  test("exportar baja el fichero y avisa de las credenciales que salen vacías", async () => {
    const click = vi.fn();
    const create = vi.spyOn(document, "createElement");
    create.mockImplementation((tag: string) => {
      const node = Object.getPrototypeOf(document).createElement.call(document, tag) as HTMLAnchorElement;
      if (tag === "a") node.click = click;
      return node;
    });
    URL.createObjectURL = vi.fn(() => "blob:x");
    URL.revokeObjectURL = vi.fn();

    answers((path) =>
      path === `${BASE}/collections/col1/export`
        ? { name: "Catálogo", file: { info: { name: "Catálogo" } }, redacted: ["Crear producto (token)"] }
        : undefined,
    );
    draw("/p/p1/collections/col1");
    await screen.findByText("01 · Productos");
    fireEvent.click(screen.getByRole("button", { name: "Exportar" }));

    await waitFor(() => expect(click).toHaveBeenCalled());
    expect(mocks.toast.info).toHaveBeenCalledWith("Credenciales que salen vacías: Crear producto (token)");
    create.mockRestore();
  });

  test("exportar cuando el servidor dice que no, lo dice", async () => {
    answers((path) => (path.endsWith("/export") ? Promise.reject(new Error("no se pudo")) : undefined));
    draw("/p/p1/collections/col1");
    await screen.findByText("01 · Productos");
    fireEvent.click(screen.getByRole("button", { name: "Exportar" }));
    await waitFor(() => expect(mocks.toast.error).toHaveBeenCalledWith("no se pudo"));
  });

  test("eliminar la colección pide confirmación y vuelve a la lista", async () => {
    answers();
    draw("/p/p1/collections/col1");
    await screen.findByText("01 · Productos");
    fireEvent.click(screen.getByRole("button", { name: "Eliminar la colección" }));
    fireEvent.click(screen.getByRole("button", { name: "Eliminar" }));
    await waitFor(() => expect(screen.getByTestId("where").textContent).toBe("/p/p1/collections"));
  });

  test("duplicar una petición la deja al lado, dentro de su carpeta", async () => {
    answers();
    draw("/p/p1/collections/col1");
    await screen.findByText("01 · Productos");
    fireEvent.click(screen.getByRole("button", { name: "Duplicar Crear producto" }));
    expect(screen.getByRole("button", { name: "Crear producto (copia)" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Guardar" }));
    await waitFor(() => expect(calls().some(([, options]) => options?.method === "PUT")).toBe(true));
    const body = calls().find(([, options]) => options?.method === "PUT")![1]!.body as {
      document: { items: { items: { name: string }[] }[] };
    };
    expect(body.document.items[0].items.map((item) => item.name)).toEqual([
      "Crear producto",
      "Leerlo",
      "Crear producto (copia)",
    ]);
  });

  test("subir una petición cambia el orden del borrador", async () => {
    answers();
    draw("/p/p1/collections/col1");
    await screen.findByText("01 · Productos");
    fireEvent.click(screen.getByRole("button", { name: "Subir Leerlo" }));
    fireEvent.click(screen.getByRole("button", { name: "Guardar" }));
    await waitFor(() => expect(calls().some(([, options]) => options?.method === "PUT")).toBe(true));
    const body = calls().find(([, options]) => options?.method === "PUT")![1]!.body as {
      document: { items: { items: { name: string }[] }[] };
    };
    expect(body.document.items[0].items.map((item) => item.name)).toEqual(["Leerlo", "Crear producto"]);
  });

  test("el buscador estrecha el árbol", async () => {
    answers();
    draw("/p/p1/collections/col1");
    await screen.findByText("01 · Productos");
    fireEvent.change(screen.getByLabelText("Buscar en la colección"), { target: { value: "leer" } });
    expect(screen.queryByRole("button", { name: "Crear producto" })).toBeNull();
    expect(screen.getByRole("button", { name: "Leerlo" })).toBeTruthy();
  });

  test("con cambios sin guardar, el diálogo de correr avisa de que corre lo guardado", async () => {
    answers();
    draw("/p/p1/collections/col1");
    await screen.findByText("01 · Productos");
    fireEvent.click(screen.getByRole("button", { name: "Nueva carpeta" }));
    fireEvent.click(screen.getByRole("button", { name: "Correr" }));
    expect(screen.getByText(/la corrida usa lo guardado/)).toBeTruthy();

    // Y se puede cerrar sin lanzar nada.
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Cancelar" }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  test("se puede correr sin entorno, y el fallo al lanzar se dice", async () => {
    answers((path, options) =>
      path.endsWith("/runs") && options?.method === "POST" ? Promise.reject(new Error("no hay peticiones")) : undefined,
    );
    draw("/p/p1/collections/col1");
    await screen.findByText("01 · Productos");
    fireEvent.click(screen.getByRole("button", { name: "Correr" }));
    fireEvent.change(screen.getByLabelText("Entorno"), { target: { value: "" } });
    fireEvent.change(screen.getByLabelText("Espera entre peticiones (ms)"), { target: { value: "50" } });
    fireEvent.click(screen.getByLabelText("Parar en la primera roja"));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Correr" }));

    await waitFor(() => expect(mocks.toast.error).toHaveBeenCalledWith("no hay peticiones"));
    expect(calls().find(([path]) => path.endsWith("/runs"))![1]!.body).toMatchObject({
      environmentId: null,
      delayMs: 50,
      stopOnFailure: true,
    });
  });

  test("quien solo mira no guarda ni borra, y la carpeta abre su editor", async () => {
    mocks.canEdit.value = false;
    answers();
    draw("/p/p1/collections/col1");
    await screen.findByText("01 · Productos");
    expect(screen.queryByRole("button", { name: "Guardar" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Eliminar la colección" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "01 · Productos" }));
    expect(screen.getByText("Autenticación de la carpeta")).toBeTruthy();
  });

  test("crear una carpeta en la raíz la deja al final y la abre", async () => {
    answers();
    draw("/p/p1/collections/col1");
    await screen.findByText("01 · Productos");
    fireEvent.click(screen.getByRole("button", { name: "Nueva carpeta" }));
    expect(screen.getByText("Scripts de la carpeta")).toBeTruthy();
    expect(screen.getByDisplayValue("Nueva carpeta")).toBeTruthy();
  });
});

describe("el informe, casos sueltos", () => {
  test("una corrida con error de arranque lo enseña y no ofrece cancelar", async () => {
    mocks.api.mockResolvedValue(
      runView({ status: "error", error: "La colección se borró antes de que la corrida empezara", results: [] }),
    );
    draw("/p/p1/collections/runs/run1");
    expect(await screen.findByText("La colección se borró antes de que la corrida empezara")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Cancelar" })).toBeNull();
  });

  test("mientras no llega, dice que carga; una corrida de una carpeta lo dice en el título", async () => {
    mocks.api.mockImplementation(() => new Promise(() => {}));
    const { unmount } = draw("/p/p1/collections/runs/run1");
    expect(screen.getByText("Cargando…")).toBeTruthy();
    unmount();

    mocks.api.mockResolvedValue(runView({ folderId: "f1", folderName: "01 · Productos", iterations: 2 }));
    draw("/p/p1/collections/runs/run1");
    expect(await screen.findByText("Catálogo · 01 · Productos")).toBeTruthy();
    expect(screen.getByText(/2 vueltas/)).toBeTruthy();
    // Con más de una vuelta, cada fila dice de cuál es.
    expect(screen.getAllByText("#1").length).toBe(2);
  });

  test("el informe se filtra por rojas, por verdes y por lo que se busque", async () => {
    mocks.api.mockResolvedValue(runView());
    draw("/p/p1/collections/runs/run1");
    await screen.findByText("Crear producto");

    fireEvent.click(screen.getByRole("button", { name: "Rojas (1)" }));
    expect(screen.queryByText("Crear producto")).toBeNull();
    expect(screen.getByText("Leerlo")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Verdes (1)" }));
    expect(screen.getByText("Crear producto")).toBeTruthy();
    expect(screen.queryByText("Leerlo")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Todas (2)" }));
    fireEvent.change(screen.getByLabelText("Buscar en la corrida"), { target: { value: "products/7" } });
    expect(screen.getByText("Leerlo")).toBeTruthy();
    expect(screen.queryByText("Crear producto")).toBeNull();

    fireEvent.change(screen.getByLabelText("Buscar en la corrida"), { target: { value: "nada de nada" } });
    expect(screen.getByText("Ninguna petición encaja con lo que buscas.")).toBeTruthy();
  });

  test("las filas se despliegan y se pliegan todas a la vez", async () => {
    mocks.api.mockResolvedValue(runView());
    draw("/p/p1/collections/runs/run1");
    await screen.findByText("Crear producto");

    fireEvent.click(screen.getByRole("button", { name: "Desplegar todas" }));
    expect(screen.getAllByRole("button", { name: "Resumen" })).toHaveLength(2);

    fireEvent.click(screen.getByRole("button", { name: "Plegar todas" }));
    expect(screen.queryByRole("button", { name: "Resumen" })).toBeNull();
  });

  test("mientras corre, la barra dice cuántas van", async () => {
    let push: StreamHandlers["onEvent"] = () => {};
    mocks.streamRun.mockImplementation((_path: string, handlers: StreamHandlers) => {
      push = handlers.onEvent;
      return new Promise(() => {});
    });
    // Sin `finishedAt`: mientras corre no hay duración que contar todavía.
    mocks.api.mockResolvedValue(runView({ status: "running", results: [], finishedAt: null }));
    draw("/p/p1/collections/runs/run1");
    await waitFor(() => expect(mocks.streamRun).toHaveBeenCalled());
    expect(screen.queryByText(/duró/)).toBeNull();

    act(() =>
      push({
        type: "result",
        data: {
          status: "running",
          totals: { requests: 1, failed: 0, tests: 0, testsPassed: 0, testsFailed: 0 },
          result: runView().results[0],
          progress: { done: 1, total: 4 },
        },
      }),
    );
    expect(await screen.findByText("1 de 4 peticiones")).toBeTruthy();
  });

  test("los ajustes con los que se lanzó se cuentan, y lo que no salió se busca por su URL escrita", async () => {
    mocks.api.mockResolvedValue(
      runView({
        delayMs: 250,
        stopOnFailure: true,
        results: [result({ sent: null, status: null, error: "no se envió", url: "{{baseUrl}}/v1/products" })],
      }),
    );
    draw("/p/p1/collections/runs/run1");

    expect(await screen.findByText(/250 ms entre peticiones/)).toBeTruthy();
    expect(screen.getByText(/para en la primera roja/)).toBeTruthy();
    expect(screen.getByText(/duró 30.0 s/)).toBeTruthy();

    fireEvent.change(screen.getByLabelText("Buscar en la corrida"), { target: { value: "{{baseurl}}" } });
    expect(screen.getByText("Crear producto")).toBeTruthy();
  });

  test("si el stream se cae, lo persistido sigue en pantalla", async () => {
    mocks.streamRun.mockRejectedValue(new Error("se cortó"));
    mocks.api.mockResolvedValue(runView({ status: "running" }));
    draw("/p/p1/collections/runs/run1");
    expect(await screen.findByText("Crear producto")).toBeTruthy();
  });
});

describe("los bordes del editor y del informe", () => {
  const answers = (over: (path: string, options?: Options) => unknown = () => undefined, environs = environments) =>
    mocks.api.mockImplementation((path: string, options?: Options) => {
      const custom = over(path, options);
      if (custom !== undefined) return Promise.resolve(custom);
      if (path === `${BASE}/collections/col1`) return Promise.resolve(view());
      if (path === `${BASE}/environments`) return Promise.resolve(environs);
      return Promise.resolve({});
    });

  test("los fallos sin mensaje tienen el suyo: guardar, exportar y lanzar", async () => {
    answers((path, options) => {
      if (options?.method === "PUT" || path.endsWith("/export") || path.endsWith("/runs")) return Promise.reject("nada");
      return undefined;
    });
    draw("/p/p1/collections/col1");
    await screen.findByText("01 · Productos");

    fireEvent.click(screen.getByRole("button", { name: "Nueva carpeta" }));
    fireEvent.click(screen.getByRole("button", { name: "Guardar" }));
    await waitFor(() => expect(mocks.toast.error).toHaveBeenCalledWith("No se pudo guardar"));

    fireEvent.click(screen.getByRole("button", { name: "Exportar" }));
    await waitFor(() => expect(mocks.toast.error).toHaveBeenCalledWith("No se pudo exportar"));

    fireEvent.click(screen.getByRole("button", { name: "Correr" }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Correr" }));
    await waitFor(() => expect(mocks.toast.error).toHaveBeenCalledWith("No se pudo lanzar"));
  });

  test("mientras guarda y mientras lanza, los botones lo dicen", async () => {
    answers((path, options) =>
      options?.method === "PUT" || path.endsWith("/runs") ? new Promise(() => {}) : undefined,
    );
    draw("/p/p1/collections/col1");
    await screen.findByText("01 · Productos");

    fireEvent.click(screen.getByRole("button", { name: "Nueva carpeta" }));
    fireEvent.click(screen.getByRole("button", { name: "Guardar" }));
    expect(await screen.findByRole("button", { name: "Guardando…" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Correr" }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Correr" }));
    expect(await screen.findByRole("button", { name: "Lanzando…" })).toBeTruthy();
  });

  test("sin entorno activo se envía y se corre sin entorno", async () => {
    answers((path, options) => (path.endsWith("/send") && options?.method === "POST" ? {
      request: { method: "POST", url: "https://api/x", headers: {}, body: null },
      response: null,
      error: "no se pudo llegar",
      auth: "—",
      environment: null,
      scripts: { pre: null, post: null },
      sessionToken: null,
      cookies: { sent: [], stored: [], rejected: [] },
      variables: {},
    } : undefined), []);
    draw("/p/p1/collections/col1");
    await screen.findByText("01 · Productos");
    fireEvent.click(screen.getByRole("button", { name: "Crear producto" }));
    fireEvent.click(screen.getByRole("button", { name: "Enviar" }));

    await waitFor(() => expect(screen.getByText("no se pudo llegar")).toBeTruthy());
    expect((calls().find(([path]) => path.endsWith("/send"))![1]!.body as { environmentId: null }).environmentId).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Correr" }));
    expect((screen.getByLabelText("Entorno") as HTMLSelectElement).value).toBe("");
  });

  test("duplicar en la raíz deja la copia en la raíz", async () => {
    answers((path) =>
      path === `${BASE}/collections/col1`
        ? view({ items: [...view().items, { ...view().items[0].items[1], id: "r9", name: "Suelta" }] })
        : undefined,
    );
    draw("/p/p1/collections/col1");
    await screen.findByText("01 · Productos");
    fireEvent.click(screen.getByRole("button", { name: "Duplicar Suelta" }));
    fireEvent.click(screen.getByRole("button", { name: "Guardar" }));
    await waitFor(() => expect(calls().some(([, options]) => options?.method === "PUT")).toBe(true));
    const body = calls().find(([, options]) => options?.method === "PUT")![1]!.body as {
      document: { items: { name: string }[] };
    };
    expect(body.document.items.map((item) => item.name)).toEqual(["01 · Productos", "Suelta", "Suelta (copia)"]);
  });

  test("borrar una carpeta lo dice, y si era la abierta se cierra el editor", async () => {
    answers();
    draw("/p/p1/collections/col1");
    await screen.findByText("01 · Productos");
    fireEvent.click(screen.getByRole("button", { name: "01 · Productos" }));
    fireEvent.click(screen.getByRole("button", { name: "Eliminar 01 · Productos" }));
    expect(screen.getByText(/todo lo que tiene dentro/)).toBeTruthy();
    fireEvent.click(screen.getAllByRole("button", { name: "Eliminar" }).at(-1)!);
    await waitFor(() => expect(screen.queryByText("Scripts de la carpeta")).toBeNull());
    expect(screen.getByText("Variables de la colección")).toBeTruthy();
  });

  test("el informe enseña una petición sin respuesta, sin tests y con su error", async () => {
    mocks.api.mockResolvedValue(
      runView({
        environmentName: null,
        results: [
          {
            ...result({
              folder: "",
              status: null,
              durationMs: 0,
              sizeBytes: 0,
              error: "Variables sin valor: baseUrl",
              auth: "No se envió",
            }),
          },
        ],
      }),
    );
    draw("/p/p1/collections/runs/run1");
    expect(await screen.findByText("sin tests")).toBeTruthy();
    expect(screen.getByText("—")).toBeTruthy();
    expect(screen.getByText(/sin entorno/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Crear producto/ }));
    expect(screen.getByText("Variables sin valor: baseUrl")).toBeTruthy();
  });

  test("un evento del stream sin totales conserva los que había", async () => {
    let push: StreamHandlers["onEvent"] = () => {};
    mocks.streamRun.mockImplementation((_path: string, handlers: StreamHandlers) => {
      push = handlers.onEvent;
      return new Promise(() => {});
    });
    mocks.api.mockResolvedValue(runView({ status: "running" }));
    draw("/p/p1/collections/runs/run1");
    await waitFor(() => expect(mocks.streamRun).toHaveBeenCalled());

    act(() => push({ type: "finished", data: { status: "passed" } }));
    await waitFor(() => expect(screen.getByText("Verde")).toBeTruthy());
    // Los totales de antes siguen ahí: el evento no los traía.
    expect(screen.getAllByText("2").length).toBeGreaterThan(0);
    expect(screen.getByText("Peticiones")).toBeTruthy();
  });
});

describe("lo que se escribe en el árbol llega al documento", () => {
  const answers = () =>
    mocks.api.mockImplementation((path: string) => {
      if (path === `${BASE}/collections/col1`) return Promise.resolve(view());
      if (path === `${BASE}/environments`) return Promise.resolve(environments);
      return Promise.resolve({});
    });

  const savedBody = () =>
    calls().find(([, options]) => options?.method === "PUT")![1]!.body as {
      document: { items: { name: string; items: { name: string; request: { url: string } }[] }[]; variables: unknown[] };
    };

  test("editar una petición, una carpeta y las variables, y guardarlo todo junto", async () => {
    answers();
    draw("/p/p1/collections/col1");
    await screen.findByText("01 · Productos");

    fireEvent.click(screen.getByRole("button", { name: "Crear producto" }));
    fireEvent.change(screen.getByLabelText("URL"), { target: { value: "{{baseUrl}}/v1/productos" } });

    fireEvent.click(screen.getByRole("button", { name: "01 · Productos" }));
    fireEvent.change(screen.getByDisplayValue("01 · Productos"), { target: { value: "01 · Productos (ES)" } });

    fireEvent.click(screen.getByRole("button", { name: "La colección" }));
    const variables = screen.getAllByPlaceholderText("baseUrl");
    fireEvent.change(variables[variables.length - 1], { target: { value: "token" } });

    fireEvent.click(screen.getByRole("button", { name: "Guardar" }));
    await waitFor(() => expect(calls().some(([, options]) => options?.method === "PUT")).toBe(true));
    const document = savedBody().document;
    expect(document.items[0].name).toBe("01 · Productos (ES)");
    expect(document.items[0].items[0].request.url).toBe("{{baseUrl}}/v1/productos");
    expect(document.variables).toHaveLength(2);
  });

  test("los dos diálogos se pueden cerrar sin hacer nada", async () => {
    answers();
    draw("/p/p1/collections/col1");
    await screen.findByText("01 · Productos");

    fireEvent.click(screen.getByRole("button", { name: "Eliminar Crear producto" }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Cancelar" }));
    expect(screen.getByRole("button", { name: "Crear producto" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Eliminar la colección" }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Cancelar" }));
    expect(screen.getByRole("button", { name: "Eliminar la colección" })).toBeTruthy();
  });

  test("con los entornos aún cargando, el diálogo de correr solo ofrece «sin entorno»", async () => {
    mocks.api.mockImplementation((path: string) => {
      if (path === `${BASE}/collections/col1`) return Promise.resolve(view());
      if (path === `${BASE}/environments`) return new Promise(() => {});
      return Promise.resolve({});
    });
    draw("/p/p1/collections/col1");
    await screen.findByText("01 · Productos");
    fireEvent.click(screen.getByRole("button", { name: "Correr" }));
    expect(within(screen.getByLabelText("Entorno")).getAllByRole("option")).toHaveLength(1);
  });

  test("en el informe, una petición verde enseña su test con el tic", async () => {
    mocks.api.mockResolvedValue(runView());
    draw("/p/p1/collections/runs/run1");
    await screen.findByText("Crear producto");
    fireEvent.click(screen.getByRole("button", { name: /Crear producto/ }));
    fireEvent.click(screen.getByRole("button", { name: "Tests (1)" }));
    expect(screen.getByText(/✓ crea/)).toBeTruthy();
  });
});
