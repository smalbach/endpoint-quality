/**
 * La papelera de la pantalla de flujos: el flujo, su tabla de datos y la suite que los ordena.
 *
 * Las tres juntas a propósito: «lo borré y no sé qué era» tiene un solo sitio donde mirar. Y en la
 * papelera un flujo no se abre en el lienzo —editar algo que no está en ninguna lista es trabajo
 * que se pierde al siguiente borrado definitivo.
 */
import { describe, expect, test, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes, useParams } from "react-router-dom";

import { WorkflowListPage } from "@/routes/workflow-list";
import type { DatasetView, Environment, SuiteView, WorkflowView, WorkflowsView } from "@/lib/types";

const mocks = vi.hoisted(() => ({ call: vi.fn(), openImport: vi.fn(), download: vi.fn() }));
vi.mock("@/lib/api", async (original) => ({ ...(await original<object>()), api: mocks.call }));
vi.mock("@/lib/auth", () => ({ useOrganization: () => ({ id: "o", name: "Org" }), useCan: () => true }));
vi.mock("@/components/import-provider", () => ({ useImport: () => ({ open: mocks.openImport }) }));
vi.mock("@/lib/project-bundle", async (original) => ({
  ...(await original<object>()),
  downloadJson: mocks.download,
}));

const BASE = "/orgs/o/projects/p1";

const flow = (id: string, name: string, patch: Partial<WorkflowView> = {}): WorkflowView =>
  ({
    id,
    name,
    description: null,
    status: "ready",
    steps: [],
    updatedAt: "2026-09-01T00:00:00.000Z",
    deletedAt: null,
    ...patch,
  }) as WorkflowView;

const dataset = (id: string, name: string): DatasetView =>
  ({
    id,
    workflowId: "w1",
    name,
    columns: ["email"],
    rowCount: 3,
    updatedAt: "2026-09-01T00:00:00.000Z",
    archivedAt: null,
    deletedAt: "2026-09-02T00:00:00.000Z",
  }) as DatasetView;

const suite = (id: string, name: string): SuiteView =>
  ({
    id,
    name,
    description: null,
    workflowIds: ["w1", "w2"],
    updatedAt: "2026-09-01T00:00:00.000Z",
    archivedAt: null,
    deletedAt: "2026-09-02T00:00:00.000Z",
  }) as SuiteView;

function serve(fail: Record<string, Error> = {}) {
  mocks.call.mockReset();
  mocks.call.mockImplementation((path: string, options?: { method?: string; body?: unknown }) => {
    const method = options?.method ?? "GET";
    const key = `${method} ${path.slice(BASE.length)}`;
    if (fail[key]) return Promise.reject(fail[key]);
    if (key === "GET /workflows?state=deleted")
      return Promise.resolve({
        workflows: [flow("w1", "Pedidos", { deletedAt: "2026-09-02T00:00:00.000Z" })],
        suites: [suite("su1", "Antes de publicar")],
        requestTemplates: [],
        datasets: [dataset("d1", "clientes")],
      } as unknown as WorkflowsView);
    if (key === "GET /workflows")
      return Promise.resolve({
        workflows: [flow("w1", "Pedidos")],
        suites: [],
        requestTemplates: [],
        datasets: [],
      } as unknown as WorkflowsView);
    if (key === "GET /environments")
      return Promise.resolve([{ id: "e1", name: "local", active: true }] as Environment[]);
    return Promise.resolve(undefined);
  });
}

