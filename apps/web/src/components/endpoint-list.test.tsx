import { describe, expect, test, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { EndpointList } from "@/components/endpoint-list";
import { ToastProvider } from "@/components/toast";
import { ImportProvider } from "@/components/import-provider";
import type { EndpointPage, EndpointView } from "@/lib/types";

const call = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", async (original) => ({ ...(await original<object>()), api: call }));
// «Importar» abre la puerta única de la cabecera: aquí basta con saber que se la llamó.
const openImport = vi.hoisted(() => vi.fn());
vi.mock("@/components/import-provider", () => ({
  ImportProvider: ({ children }: { children: React.ReactNode }) => children,
  useImport: () => ({ open: openImport }),
}));

const endpoint = (
  id: string,
  method: EndpointView["method"],
  path: string,
  patch: Partial<EndpointView> = {},
): EndpointView => ({
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
  ...patch,
});

const PAGE: EndpointPage = {
  data: [
    endpoint("a", "GET", "/users/{id}", { requiresAuth: true }),
    endpoint("b", "POST", "/v1/users", { inContract: false }),
    endpoint("c", "GET", "/health"),
  ],
  meta: { page: 1, limit: 100, total: 3, totalPages: 1 },
  counts: { active: 3, archived: 1, inactive: 0 },
  deleted: 0,
  hasContract: true,
};

function mount(props: Partial<Parameters<typeof EndpointList>[0]> = {}) {
  call.mockReset();
  call.mockResolvedValue({ updated: 2 });
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
        {/* «Importar» de esta lista es el de la cabecera, y `useImport` revienta fuera de él. */}
        <ImportProvider projectId="p">
          <EndpointList
            base="/orgs/o/projects/p"
            page={PAGE}
            loading={false}
            status="active"
            search=""
            pageNumber={1}
            selectedId={null}
            canEdit
            {...handlers}
            {...props}
          />
        </ImportProvider>
      </ToastProvider>
    </QueryClientProvider>,
  );
  return handlers;
}

describe("la lista de endpoints", () => {
  test("carpetas cerradas con su cuenta; al abrir, la versión va dentro del módulo", () => {
    mount();
    expect(screen.queryByText("/users/{id}")).toBeNull();
    fireEvent.click(screen.getByText("users"));
    expect(screen.getByText("/users/{id}")).toBeDefined();
    expect(screen.getByText("v1")).toBeDefined();
    // The contract no longer declares it, and the row says so.
    fireEvent.click(screen.getByText("v1"));
    expect(screen.getByText("fuera")).toBeDefined();
    expect(screen.getByText("Todos").textContent).toContain("4");
  });

  test("el checkbox de una carpeta selecciona todo lo de dentro y la barra archiva esos", async () => {
    const handlers = mount();
    fireEvent.click(screen.getByLabelText("Seleccionar users"));
    expect(screen.getByText("2 seleccionados")).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Archivar" }));
    await waitFor(() => expect(handlers.onChanged).toHaveBeenCalled());
    const [path, options] = call.mock.calls[0];
    expect(path).toBe("/orgs/o/projects/p/endpoints/bulk-status");
    expect(options.body.status).toBe("archived");
    expect([...options.body.ids].sort()).toEqual(["a", "b"]);
  });

  test("buscar espera a que se deje de escribir", async () => {
    const handlers = mount();
    fireEvent.change(screen.getByLabelText("Buscar endpoints"), { target: { value: "hea" } });
    expect(handlers.onSearch).not.toHaveBeenCalled();
    await waitFor(() => expect(handlers.onSearch).toHaveBeenCalledWith("hea"), { timeout: 1000 });
  });

  test("eliminar pide confirmación", async () => {
    mount();
    fireEvent.click(screen.getByText("health"));
    fireEvent.click(screen.getByLabelText("Eliminar"));
    expect(screen.getByText("Eliminar endpoint")).toBeDefined();
    expect(call).not.toHaveBeenCalled();
  });
});

const PAGE_ONE = (patch: Partial<EndpointView> = {}): EndpointPage => ({
  ...PAGE,
  data: [endpoint("h", "GET", "/health", patch)],
  meta: { page: 1, limit: 100, total: 1, totalPages: 1 },
});

