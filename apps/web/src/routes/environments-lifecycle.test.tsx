/**
 * El ciclo de vida de un entorno en Settings: archivar, restaurar y borrar del todo.
 *
 * Aquí está la papelera de los entornos —el panel rápido de la barra manda aquí— y lo que hay que
 * demostrar es que el filtro pide su lista, que el detalle ofrece lo que toca en cada estado, y que
 * el definitivo dice en voz alta lo que sí se pierde: las credenciales cifradas.
 */
import { describe, expect, test, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";

import { EnvironmentsPage } from "@/routes/environments";
import { ImportProvider } from "@/components/import-provider";
import type { ConfigView, Environment } from "@/lib/types";

const call = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", async (original) => ({ ...(await original<object>()), api: call }));
vi.mock("@/lib/auth", () => ({ useOrganization: () => ({ id: "o", name: "Org" }), useCan: () => true }));

const BASE = "/orgs/o/projects/p1";

const environment = (patch: Partial<Environment> = {}): Environment => ({
  id: "e1",
  name: "staging",
  baseUrl: "https://staging.test",
  specUrl: null,
  variables: {},
  disabledVariables: {},
  writesAllowed: false,
  authEnforced: true,
  active: true,
  credentials: [],
  archivedAt: null,
  deletedAt: null,
  ...patch,
});

const config: ConfigView = {
  sections: { access: { data: { access: { roles: [] } }, configured: true, updatedAt: null } },
};

function draw(mutate: (path: string, options?: { method?: string; body?: unknown }) => unknown = () => undefined) {
  call.mockReset();
  call.mockImplementation((path: string, options?: { method?: string; body?: unknown }) =>
    Promise.resolve().then(() => {
      if (options?.method) return mutate(path, options);
      if (path.includes("/environments")) {
        if (path.includes("state=deleted"))
          return [environment({ id: "e3", name: "el borrado", active: false, deletedAt: "2026-03-02T10:00:00.000Z" })];
        if (path.includes("state=archived"))
          return [
            environment({ id: "e2", name: "el archivado", active: false, archivedAt: "2026-03-02T10:00:00.000Z" }),
          ];
        return [environment()];
      }
      if (path.endsWith("/config")) return config;
      throw new Error(`inesperado ${path}`);
    }),
  );
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={["/p/p1/settings/environments"]}>
        <ImportProvider projectId="p1">
          <Routes>
            <Route path="/p/:projectId/settings/environments" element={<EnvironmentsPage />} />
          </Routes>
        </ImportProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const tab = (name: RegExp) => fireEvent.click(screen.getByRole("tab", { name }));
const bar = () =>
  within(screen.getByText(/Todo guardado|Cambios sin guardar|Hay variables con problemas/).parentElement!);

describe("los tres filtros de los entornos", () => {
  test("cada uno pide su lista, y las vacías lo dicen", async () => {
    draw();
    expect(await screen.findByText("Entorno activo")).toBeTruthy();

    tab(/Archivados/);
    await waitFor(() => expect(call).toHaveBeenCalledWith(`${BASE}/environments?state=archived`));
    expect(await screen.findByText("el archivado")).toBeTruthy();

    tab(/Eliminados/);
    await waitFor(() => expect(call).toHaveBeenCalledWith(`${BASE}/environments?state=deleted`));
    expect(await screen.findByText("el borrado")).toBeTruthy();
  });

  test("una lista vacía dice en qué filtro está", async () => {
    call.mockReset();
    call.mockImplementation((path: string, options?: { method?: string }) =>
      Promise.resolve().then(() => {
        if (options?.method) return undefined;
        if (path.includes("/environments")) return path.includes("state=") ? [] : [environment()];
        return config;
      }),
    );
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={["/p/p1/settings/environments"]}>
          <ImportProvider projectId="p1">
            <Routes>
              <Route path="/p/:projectId/settings/environments" element={<EnvironmentsPage />} />
            </Routes>
          </ImportProvider>
        </MemoryRouter>
      </QueryClientProvider>,
    );
    await screen.findByText("Entorno activo");
    tab(/Archivados/);
    expect(await screen.findByText("Ninguno archivado.")).toBeTruthy();
    tab(/Eliminados/);
    expect(await screen.findByText("Papelera vacía.")).toBeTruthy();
  });

  test("archivar desde el detalle, y desarchivar desde los archivados", async () => {
    draw();
    await screen.findByText("Entorno activo");
    fireEvent.click(bar().getByRole("button", { name: "Archivar" }));
    await waitFor(() =>
      expect(call).toHaveBeenCalledWith(`${BASE}/environments/e1/archived`, {
        method: "PATCH",
        body: { archived: true },
      }),
    );

    tab(/Archivados/);
    await screen.findByText("el archivado");
    fireEvent.click(bar().getByRole("button", { name: "Desarchivar" }));
    await waitFor(() =>
      expect(call).toHaveBeenCalledWith(`${BASE}/environments/e2/archived`, {
        method: "PATCH",
        body: { archived: false },
      }),
    );
  });

  test("en la papelera se restaura, y el definitivo avisa de las credenciales y pide el nombre", async () => {
    draw();
    await screen.findByText("Entorno activo");
    tab(/Eliminados/);
    await screen.findByText("el borrado");

    fireEvent.click(bar().getByRole("button", { name: "Restaurar" }));
    await waitFor(() => expect(call).toHaveBeenCalledWith(`${BASE}/environments/e3/restore`, { method: "POST" }));

    fireEvent.click(bar().getByRole("button", { name: "Eliminar para siempre" }));
    const dialog = within(await screen.findByRole("dialog"));
    expect(dialog.getByText(/sus credenciales cifradas/)).toBeTruthy();
    fireEvent.change(dialog.getByRole("textbox"), { target: { value: "el borrado" } });
    fireEvent.click(dialog.getByRole("button", { name: "Eliminar para siempre" }));
    await waitFor(() => expect(call).toHaveBeenCalledWith(`${BASE}/environments/e3?purge=true`, { method: "DELETE" }));
  });
});
