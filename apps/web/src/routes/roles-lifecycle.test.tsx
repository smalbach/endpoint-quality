/**
 * El ciclo de vida de un rol: archivar —sale de la matriz—, restaurar y borrar del todo.
 *
 * Lo que hay que demostrar: que el filtro pide su lista, que restaurar promete devolver la matriz
 * que se decidió con él, y que el definitivo dice que las credenciales cifradas de ese rol en cada
 * entorno se van con él.
 */
import { describe, expect, test, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";

import { RolesPage } from "@/routes/roles";
import { ToastProvider } from "@/components/toast";
import type { EndpointPage, RoleView } from "@/lib/types";

const call = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", async (original) => ({ ...(await original<object>()), api: call }));
vi.mock("@/lib/auth", () => ({ useOrganization: () => ({ id: "o", name: "Org" }), useCan: () => true }));

const BASE = "/orgs/o/projects/p1";

const role = (patch: Partial<RoleView>): RoleView => ({
  id: "r1",
  name: "vendedor",
  description: "",
  color: "#6366f1",
  sameRoleDataIsolation: false,
  position: 0,
  createdAt: "2026-03-01T10:00:00.000Z",
  updatedAt: "2026-03-01T10:00:00.000Z",
  allowed: 0,
  denied: 0,
  archivedAt: null,
  deletedAt: null,
  ...patch,
});

const endpoints: EndpointPage = {
  data: [],
  meta: { page: 1, limit: 500, total: 0, totalPages: 1 },
  counts: { active: 0, archived: 0, inactive: 0 },
  deleted: 0,
  hasContract: false,
};

function draw(mutate: (path: string, options?: { method?: string; body?: unknown }) => unknown = () => ({})) {
  call.mockReset();
  call.mockImplementation((path: string, options?: { method?: string; body?: unknown }) =>
    Promise.resolve().then(() => {
      if (options?.method) return mutate(path, options);
      if (path.includes("/roles?") || path.endsWith("/roles")) {
        if (path.includes("state=deleted"))
          return [role({ id: "r3", name: "borrado", deletedAt: "2026-03-02T10:00:00.000Z" })];
        if (path.includes("state=archived"))
          return [role({ id: "r2", name: "archivado", archivedAt: "2026-03-02T10:00:00.000Z" })];
        return [role({})];
      }
      if (path.endsWith("/permissions")) return { permissions: [] };
      if (path.endsWith("/role-rules")) return { rules: [] };
      if (path.endsWith("/environments")) return [];
      if (path.includes("/endpoints?")) return endpoints;
      if (path.endsWith("/config")) return { sections: {} };
      if (path.endsWith("/operations")) return { operations: [] };
      if (path === BASE) return { contract: null };
      throw new Error(`inesperado ${path}`);
    }),
  );
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <ToastProvider>
        <MemoryRouter initialEntries={["/p/p1/roles"]}>
          <Routes>
            <Route path="/p/:projectId/roles" element={<RolesPage />} />
          </Routes>
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

const tab = (name: RegExp) => fireEvent.click(screen.getByRole("tab", { name }));

describe("los tres filtros de los roles", () => {
  test("cada uno pide su lista y explica qué es cada sitio cuando está vacío", async () => {
    call.mockReset();
    call.mockImplementation((path: string, options?: { method?: string }) =>
      Promise.resolve().then(() => {
        if (options?.method) return {};
        if (path.includes("/roles")) return path.includes("state=") ? [] : [role({})];
        if (path.endsWith("/permissions")) return { permissions: [] };
        if (path.endsWith("/role-rules")) return { rules: [] };
        if (path.endsWith("/environments")) return [];
        if (path.includes("/endpoints?")) return endpoints;
        if (path.endsWith("/config")) return { sections: {} };
        if (path.endsWith("/operations")) return { operations: [] };
        return { contract: null };
      }),
    );
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <ToastProvider>
          <MemoryRouter initialEntries={["/p/p1/roles"]}>
            <Routes>
              <Route path="/p/:projectId/roles" element={<RolesPage />} />
            </Routes>
          </MemoryRouter>
        </ToastProvider>
      </QueryClientProvider>,
    );
    await screen.findByText("vendedor");
    tab(/Archivados/);
    expect(await screen.findByText(/Ningún rol archivado/)).toBeTruthy();
    tab(/Eliminados/);
    expect(await screen.findByText(/Papelera vacía/)).toBeTruthy();
  });

  test("archivar y desarchivar mandan su booleano y lo dicen", async () => {
    draw();
    await screen.findByText("vendedor");
    fireEvent.click(screen.getByRole("button", { name: "Archivar" }));
    await waitFor(() =>
      expect(call).toHaveBeenCalledWith(`${BASE}/roles/r1/archived`, { method: "PATCH", body: { archived: true } }),
    );
    expect(await screen.findByText("Rol «vendedor» archivado")).toBeTruthy();

    tab(/Archivados/);
    await screen.findByText("archivado");
    fireEvent.click(screen.getByRole("button", { name: "Desarchivar" }));
    await waitFor(() =>
      expect(call).toHaveBeenCalledWith(`${BASE}/roles/r2/archived`, { method: "PATCH", body: { archived: false } }),
    );
    expect(await screen.findByText("Rol «archivado» desarchivado")).toBeTruthy();
  });

  test("un fallo al archivar se dice", async () => {
    draw(() => {
      throw new Error("Sin permiso");
    });
    await screen.findByText("vendedor");
    fireEvent.click(screen.getByRole("button", { name: "Archivar" }));
    expect(await screen.findByText("Sin permiso")).toBeTruthy();
  });

  test("el diálogo ofrece archivar y promete la matriz de vuelta", async () => {
    draw();
    await screen.findByText("vendedor");
    fireEvent.click(screen.getByRole("button", { name: "Eliminar" }));
    const dialog = within(await screen.findByRole("dialog"));
    expect(dialog.getByText(/vuelve la matriz que se decidió con él/)).toBeTruthy();
    fireEvent.click(dialog.getByRole("button", { name: "Cancelar" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    fireEvent.click(screen.getByRole("button", { name: "Eliminar" }));
    fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Archivar" }));
    await waitFor(() =>
      expect(call).toHaveBeenCalledWith(`${BASE}/roles/r1/archived`, { method: "PATCH", body: { archived: true } }),
    );
  });

  test("restaurar lo dice con la matriz; el definitivo avisa de las credenciales", async () => {
    let fail = false;
    draw(() => {
      if (fail) throw new Error("Ya hay un rol con ese nombre");
      return {};
    });
    await screen.findByText("vendedor");
    tab(/Eliminados/);
    await screen.findByText("borrado");

    fireEvent.click(screen.getByRole("button", { name: "Restaurar" }));
    await waitFor(() => expect(call).toHaveBeenCalledWith(`${BASE}/roles/r3/restore`, { method: "POST" }));
    expect(await screen.findByText("Rol «borrado» restaurado, con la matriz que tenía")).toBeTruthy();

    fail = true;
    fireEvent.click(screen.getByRole("button", { name: "Restaurar" }));
    expect(await screen.findByText("Ya hay un rol con ese nombre")).toBeTruthy();

    fail = false;
    fireEvent.click(screen.getByRole("button", { name: "Eliminar para siempre" }));
    const dialog = within(await screen.findByRole("dialog"));
    expect(dialog.getByText(/credenciales cifradas no se pueden recuperar/)).toBeTruthy();
    fireEvent.change(dialog.getByRole("textbox"), { target: { value: "borrado" } });
    fireEvent.click(dialog.getByRole("button", { name: "Eliminar para siempre" }));
    await waitFor(() => expect(call).toHaveBeenCalledWith(`${BASE}/roles/r3?purge=true`, { method: "DELETE" }));
    expect(await screen.findByText("Rol «borrado» eliminado para siempre")).toBeTruthy();
  });
});
