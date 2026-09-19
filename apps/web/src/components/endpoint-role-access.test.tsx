import { describe, expect, test, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { EndpointRoleAccess } from "@/components/endpoint-role-access";
import { ToastProvider } from "@/components/toast";

const call = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", async (original) => ({ ...(await original<object>()), api: call }));

const BASE = "/orgs/o/projects/p";

function mount(
  roles: unknown[],
  endpointId: string | null = "e1",
  { operationId = "getOrder", fail = false }: { operationId?: string | null; fail?: boolean } = {},
) {
  call.mockReset();
  call.mockImplementation(async (path: string, options?: { method?: string }) => {
    if (path === `${BASE}/endpoints/e1/role-access` && !options?.method) return { roles };
    if (fail) throw new Error("No tienes permiso para esto");
    return { updated: 1 };
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(
    <MemoryRouter>
      <QueryClientProvider client={client}>
        <ToastProvider>
          <EndpointRoleAccess base={BASE} projectId="p" endpointId={endpointId} operationId={operationId} canEdit />
        </ToastProvider>
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

describe("el acceso por rol de un endpoint", () => {
  test("cada rol con su estado; el alcance solo se elige si pasa; guardar manda solo lo cambiado", async () => {
    mount([
      { roleId: "r1", name: "vendedor", color: "#6366f1", access: "allow", dataScope: "own" },
      { roleId: "r2", name: "comprador", color: "#8b5cf6", access: "undecided", dataScope: "all" },
    ]);
    const buyer = await screen.findByLabelText<HTMLSelectElement>("Acceso de comprador");
    expect(buyer.value).toBe("undecided");
    expect(screen.getByLabelText<HTMLSelectElement>("Datos de comprador").disabled).toBe(true);
    expect(screen.getByLabelText<HTMLSelectElement>("Datos de vendedor").value).toBe("own");
    expect(screen.getByText("getOrder")).toBeDefined();

    fireEvent.change(buyer, { target: { value: "deny" } });
    expect(screen.getByText("1 cambio")).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Guardar permisos" }));
    await waitFor(() =>
      expect(call).toHaveBeenCalledWith(
        `${BASE}/endpoints/e1/role-access`,
        expect.objectContaining({
          method: "PUT",
          body: { permissions: [{ roleId: "r2", access: "deny", dataScope: "all" }] },
        }),
      ),
    );
  });

  test("sin roles lleva a crearlos; un endpoint sin guardar lo dice", async () => {
    mount([]);
    expect(await screen.findByText("Créalos en Roles")).toBeDefined();
  });

  test("un endpoint nuevo pide guardarlo antes", () => {
    mount([], null);
    expect(screen.getByText(/Guarda el endpoint para decidir/)).toBeDefined();
  });

  test("cambiar el alcance cuenta como cambio, y «Descartar» vuelve a lo guardado", async () => {
    mount(
      [
        { roleId: "r1", name: "vendedor", color: "#6366f1", access: "allow", dataScope: "own" },
        { roleId: "r2", name: "comprador", color: "#8b5cf6", access: "undecided", dataScope: "all" },
      ],
      "e1",
      { operationId: null },
    );
    const scope = await screen.findByLabelText<HTMLSelectElement>("Datos de vendedor");
    expect(screen.getByText(/no está en el contrato/)).toBeDefined();
    fireEvent.change(scope, { target: { value: "all" } });
    fireEvent.change(screen.getByLabelText("Acceso de comprador"), { target: { value: "allow" } });
    expect(screen.getByText("2 cambios")).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Descartar" }));
    expect(screen.getByLabelText<HTMLSelectElement>("Datos de vendedor").value).toBe("own");
    expect(screen.queryByText(/cambios?$/)).toBeNull();
  });

  test("guardar dice que se guardó, o por qué no", async () => {
    mount([{ roleId: "r1", name: "vendedor", color: "#6366f1", access: "allow", dataScope: "own" }]);
    fireEvent.change(await screen.findByLabelText("Acceso de vendedor"), { target: { value: "deny" } });
    fireEvent.click(screen.getByRole("button", { name: "Guardar permisos" }));
    expect(await screen.findByText("Permisos por rol guardados")).toBeDefined();
  });

  test("un guardado rechazado se cuenta", async () => {
    mount([{ roleId: "r1", name: "vendedor", color: "#6366f1", access: "allow", dataScope: "own" }], "e1", {
      fail: true,
    });
    fireEvent.change(await screen.findByLabelText("Acceso de vendedor"), { target: { value: "deny" } });
    fireEvent.click(screen.getByRole("button", { name: "Guardar permisos" }));
    expect(await screen.findByText("No tienes permiso para esto")).toBeDefined();
  });
});
