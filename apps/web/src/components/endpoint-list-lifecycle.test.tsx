/**
 * La papelera de la lista de endpoints: el filtro, restaurar —de uno y en lote— y el definitivo.
 *
 * Para un endpoint, archivar **es** su `status` y vive en el icono de al lado: aquí se prueba la
 * otra mitad, la que faltaba, y que en la papelera no se ofrece lo que no tiene sentido ahí.
 */
import { describe, expect, test, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { EndpointList } from "@/components/endpoint-list";
import { ToastProvider } from "@/components/toast";
import { ImportProvider } from "@/components/import-provider";
import type { EndpointPage, EndpointView } from "@/lib/types";

const call = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", async (original) => ({ ...(await original<object>()), api: call }));
const openImport = vi.hoisted(() => vi.fn());
vi.mock("@/components/import-provider", () => ({
  ImportProvider: ({ children }: { children: React.ReactNode }) => children,
  useImport: () => ({ open: openImport }),
}));

const BASE = "/orgs/o/projects/p";

const endpoint = (id: string, method: EndpointView["method"], path: string): EndpointView =>
  ({
    id,
    method,
    path,
    description: "",
    pathParameters: [],
    query: [],
    headers: [],
    body: { mode: "none", text: "", contentType: "text/plain", fields: [] },
    requiresAuth: false,
    auth: { type: "inherit", params: {} },
    tags: [],
    status: "active",
    origin: "manual",
    operationId: null,
    orderIndex: 0,
    preRequestScript: "",
    postResponseScript: "",
    createdAt: "",
    updatedAt: "",
    updatedBy: "",
    inContract: null,
  }) as EndpointView;

const page: EndpointPage = {
  data: [endpoint("a", "GET", "/users/{id}"), endpoint("b", "DELETE", "/users/{id}")],
  meta: { page: 1, limit: 100, total: 2, totalPages: 1 },
  counts: { active: 0, archived: 0, inactive: 0 },
  deleted: 2,
  hasContract: false,
};

function mount(answer: (path: string) => unknown = () => ({ restored: 1 })) {
  call.mockReset();
  call.mockImplementation((path: string) => Promise.resolve().then(() => answer(path)));
  const handlers = {
    onSelect: vi.fn(),
    onSearch: vi.fn(),
    onChanged: vi.fn(async () => undefined),
    onStatus: vi.fn(),
    onPage: vi.fn(),
    onNew: vi.fn(),
    onRemoved: vi.fn(),
  };
  const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <ToastProvider>
        <ImportProvider projectId="p">
          <EndpointList
            base={BASE}
            page={page}
            loading={false}
            status="deleted"
            search=""
            pageNumber={1}
            selectedId={null}
            canEdit
            {...handlers}
          />
        </ImportProvider>
      </ToastProvider>
    </QueryClientProvider>,
  );
  return handlers;
}

const openFolder = () => fireEvent.click(screen.getByText("users"));
const check = (label: string) => fireEvent.click(screen.getByLabelText(label));

describe("la papelera de los endpoints", () => {
  test("el filtro lleva su cuenta y se pide al pulsarlo", () => {
    const { onStatus } = mount();
    expect(screen.getByText("Eliminados").textContent).toContain("2");
    fireEvent.click(screen.getByText("Activos"));
    expect(onStatus).toHaveBeenCalledWith("active");
  });

  test("la fila ofrece restaurar y borrar del todo, y no archivar", async () => {
    const { onChanged } = mount();
    openFolder();
    expect(screen.queryByTitle("Archivar")).toBeNull();

    fireEvent.click(screen.getAllByTitle("Restaurar")[0]);
    await waitFor(() => expect(call).toHaveBeenCalledWith(`${BASE}/endpoints/a/restore`, { method: "POST" }));
    expect(await screen.findByText("1 endpoint restaurado")).toBeTruthy();
    expect(onChanged).toHaveBeenCalled();
  });

  test("el definitivo avisa de los ejemplos y manda `purge`", async () => {
    const { onRemoved } = mount(() => undefined);
    openFolder();
    fireEvent.click(screen.getAllByTitle("Eliminar para siempre")[0]);
    const dialog = within(await screen.findByRole("dialog"));
    expect(dialog.getByText(/se va con sus ejemplos guardados/)).toBeTruthy();
    fireEvent.click(dialog.getByRole("button", { name: "Eliminar para siempre" }));
    await waitFor(() => expect(call).toHaveBeenCalledWith(`${BASE}/endpoints/a?purge=true`, { method: "DELETE" }));
    await waitFor(() => expect(onRemoved).toHaveBeenCalledWith(["a"]));
  });

  test("en lote solo se restaura: archivar, desactivar y eliminar no salen en la papelera", async () => {
    mount(() => ({ restored: 2 }));
    openFolder();
    check("Seleccionar GET /users/{id}");
    check("Seleccionar DELETE /users/{id}");
    expect(screen.getByText("2 seleccionados")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Archivar" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Desactivar" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Activar" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Eliminar" })).toBeNull();

    // El primero es el de la barra del lote; los de cada fila van detrás.
    fireEvent.click(screen.getAllByRole("button", { name: "Restaurar" })[0]);
    await waitFor(() =>
      expect(call).toHaveBeenCalledWith(`${BASE}/endpoints/bulk-restore`, {
        method: "POST",
        body: { ids: ["a", "b"] },
      }),
    );
    expect(await screen.findByText("2 endpoints restaurados")).toBeTruthy();
  });

  test("un fallo al restaurar se dice", async () => {
    mount(() => {
      throw new Error("Ya hay un endpoint GET /users/{id} en el proyecto");
    });
    openFolder();
    fireEvent.click(screen.getAllByTitle("Restaurar")[0]);
    expect(await screen.findByText("Ya hay un endpoint GET /users/{id} en el proyecto")).toBeTruthy();
  });
});