function draw() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const Opened = () => <p>lienzo de {useParams().workflowId}</p>;
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={["/p/p1/workflows"]}>
        <Routes>
          <Route path="/p/:projectId/workflows" element={<WorkflowListPage projectId="p1" />} />
          <Route path="/p/:projectId/workflows/:workflowId" element={<Opened />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const trash = () => fireEvent.click(screen.getByRole("button", { name: /Eliminados/ }));

describe("la papelera de los flujos", () => {
  test("pide la lista borrada, y la fila no ofrece lienzo, renombrar ni estado", async () => {
    serve();
    draw();
    expect(await screen.findByText("Pedidos")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Abrir lienzo" })).toBeTruthy();

    trash();
    await waitFor(() => expect(mocks.call).toHaveBeenCalledWith(`${BASE}/workflows?state=deleted`));
    expect((await screen.findAllByRole("button", { name: "Restaurar" })).length).toBeGreaterThan(0);
    expect(screen.queryByRole("link", { name: "Abrir lienzo" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Renombrar" })).toBeNull();
  });

  test("el flujo vuelve, y el definitivo pide su nombre escrito", async () => {
    serve();
    draw();
    await screen.findByText("Pedidos");
    trash();

    fireEvent.click((await screen.findAllByRole("button", { name: "Restaurar" }))[0]);
    await waitFor(() => expect(mocks.call).toHaveBeenCalledWith(`${BASE}/workflows/w1/restore`, { method: "POST" }));

    fireEvent.click((await screen.findAllByRole("button", { name: "Eliminar para siempre" }))[0]);
    const dialog = within(await screen.findByRole("dialog"));
    expect(dialog.getByText(/con su grafo y sus conjuntos de datos/)).toBeTruthy();
    fireEvent.change(dialog.getByRole("textbox"), { target: { value: "Pedidos" } });
    fireEvent.click(dialog.getByRole("button", { name: "Eliminar para siempre" }));
    await waitFor(() =>
      expect(mocks.call).toHaveBeenCalledWith(`${BASE}/workflows/w1?purge=true`, { method: "DELETE" }),
    );
  });

  test("los conjuntos y las suites borrados salen con lo que eran, y con sus dos salidas", async () => {
    serve();
    draw();
    await screen.findByText("Pedidos");
    trash();

    expect(await screen.findByText("Conjuntos de datos eliminados")).toBeTruthy();
    expect(screen.getByText("3 filas · email")).toBeTruthy();
    expect(screen.getByText("Suites eliminadas")).toBeTruthy();
    expect(screen.getByText("2 flujos, en su orden")).toBeTruthy();

    // El primer «Restaurar» es del flujo; los de las dos secciones van detrás, en su orden.
    const restore = screen.getAllByRole("button", { name: "Restaurar" });
    fireEvent.click(restore[1]);
    await waitFor(() => expect(mocks.call).toHaveBeenCalledWith(`${BASE}/datasets/d1/restore`, { method: "POST" }));
    fireEvent.click(restore[2]);
    await waitFor(() => expect(mocks.call).toHaveBeenCalledWith(`${BASE}/suites/su1/restore`, { method: "POST" }));

    const purge = screen.getAllByRole("button", { name: "Eliminar para siempre" });
    fireEvent.click(purge[1]);
    await waitFor(() =>
      expect(mocks.call).toHaveBeenCalledWith(`${BASE}/datasets/d1?purge=true`, { method: "DELETE" }),
    );
    fireEvent.click(purge[2]);
    await waitFor(() => expect(mocks.call).toHaveBeenCalledWith(`${BASE}/suites/su1?purge=true`, { method: "DELETE" }));
  });

  test("una papelera vacía lo dice, y las dos secciones también", async () => {
    mocks.call.mockReset();
    mocks.call.mockImplementation((path: string, options?: { method?: string }) => {
      if ((options?.method ?? "GET") !== "GET") return Promise.resolve(undefined);
      if (path.includes("state=deleted"))
        return Promise.resolve({ workflows: [], suites: [], requestTemplates: [], datasets: [] });
      if (path.endsWith("/workflows"))
        return Promise.resolve({ workflows: [flow("w1", "Pedidos")], suites: [], requestTemplates: [], datasets: [] });
      return Promise.resolve([]);
    });
    draw();
    await screen.findByText("Pedidos");
    trash();
    expect(await screen.findByText(/Papelera vacía/)).toBeTruthy();
    expect(screen.getAllByText("Ninguno.")).toHaveLength(1);
    expect(screen.getByText("Ninguna.")).toBeTruthy();
  });

  test("una suite se archiva desde su panel: fuera de la lista, sin tocar los flujos", async () => {
    serve();
    mocks.call.mockImplementation((path: string, options?: { method?: string; body?: unknown }) => {
      const method = options?.method ?? "GET";
      if (method !== "GET") return Promise.resolve(undefined);
      if (path.endsWith("/environments")) return Promise.resolve([{ id: "e1", name: "local", active: true }]);
      if (path.includes("state=deleted"))
        return Promise.resolve({ workflows: [], suites: [], requestTemplates: [], datasets: [] });
      return Promise.resolve({
        workflows: [flow("w1", "Pedidos"), flow("w2", "Login")],
        suites: [{ ...suite("su1", "Antes de publicar"), deletedAt: null }],
        requestTemplates: [],
        datasets: [],
      });
    });
    draw();
    fireEvent.click(await screen.findByRole("button", { name: /Antes de publicar/ }));
    fireEvent.click(screen.getByRole("button", { name: "Eliminar" }));
    fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Archivar" }));
    await waitFor(() =>
      expect(mocks.call).toHaveBeenCalledWith(`${BASE}/suites/su1/archived`, {
        method: "PATCH",
        body: { archived: true },
      }),
    );
  });

  test("un conjunto sin columnas lo dice en la papelera", async () => {
    mocks.call.mockReset();
    mocks.call.mockImplementation((path: string, options?: { method?: string }) => {
      if ((options?.method ?? "GET") !== "GET") return Promise.resolve(undefined);
      if (path.endsWith("/environments")) return Promise.resolve([]);
      if (path.includes("state=deleted"))
        return Promise.resolve({
          workflows: [],
          suites: [],
          requestTemplates: [],
          datasets: [{ ...dataset("d2", "vacío"), columns: [], rowCount: 0 }],
        });
      return Promise.resolve({
        workflows: [flow("w1", "Pedidos")],
        suites: [],
        requestTemplates: [],
        datasets: [],
      });
    });
    draw();
    await screen.findByText("Pedidos");
    trash();
    expect(await screen.findByText("0 filas · sin columnas")).toBeTruthy();
  });

  test("cancelar el definitivo no manda nada", async () => {
    serve();
    draw();
    await screen.findByText("Pedidos");
    trash();
    fireEvent.click((await screen.findAllByRole("button", { name: "Eliminar para siempre" }))[0]);
    fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Cancelar" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(
      mocks.call.mock.calls.some(([, options]) => (options as { method?: string } | undefined)?.method === "DELETE"),
    ).toBe(false);
  });
});
