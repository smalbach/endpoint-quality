/**
 * El escáner de código.
 *
 * - El conector guardado rellena el formulario, y el token solo viaja si alguien lo escribió: guardar
 *   sin tocarlo conserva el que hay.
 * - Escanear (desde GitHub o subiendo ficheros) elige el escaneo nuevo y enseña su diff y su impacto.
 * - Importar manda si crear los roles que faltan y dice cuánto creó.
 */
import { afterEach, describe, expect, test, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";

import { CodeScanPage } from "@/routes/code-scan";
import type { CodeConnectorView, CodeScanDetailView, CodeScanSummaryView } from "@/lib/types";

type Options = { method?: string; body?: unknown };

const mocks = vi.hoisted(() => ({ api: vi.fn(), canEdit: { value: true } }));
vi.mock("@/lib/api", async (original) => ({
  ...(await original<object>()),
  api: mocks.api,
}));
vi.mock("@/lib/auth", () => ({
  useOrganization: () => ({ id: "o", name: "Org" }),
  useCan: () => mocks.canEdit.value,
}));

afterEach(() => {
  mocks.api.mockReset();
  mocks.canEdit.value = true;
});

const BASE = "/orgs/o/projects/p1";
const calls = () => mocks.api.mock.calls as [string, Options?][];

const connector = (patch: Partial<CodeConnectorView> = {}): CodeConnectorView => ({
  repo: "acme/api",
  branch: "develop",
  basePath: "apps/api/src",
  prefix: "api",
  tokenSet: true,
  updatedAt: "2026-03-01T10:00:00.000Z",
  ...patch,
});

const scanRow = (patch: Partial<CodeScanSummaryView> = {}): CodeScanSummaryView => ({
  id: "s1",
  source: "github",
  ref: "develop@abc123",
  status: "ok",
  controllers: 3,
  files: 4,
  counts: { added: 2, removed: 1, changed: 1, unchanged: 7 },
  error: null,
  createdAt: "2026-03-01T10:00:00.000Z",
  ...patch,
});

const scanDetail = (patch: Partial<CodeScanDetailView> = {}): CodeScanDetailView => ({
  id: "s1",
  source: "github",
  ref: "develop@abc123",
  status: "ok",
  result: {
    endpoints: [
      {
        method: "GET",
        path: "/api/orders",
        controller: "OrdersController",
        handler: "list",
        guards: ["JwtGuard"],
        roles: ["admin"],
        requiresAuth: true,
        file: "orders.controller.ts",
      },
    ],
    files: 4,
    controllers: 3,
  },
  diff: {
    added: [
      {
        method: "GET",
        path: "/api/orders",
        controller: "OrdersController",
        handler: "list",
        guards: ["JwtGuard"],
        roles: ["admin", "auditor"],
        requiresAuth: true,
        file: "orders.controller.ts",
      },
      {
        method: "GET",
        path: "/api/health",
        controller: "HealthController",
        handler: "ping",
        guards: [],
        roles: [],
        requiresAuth: false,
        file: "health.controller.ts",
      },
    ],
    changed: [{ method: "PUT", path: "/api/orders/:id", id: "e2", changes: ["roles: admin → admin, owner", "auth"] }],
    removed: [{ id: "e3", method: "DELETE", path: "/api/legacy", requiresAuth: true }],
    unchanged: 7,
  },
  impact: {
    unknownRoles: ["auditor"],
    removedWithPermissions: [{ method: "DELETE", path: "/api/legacy", permissions: 2 }],
    removedWithFlows: [{ method: "DELETE", path: "/api/legacy", flows: 1 }],
  },
  error: null,
  createdAt: "2026-03-01T10:00:00.000Z",
  ...patch,
});

function answers({
  conn = connector(),
  scans = [] as CodeScanSummaryView[] | (() => CodeScanSummaryView[]),
  detail = (id: string): CodeScanDetailView | Promise<never> => scanDetail({ id }),
  extra = (() => undefined) as (path: string, options?: Options) => Promise<unknown> | undefined,
} = {}) {
  mocks.api.mockImplementation((path: string, options?: Options) => {
    const handled = extra(path, options);
    if (handled) return handled;
    if (options?.method) return Promise.resolve(undefined);
    if (path.endsWith("/code-scan/connector")) return Promise.resolve(conn);
    if (path.endsWith("/code-scan/scans")) return Promise.resolve(typeof scans === "function" ? scans() : scans);
    const match = /\/code-scan\/scans\/([^/]+)$/.exec(path);
    if (match) return Promise.resolve(detail(match[1]));
    return Promise.resolve(undefined);
  });
}

function draw() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={["/p/p1/code-scan"]}>
        <Routes>
          <Route path="/p/:projectId/code-scan" element={<CodeScanPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

/** jsdom's File has no `text()`; the browser's does, and the page reads the upload with it. */
function source(content: string, name: string): File {
  const file = new File([content], name);
  Object.defineProperty(file, "text", { value: () => Promise.resolve(content) });
  return file;
}

const input = (label: string) => screen.getByLabelText(label) as HTMLInputElement;

describe("el escáner de código", () => {
  test("mientras carga lo dice; sin conector el formulario sale vacío y no se puede escanear", async () => {
    answers({ conn: null as unknown as CodeConnectorView });
    draw();
    expect(screen.getByText("Cargando…")).toBeTruthy();
    await screen.findByText("Escáner de código");
    expect(input("owner/repo").value).toBe("");
    expect(input("Rama").value).toBe("main");
    expect(input("Token").placeholder).toBe("ghp_… (opcional para repos públicos)");
    expect((screen.getByRole("button", { name: "Escanear" }) as HTMLButtonElement).disabled).toBe(true);
    await screen.findByText("Ningún escaneo todavía.");
    expect(screen.getByText("Escanea el código")).toBeTruthy();
  });

  test("el conector guardado rellena el formulario sin enseñar el token", async () => {
    answers();
    draw();
    await waitFor(() => expect(input("owner/repo").value).toBe("acme/api"));
    expect(input("Rama").value).toBe("develop");
    expect(input("Base path").value).toBe("apps/api/src");
    expect(input("Prefijo global").value).toBe("api");
    expect(input("Token").value).toBe("");
    expect(input("Token").placeholder).toBe("•••••••• (guardado)");
    expect(mocks.api).toHaveBeenCalledWith(`${BASE}/code-scan/connector`);
    expect(mocks.api).toHaveBeenCalledWith(`${BASE}/code-scan/scans`);
  });

  test("un conector sin rama se rellena con main", async () => {
    answers({ conn: connector({ branch: "" }) });
    draw();
    await waitFor(() => expect(input("owner/repo").value).toBe("acme/api"));
    expect(input("Rama").value).toBe("main");
  });

  test("guardar sin tocar el token no lo manda, y así conserva el guardado", async () => {
    answers();
    draw();
    await waitFor(() => expect(input("owner/repo").value).toBe("acme/api"));
    fireEvent.change(input("owner/repo"), { target: { value: "acme/core" } });
    fireEvent.change(input("Rama"), { target: { value: "main" } });
    fireEvent.change(input("Prefijo global"), { target: { value: "v1" } });
    fireEvent.change(input("Base path"), { target: { value: "src" } });
    fireEvent.click(screen.getByRole("button", { name: "Guardar conector" }));
    await waitFor(() => expect(calls().some(([, o]) => o?.method === "PUT")).toBe(true));
    const put = calls().find(([, o]) => o?.method === "PUT")!;
    expect(put[0]).toBe(`${BASE}/code-scan/connector`);
    expect(put[1]!.body).toEqual({ repo: "acme/core", branch: "main", basePath: "src", prefix: "v1" });
  });

  test("escribir el token lo manda, aunque sea vacío (para borrarlo)", async () => {
    answers();
    draw();
    await waitFor(() => expect(input("owner/repo").value).toBe("acme/api"));
    fireEvent.change(input("Token"), { target: { value: "ghp_x" } });
    fireEvent.change(input("Token"), { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "Guardar conector" }));
    await waitFor(() => expect(calls().some(([, o]) => o?.method === "PUT")).toBe(true));
    expect(calls().find(([, o]) => o?.method === "PUT")![1]!.body).toMatchObject({ token: "" });
  });

  test("si guardar falla, el error se enseña", async () => {
    answers({
      extra: (_path, options) =>
        options?.method === "PUT" ? Promise.reject(new Error("Repo no encontrado")) : undefined,
    });
    draw();
    await waitFor(() => expect(input("owner/repo").value).toBe("acme/api"));
    fireEvent.click(screen.getByRole("button", { name: "Guardar conector" }));
    await screen.findByText("Repo no encontrado");
  });

  test("escanear desde GitHub elige el escaneo nuevo y enseña su diff y su impacto", async () => {
    let list: CodeScanSummaryView[] = [];
    answers({
      scans: () => list,
      extra: (path, options) => {
        if (options?.method !== "POST" || !path.endsWith("/code-scan/scans")) return undefined;
        list = [scanRow()];
        return Promise.resolve({ scanId: "s1" });
      },
    });
    draw();
    await waitFor(() => expect(input("owner/repo").value).toBe("acme/api"));
    fireEvent.click(screen.getByRole("button", { name: "Escanear" }));
    await screen.findByText("3 controladores · 4 ficheros · 1 rutas", {}, { timeout: 3000 });
    expect(mocks.api).toHaveBeenCalledWith(`${BASE}/code-scan/scans`, { method: "POST", body: {} });
    expect(mocks.api).toHaveBeenCalledWith(`${BASE}/code-scan/scans/s1`);

    // El historial lo muestra elegido.
    expect(screen.getByText("develop@abc123 · +2 ~1 −1")).toBeTruthy();

    // Impacto.
    expect(screen.getByText("Impacto")).toBeTruthy();
    expect(screen.getByText(/Roles que el código nombra y el proyecto no define/)).toBeTruthy();
    expect(screen.getByText(/2 permiso\(s\) de rol lo referencian/)).toBeTruthy();
    expect(screen.getByText(/1 flujo\(s\) lo usan/)).toBeTruthy();

    // Diff.
    expect(screen.getByText("Nuevos (2)")).toBeTruthy();
    expect(screen.getByText("auth · rol:admin · rol:auditor")).toBeTruthy();
    expect(screen.getByText("público")).toBeTruthy();
    expect(screen.getByText("Cambiados (1)")).toBeTruthy();
    expect(screen.getByText("roles: admin → admin, owner; auth")).toBeTruthy();
    expect(screen.getByText("Ya no en el código (1)")).toBeTruthy();
    expect(screen.getByText("7 sin cambios.")).toBeTruthy();
  });

  test("si escanear falla, el error se enseña", async () => {
    answers({
      extra: (_path, options) =>
        options?.method === "POST" ? Promise.reject(new Error("Token sin permisos")) : undefined,
    });
    draw();
    await waitFor(() => expect(input("owner/repo").value).toBe("acme/api"));
    fireEvent.click(screen.getByRole("button", { name: "Escanear" }));
    await screen.findByText("Token sin permisos");
  });

  test("subir ficheros los manda con el prefijo y elige el escaneo", async () => {
    let list: CodeScanSummaryView[] = [];
    answers({
      scans: () => list,
      detail: (id) => scanDetail({ id, source: "upload", ref: "" }),
      extra: (path, options) => {
        if (options?.method !== "POST" || !path.endsWith("/scans/upload")) return undefined;
        list = [scanRow({ id: "s2", source: "upload", ref: "" })];
        return Promise.resolve({ scanId: "s2" });
      },
    });
    draw();
    await waitFor(() => expect(input("Prefijo global").value).toBe("api"));
    const file = source("@Controller('orders') export class OrdersController {}", "orders.controller.ts");
    fireEvent.change(screen.getByLabelText("Subir ficheros"), { target: { files: [file] } });
    // Leer el fichero es asíncrono (`file.text()`): bajo carga la subida sale tarde, así que se
    // espera a la petición antes de mirar lo que pinta.
    await waitFor(
      () =>
        expect(mocks.api).toHaveBeenCalledWith(`${BASE}/code-scan/scans/upload`, {
          method: "POST",
          body: {
            files: [
              { path: "orders.controller.ts", content: "@Controller('orders') export class OrdersController {}" },
            ],
            prefix: "api",
          },
        }),
      { timeout: 5000 },
    );
    await screen.findByText("3 controladores · 4 ficheros · 1 rutas", {}, { timeout: 5000 });
    // Subida: ni ref de GitHub en el historial ni en la cabecera.
    expect(screen.getAllByText("subida").length).toBeGreaterThan(0);
  });

  test("elegir sin ficheros no sube nada; si la subida falla, se dice", async () => {
    answers({
      extra: (path, options) =>
        options?.method === "POST" && path.endsWith("/upload")
          ? Promise.reject(new Error("Fichero enorme"))
          : undefined,
    });
    draw();
    await screen.findByText("Escáner de código");
    const upload = screen.getByLabelText("Subir ficheros");
    fireEvent.change(upload, { target: { files: [] } });
    expect(calls().some(([, o]) => o?.method === "POST")).toBe(false);
    fireEvent.change(upload, { target: { files: [source("x", "a.controller.ts")] } });
    await screen.findByText("Fichero enorme");
  });

  test("elegir un escaneo del historial lo abre; uno fallido dice por qué", async () => {
    answers({
      scans: [scanRow(), scanRow({ id: "s9", status: "error", error: "boom", ref: "main@f00" })],
      detail: (id) =>
        id === "s9" ? scanDetail({ id, status: "error", error: "No se pudo leer el repo" }) : scanDetail({ id }),
    });
    draw();
    fireEvent.click(await screen.findByText(/main@f00/));
    await screen.findByText("El escaneo falló: No se pudo leer el repo");
    fireEvent.click(screen.getByText(/develop@abc123/));
    await screen.findByText("3 controladores · 4 ficheros · 1 rutas", {}, { timeout: 3000 });
  });

  test("importar manda si crear los roles y dice cuánto creó", async () => {
    answers({
      scans: [scanRow()],
      extra: (path, options) =>
        options?.method === "POST" && path.endsWith("/import")
          ? Promise.resolve({ created: 2, updated: 1, rolesCreated: 1 })
          : undefined,
    });
    draw();
    fireEvent.click(await screen.findByText(/develop@abc123/));
    const roles = (await screen.findByLabelText(/Crear también los roles que faltan \(1\)/)) as HTMLInputElement;
    expect(roles.disabled).toBe(false);
    fireEvent.click(roles);
    fireEvent.click(screen.getByRole("button", { name: "Importar al proyecto" }));
    await screen.findByText(/Importado: 2 creados, 1 actualizados,/);
    expect(mocks.api).toHaveBeenCalledWith(`${BASE}/code-scan/scans/s1/import`, {
      method: "POST",
      body: { createRoles: true },
    });
  });

  test("si importar falla, el error se enseña", async () => {
    answers({
      scans: [scanRow()],
      extra: (path, options) =>
        options?.method === "POST" && path.endsWith("/import") ? Promise.reject(new Error("Conflicto")) : undefined,
    });
    draw();
    fireEvent.click(await screen.findByText(/develop@abc123/));
    fireEvent.click(await screen.findByRole("button", { name: "Importar al proyecto" }));
    await screen.findByText("Conflicto");
    expect(calls().find(([path]) => path.endsWith("/import"))![1]!.body).toEqual({ createRoles: false });
  });

  test("sin cambios no hay nada que importar, ni roles que crear", async () => {
    answers({
      scans: [scanRow()],
      detail: (id) =>
        scanDetail({
          id,
          diff: { added: [], changed: [], removed: [], unchanged: 9 },
          impact: { unknownRoles: [], removedWithPermissions: [], removedWithFlows: [] },
        }),
    });
    draw();
    fireEvent.click(await screen.findByText(/develop@abc123/));
    await screen.findByText("9 sin cambios.");
    expect(screen.queryByText("Impacto")).toBeNull();
    expect(screen.queryByText(/Nuevos/)).toBeNull();
    expect((screen.getByRole("button", { name: "Importar al proyecto" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByLabelText(/Crear también los roles/) as HTMLInputElement).disabled).toBe(true);
  });

  test("un lector ve el conector y los escaneos, pero no puede editar, subir ni importar", async () => {
    mocks.canEdit.value = false;
    answers({ scans: [scanRow()] });
    draw();
    await waitFor(() => expect(input("owner/repo").value).toBe("acme/api"));
    expect(input("owner/repo").disabled).toBe(true);
    expect(input("Token").disabled).toBe(true);
    expect(screen.queryByRole("button", { name: "Guardar conector" })).toBeNull();
    expect(screen.queryByLabelText("Subir ficheros")).toBeNull();
    fireEvent.click(await screen.findByText(/develop@abc123/));
    await screen.findByText("3 controladores · 4 ficheros · 1 rutas", {}, { timeout: 3000 });
    expect(screen.queryByRole("button", { name: "Importar al proyecto" })).toBeNull();
  });
});
