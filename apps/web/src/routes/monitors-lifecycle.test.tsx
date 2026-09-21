/**
 * El ciclo de vida de un monitor: archivar —que **deja de vigilar**—, restaurar y borrar del todo.
 *
 * Lo que aquí importa y no dice el diálogo compartido: que en la papelera no se ofrece pausar,
 * correr ni editar, porque nada de eso tiene sentido sobre algo que no está en la lista.
 */
import { describe, expect, test, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";

import { MonitorsPage } from "@/routes/monitors";
import { ToastProvider } from "@/components/toast";
import type { MonitorExecutionView, MonitorView } from "@/lib/types";

const call = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", async (original) => ({ ...(await original<object>()), api: call }));
vi.mock("@/lib/auth", () => ({ useOrganization: () => ({ id: "o", name: "Org" }), useCan: () => true }));

const BASE = "/orgs/o/projects/p1";
type Listed = MonitorView & { recent: MonitorExecutionView[] };

const monitor = (patch: Partial<Listed> = {}): Listed => ({
  id: "m1",
  name: "producción",
  enabled: true,
  schedule: { kind: "interval", minutes: 60 },
  plan: { environmentId: "env-1" },
  alert: null,
  nextRunAt: "2026-03-01T11:00:00.000Z",
  lastRunAt: null,
  lastOutcome: null,
  consecutiveFailures: 0,
  createdAt: "2026-03-01T09:00:00.000Z",
  updatedAt: "2026-03-01T09:00:00.000Z",
  createdBy: "u1",
  scheduleLabel: "cada hora",
  recent: [],
  archivedAt: null,
  deletedAt: null,
  ...patch,
});

function draw(mutate: (path: string, options?: { method?: string; body?: unknown }) => unknown = () => monitor()) {
  call.mockReset();
  call.mockImplementation((path: string, options?: { method?: string; body?: unknown }) => {
    if (options?.method) return Promise.resolve().then(() => mutate(path, options));
    if (path.includes("/monitors")) {
      const monitors = path.includes("state=deleted")
        ? [monitor({ id: "m3", name: "el borrado", deletedAt: "2026-03-02T10:00:00.000Z", nextRunAt: null })]
        : path.includes("state=archived")
          ? [monitor({ id: "m2", name: "el archivado", archivedAt: "2026-03-02T10:00:00.000Z", nextRunAt: null })]
          : [monitor()];
      return Promise.resolve({ monitors });
    }
    if (path.endsWith("/environments")) return Promise.resolve([{ id: "env-1", name: "producción", variables: {} }]);
    if (path.endsWith("/channels")) return Promise.resolve({ channels: [] });
    return Promise.resolve({ workflows: [], suites: [] });
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <ToastProvider>
        <MemoryRouter initialEntries={["/p/p1/monitors"]}>
          <Routes>
            <Route path="/p/:projectId/monitors" element={<MonitorsPage />} />
          </Routes>
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

const tab = (name: RegExp) => fireEvent.click(screen.getByRole("tab", { name }));

describe("los tres filtros de los monitores", () => {
  test("cada uno pide su lista, y fuera de la viva no se pausa, ni se corre, ni se edita", async () => {
    draw();
    expect(await screen.findByText("producción")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Correr ahora" })).toBeTruthy();

    tab(/Archivados/);
    expect(await screen.findByText("el archivado")).toBeTruthy();
    expect(screen.getByText("archivado")).toBeTruthy();
    await waitFor(() => expect(call).toHaveBeenCalledWith(`${BASE}/monitors?state=archived`));
    expect(screen.queryByRole("button", { name: "Correr ahora" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Pausar" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Editar" })).toBeNull();

    tab(/Eliminados/);
    expect(await screen.findByText("el borrado")).toBeTruthy();
    expect(screen.getByText(/^eliminado /)).toBeTruthy();
  });

  test("archivar dice que deja de vigilar; desarchivar lo devuelve", async () => {
    draw();
    fireEvent.click(await screen.findByRole("button", { name: "Archivar" }));
    await waitFor(() =>
      expect(call).toHaveBeenCalledWith(`${BASE}/monitors/m1/archived`, { method: "PATCH", body: { archived: true } }),
    );
    expect(await screen.findByText("«producción» archivado: deja de vigilar")).toBeTruthy();

    tab(/Archivados/);
    fireEvent.click(await screen.findByRole("button", { name: "Desarchivar" }));
    await waitFor(() =>
      expect(call).toHaveBeenCalledWith(`${BASE}/monitors/m2/archived`, { method: "PATCH", body: { archived: false } }),
    );
    expect(await screen.findByText("«el archivado» desarchivado")).toBeTruthy();
  });

  test("archivar desde el diálogo de borrado, y un fallo al archivar se dice", async () => {
    let fail = false;
    draw(() => {
      if (fail) throw new Error("Sin permiso");
      return monitor();
    });
    fireEvent.click(await screen.findByRole("button", { name: "Eliminar" }));
    fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Archivar" }));
    await waitFor(() =>
      expect(call).toHaveBeenCalledWith(`${BASE}/monitors/m1/archived`, { method: "PATCH", body: { archived: true } }),
    );

    fail = true;
    fireEvent.click(screen.getByRole("button", { name: "Archivar" }));
    expect(await screen.findByText("Sin permiso")).toBeTruthy();
  });

  test("eliminar lo dice; el definitivo pide el nombre y manda `purge`; los fallos se dicen", async () => {
    let fail = false;
    draw(() => {
      if (fail) throw new Error("No se pudo");
      return monitor();
    });
    fireEvent.click(await screen.findByRole("button", { name: "Eliminar" }));
    fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Eliminar" }));
    await waitFor(() => expect(call).toHaveBeenCalledWith(`${BASE}/monitors/m1`, { method: "DELETE" }));
    expect(await screen.findByText("«producción» eliminado")).toBeTruthy();

    fail = true;
    fireEvent.click(screen.getByRole("button", { name: "Eliminar" }));
    fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Eliminar" }));
    expect(await screen.findByText("No se pudo")).toBeTruthy();

    fail = false;
    tab(/Eliminados/);
    fireEvent.click(await screen.findByRole("button", { name: "Eliminar para siempre" }));
    const dialog = within(await screen.findByRole("dialog"));
    expect(dialog.getByText(/con su horario y su historial/)).toBeTruthy();
    fireEvent.change(dialog.getByRole("textbox"), { target: { value: "el borrado" } });
    fireEvent.click(dialog.getByRole("button", { name: "Eliminar para siempre" }));
    await waitFor(() => expect(call).toHaveBeenCalledWith(`${BASE}/monitors/m3?purge=true`, { method: "DELETE" }));
    expect(await screen.findByText("«el borrado» eliminado para siempre")).toBeTruthy();
  });

  test("restaurar desde la papelera, y un fallo se dice", async () => {
    let fail = false;
    draw(() => {
      if (fail) throw new Error("Ya hay un monitor llamado así");
      return monitor();
    });
    tab(/Eliminados/);
    fireEvent.click(await screen.findByRole("button", { name: "Restaurar" }));
    await waitFor(() => expect(call).toHaveBeenCalledWith(`${BASE}/monitors/m3/restore`, { method: "POST" }));
    expect(await screen.findByText("«el borrado» restaurado")).toBeTruthy();

    fail = true;
    fireEvent.click(screen.getByRole("button", { name: "Restaurar" }));
    expect(await screen.findByText("Ya hay un monitor llamado así")).toBeTruthy();
  });
});
