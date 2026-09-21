/**
 * El ciclo de vida de un plan de carga: archivar, restaurar y borrar del todo.
 *
 * Lo que aquí importa: que el filtro pide la lista que dice, que el diálogo recuerda que las
 * corridas se quedan —cada una guarda el plan como era— y que cada botón llama a su ruta.
 */
import { afterEach, describe, expect, test, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";

import { PerformancePage } from "@/routes/performance";
import { emptyPlanDefinition } from "@/lib/performance";
import type { PerformancePlanView } from "@/lib/types";

type Options = { method?: string; body?: unknown };

const mocks = vi.hoisted(() => ({ api: vi.fn(), streamRun: vi.fn() }));
vi.mock("@/lib/api", async (original) => ({
  ...(await original<object>()),
  api: mocks.api,
  streamRun: mocks.streamRun,
}));
vi.mock("@/lib/auth", () => ({ useOrganization: () => ({ id: "o", name: "Org" }), useCan: () => true }));

afterEach(() => {
  mocks.api.mockReset();
});

const BASE = "/orgs/o/projects/p1";

const plan = (patch: Partial<PerformancePlanView> = {}): PerformancePlanView => ({
  id: "pl1",
  name: "Catálogo",
  description: null,
  definition: emptyPlanDefinition(),
  updatedAt: "2026-03-01T10:00:00.000Z",
  archivedAt: null,
  deletedAt: null,
  ...patch,
});

function draw(mutate: (path: string, options?: Options) => unknown = () => undefined) {
  mocks.api.mockImplementation((path: string, options?: Options) => {
    if (options?.method) return Promise.resolve().then(() => mutate(path, options));
    if (path.includes("/performance/plans")) {
      if (path.includes("state=deleted"))
        return Promise.resolve([plan({ id: "pl3", name: "El borrado", deletedAt: "2026-03-02T10:00:00.000Z" })]);
      if (path.includes("state=archived"))
        return Promise.resolve([plan({ id: "pl2", name: "El archivado", archivedAt: "2026-03-02T10:00:00.000Z" })]);
      return Promise.resolve([plan()]);
    }
    if (path.endsWith("/environments")) return Promise.resolve([{ id: "env-1", name: "staging", active: true }]);
    if (path.includes("/performance/runs?planId=")) return Promise.resolve([]);
    return new Promise(() => undefined);
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={["/p/p1/performance"]}>
        <Routes>
          <Route path="/p/:projectId/performance" element={<PerformancePage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const nameField = () => screen.getByLabelText("Nombre del plan") as HTMLInputElement;
const tab = (name: RegExp) => fireEvent.click(screen.getByRole("tab", { name }));

describe("los tres filtros de los planes", () => {
  test("cada uno pide su lista y dice qué hay cuando está vacía", async () => {
    mocks.api.mockImplementation((path: string, options?: Options) => {
      if (options?.method) return Promise.resolve(undefined);
      if (path.includes("/performance/plans")) return Promise.resolve(path.includes("state=") ? [] : [plan()]);
      if (path.endsWith("/environments")) return Promise.resolve([]);
      return Promise.resolve([]);
    });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={["/p/p1/performance"]}>
          <Routes>
            <Route path="/p/:projectId/performance" element={<PerformancePage />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
    await waitFor(() => expect(nameField().value).toBe("Catálogo"));

    tab(/Archivados/);
    expect(await screen.findByText("Ninguno archivado.")).toBeTruthy();
    tab(/Eliminados/);
    expect(await screen.findByText("Papelera vacía.")).toBeTruthy();
  });

  test("archivar y desarchivar mandan el booleano que toca", async () => {
    draw();
    await waitFor(() => expect(nameField().value).toBe("Catálogo"));
    fireEvent.click(screen.getByRole("button", { name: "Archivar" }));
    await waitFor(() =>
      expect(mocks.api).toHaveBeenCalledWith(`${BASE}/performance/plans/pl1/archived`, {
        method: "PATCH",
        body: { archived: true },
      }),
    );

    tab(/Archivados/);
    await waitFor(() => expect(nameField().value).toBe("El archivado"));
    fireEvent.click(screen.getByRole("button", { name: "Desarchivar" }));
    await waitFor(() =>
      expect(mocks.api).toHaveBeenCalledWith(`${BASE}/performance/plans/pl2/archived`, {
        method: "PATCH",
        body: { archived: false },
      }),
    );
  });

  test("el diálogo ofrece archivar y recuerda que las corridas se quedan", async () => {
    draw();
    await waitFor(() => expect(nameField().value).toBe("Catálogo"));
    fireEvent.click(screen.getAllByRole("button", { name: "Eliminar" })[1]);
    const dialog = within(await screen.findByRole("dialog"));
    expect(dialog.getByText(/cada una guarda el plan como era/)).toBeTruthy();
    fireEvent.click(dialog.getByRole("button", { name: "Archivar" }));
    await waitFor(() =>
      expect(mocks.api).toHaveBeenCalledWith(`${BASE}/performance/plans/pl1/archived`, {
        method: "PATCH",
        body: { archived: true },
      }),
    );
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  test("desde la papelera se restaura, y el definitivo pide el nombre", async () => {
    draw();
    await waitFor(() => expect(nameField().value).toBe("Catálogo"));
    tab(/Eliminados/);
    await waitFor(() => expect(nameField().value).toBe("El borrado"));

    fireEvent.click(screen.getByRole("button", { name: "Restaurar" }));
    await waitFor(() =>
      expect(mocks.api).toHaveBeenCalledWith(`${BASE}/performance/plans/pl3/restore`, { method: "POST" }),
    );

    tab(/Eliminados/);
    await waitFor(() => expect(nameField().value).toBe("El borrado"));
    fireEvent.click(screen.getByRole("button", { name: "Eliminar para siempre" }));
    const dialog = within(await screen.findByRole("dialog"));
    expect(dialog.getByText(/con sus escenarios y sus umbrales/)).toBeTruthy();
    fireEvent.change(dialog.getByRole("textbox"), { target: { value: "El borrado" } });
    fireEvent.click(dialog.getByRole("button", { name: "Eliminar para siempre" }));
    await waitFor(() =>
      expect(mocks.api).toHaveBeenCalledWith(`${BASE}/performance/plans/pl3?purge=true`, { method: "DELETE" }),
    );
  });

  test("cancelar el diálogo no manda nada", async () => {
    draw();
    await waitFor(() => expect(nameField().value).toBe("Catálogo"));
    fireEvent.click(screen.getAllByRole("button", { name: "Eliminar" })[1]);
    fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Cancelar" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(mocks.api.mock.calls.some(([, options]) => (options as Options | undefined)?.method === "DELETE")).toBe(
      false,
    );
  });
});
