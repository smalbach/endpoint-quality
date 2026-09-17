import { describe, expect, test, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { EndpointList } from "@/components/endpoint-list";
import { ToastProvider } from "@/components/toast";
import { ImportProvider } from "@/components/import-provider";
import type { EndpointPage, EndpointView } from "@/lib/types";

const call = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", async (original) => ({ ...(await original<object>()), api: call }));

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
  hasContract: true,
};

function mount(props: Partial<Parameters<typeof EndpointList>[0]> = {}) {
  call.mockReset();
  call.mockResolvedValue({ updated: 2 });
  const handlers = { onSelect: vi.fn(), onSearch: vi.fn(), onChanged: vi.fn(async () => undefined), onStatus: vi.fn() };
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
            onPage={vi.fn()}
            selectedId={null}
            onNew={vi.fn()}
            canEdit
            onRemoved={vi.fn()}
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