describe("la lista de endpoints: estados vacíos y cabecera", () => {
  test("sin página todavía dice que carga y no cuenta nada", () => {
    mount({ page: undefined, loading: true });
    expect(screen.getByText("Cargando…")).toBeDefined();
    expect(screen.getByText("Todos").textContent).toBe("Todos");
  });

  test("sin endpoints en activos invita a crear o importar", () => {
    mount({ page: { ...PAGE, data: [] } });
    expect(screen.getByText("Todavía no hay endpoints")).toBeDefined();
    expect(screen.getByText(/Crea uno, importa un fichero/)).toBeDefined();
    expect(screen.queryByText("Limpiar búsqueda")).toBeNull();
  });

  test("sin endpoints en otro estado sólo dice que no hay ninguno", () => {
    mount({ page: { ...PAGE, data: [] }, status: "archived" });
    expect(screen.getByText("Ninguno en este estado.")).toBeDefined();
  });

  test("una búsqueda sin resultados se puede limpiar", () => {
    const handlers = mount({ page: { ...PAGE, data: [] }, search: "nada" });
    expect(screen.getByText("Sin resultados")).toBeDefined();
    expect(screen.getByText("Prueba con otra búsqueda.")).toBeDefined();
    fireEvent.click(screen.getByText("Limpiar búsqueda"));
    expect(handlers.onSearch).toHaveBeenCalledWith("");
    expect((screen.getByLabelText("Buscar endpoints") as HTMLInputElement).value).toBe("");
  });

  test("«+ Nuevo», «Importar» y los filtros de estado avisan hacia arriba", () => {
    openImport.mockReset();
    const handlers = mount();
    fireEvent.click(screen.getByText("+ Nuevo"));
    expect(handlers.onNew).toHaveBeenCalled();
    fireEvent.click(screen.getByText("Importar"));
    expect(openImport).toHaveBeenCalled();
    fireEvent.click(screen.getByText("Archivados"));
    expect(handlers.onStatus).toHaveBeenCalledWith("archived");
    expect(screen.getByText("3 de 4")).toBeDefined();
  });

  test("sin permiso de edición no hay botones de crear ni de fila", () => {
    mount({ canEdit: false });
    expect(screen.queryByText("+ Nuevo")).toBeNull();
    fireEvent.click(screen.getByText("health"));
    expect(screen.queryByLabelText("Eliminar")).toBeNull();
  });
});

describe("la lista de endpoints: carpetas y filas", () => {
  test("una carpeta se abre y se cierra con clic, Enter o espacio", () => {
    mount();
    const folder = screen.getByText("health").closest("[role=button]") as HTMLElement;
    fireEvent.keyDown(folder, { key: "Enter" });
    expect(folder.getAttribute("aria-expanded")).toBe("true");
    fireEvent.keyDown(folder, { key: " " });
    expect(folder.getAttribute("aria-expanded")).toBe("false");
    fireEvent.keyDown(folder, { key: "a" });
    expect(folder.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(folder);
    fireEvent.click(folder);
    expect(folder.getAttribute("aria-expanded")).toBe("false");
  });

  test("buscando, todas las carpetas vienen abiertas", () => {
    mount({ search: "u" });
    expect(screen.getByText("/users/{id}")).toBeDefined();
  });

  test("clic en la fila la selecciona; su checkbox entra y sale de la selección", () => {
    const handlers = mount();
    fireEvent.click(screen.getByText("health"));
    fireEvent.click(screen.getByText("/health"));
    expect(handlers.onSelect).toHaveBeenCalledWith("c");
    const box = screen.getByLabelText("Seleccionar GET /health");
    fireEvent.click(box);
    expect(screen.getByText("1 seleccionados")).toBeDefined();
    fireEvent.click(box);
    expect(screen.queryByText("1 seleccionados")).toBeNull();
  });

  test("la fila activa con auth y fuera de contrato, y la inactiva tachada con su insignia", () => {
    mount({
      selectedId: "x",
      status: "all",
      page: {
        ...PAGE,
        data: [
          endpoint("x", "GET", "/a", { requiresAuth: true, inContract: false }),
          endpoint("y", "GET", "/b", { status: "inactive" }),
        ],
      },
    });
    fireEvent.click(screen.getByText("a"));
    fireEvent.click(screen.getByText("b"));
    expect(screen.getByTitle("Pide autenticación")).toBeDefined();
    expect(screen.getByText("fuera")).toBeDefined();
    expect(screen.getByText("/b").className).toContain("line-through");
    expect(screen.getByText("activo")).toBeDefined();
    expect(screen.getByText("inactivo")).toBeDefined();
  });
});

describe("la lista de endpoints: acciones de una fila", () => {
  test("archivar una fila activa la archiva", async () => {
    const handlers = mount({ page: PAGE_ONE() });
    fireEvent.click(screen.getByText("health"));
    fireEvent.click(screen.getByLabelText("Archivar"));
    await waitFor(() => expect(screen.getByText("Endpoint archivado")).toBeDefined());
    expect(call.mock.calls[0][1].body).toEqual({ ids: ["h"], status: "archived" });
    expect(handlers.onChanged).toHaveBeenCalled();
  });

  test("activar una fila archivada la activa", async () => {
    mount({ page: PAGE_ONE({ status: "archived" }), status: "archived" });
    fireEvent.click(screen.getByText("health"));
    expect(screen.getByText("archivado")).toBeDefined();
    fireEvent.click(screen.getByLabelText("Activar"));
    await waitFor(() => expect(screen.getByText("Endpoint activado")).toBeDefined());
    expect(call.mock.calls[0][1].body.status).toBe("active");
  });

  test("si archivar falla lo dice", async () => {
    mount({ page: PAGE_ONE() });
    call.mockRejectedValueOnce(new Error("sin permiso"));
    fireEvent.click(screen.getByText("health"));
    fireEvent.click(screen.getByLabelText("Archivar"));
    await waitFor(() => expect(screen.getByText("sin permiso")).toBeDefined());
  });

  test("eliminar una fila confirmada la borra con DELETE y la saca de la selección", async () => {
    const handlers = mount({ page: PAGE_ONE() });
    call.mockResolvedValueOnce(undefined);
    fireEvent.click(screen.getByText("health"));
    fireEvent.click(screen.getByLabelText("Seleccionar GET /health"));
    fireEvent.click(screen.getByLabelText("Eliminar"));
    fireEvent.click(screen.getAllByRole("button", { name: "Eliminar" }).at(-1)!);
    await waitFor(() => expect(screen.getByText("1 endpoint eliminado")).toBeDefined());
    expect(call).toHaveBeenCalledWith("/orgs/o/projects/p/endpoints/h", { method: "DELETE" });
    expect(handlers.onRemoved).toHaveBeenCalledWith(["h"]);
    expect(screen.queryByText("1 seleccionados")).toBeNull();
    expect(screen.queryByText("Eliminar endpoint")).toBeNull();
  });

  test("cancelar la confirmación no borra nada", () => {
    mount();
    fireEvent.click(screen.getByText("health"));
    fireEvent.click(screen.getByLabelText("Eliminar"));
    fireEvent.click(screen.getByText("Cancelar"));
    expect(screen.queryByText("Eliminar endpoint")).toBeNull();
    expect(call).not.toHaveBeenCalled();
  });

  test("si borrar falla cierra la confirmación y lo dice", async () => {
    mount();
    call.mockRejectedValueOnce(new Error("no se pudo"));
    fireEvent.click(screen.getByText("health"));
    fireEvent.click(screen.getByLabelText("Eliminar"));
    fireEvent.click(screen.getAllByRole("button", { name: "Eliminar" }).at(-1)!);
    await waitFor(() => expect(screen.getByText("no se pudo")).toBeDefined());
    expect(screen.queryByText("Eliminar endpoint")).toBeNull();
  });
});

describe("la lista de endpoints: la barra de selección", () => {
  test("en activos: desactivar uno dice «actualizado» en singular", async () => {
    mount();
    call.mockResolvedValueOnce({ updated: 1 });
    fireEvent.click(screen.getByLabelText("Seleccionar health"));
    expect(screen.queryByRole("button", { name: "Activar" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Desactivar" }));
    await waitFor(() => expect(screen.getByText("1 endpoint actualizado")).toBeDefined());
    expect(call.mock.calls[0][1].body.status).toBe("inactive");
  });

  test("en archivados sólo se puede activar, y un error se cuenta", async () => {
    mount({ status: "archived" });
    call.mockRejectedValueOnce(new Error("falló el lote"));
    fireEvent.click(screen.getByLabelText("Seleccionar health"));
    expect(screen.queryByRole("button", { name: "Desactivar" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Activar" }));
    await waitFor(() => expect(screen.getByText("falló el lote")).toBeDefined());
  });

  test("en «todos» caben las tres, y el lote se borra por bulk-delete", async () => {
    const handlers = mount({ status: "all" });
    call.mockResolvedValueOnce({ deleted: 2 });
    fireEvent.click(screen.getByLabelText("Seleccionar users"));
    expect(screen.getByRole("button", { name: "Activar" })).toBeDefined();
    expect(screen.getByRole("button", { name: "Desactivar" })).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Eliminar" }));
    expect(screen.getByText("Eliminar endpoints")).toBeDefined();
    fireEvent.click(screen.getAllByRole("button", { name: "Eliminar" }).at(-1)!);
    await waitFor(() => expect(screen.getByText("2 endpoints eliminados")).toBeDefined());
    expect(call.mock.calls[0][0]).toBe("/orgs/o/projects/p/endpoints/bulk-delete");
    expect(handlers.onRemoved).toHaveBeenCalled();
  });

  test("«limpiar» vacía la selección", () => {
    mount();
    fireEvent.click(screen.getByLabelText("Seleccionar health"));
    fireEvent.click(screen.getByText("limpiar"));
    expect(screen.queryByText("1 seleccionados")).toBeNull();
  });
});

describe("la lista de endpoints: páginas", () => {
  test("muestra dos páginas a cada lado de la actual y navega", () => {
    const handlers = mount({ page: { ...PAGE, meta: { ...PAGE.meta, totalPages: 7 } }, pageNumber: 4 });
    expect(screen.queryByRole("button", { name: "1" })).toBeNull();
    expect(screen.getByRole("button", { name: "6" })).toBeDefined();
    fireEvent.click(screen.getByText("Anterior"));
    expect(handlers.onPage).toHaveBeenCalledWith(3);
    fireEvent.click(screen.getByText("Siguiente"));
    expect(handlers.onPage).toHaveBeenCalledWith(5);
    fireEvent.click(screen.getByRole("button", { name: "6" }));
    expect(handlers.onPage).toHaveBeenCalledWith(6);
  });
});
