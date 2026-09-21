/**
 * El ciclo de vida de un mock en su pantalla: archivar, restaurar y borrar del todo.
 *
 * Lo que aquí importa y no se ve en el diálogo compartido: que el filtro pide la lista que dice, y
 * que cada botón llama a su ruta con lo que el servidor espera.
 */
import { describe, expect, test, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";

import { MocksPage } from "@/routes/mocks";
import { ToastProvider } from "@/components/toast";
import type { MockListView, MockServerView } from "@/lib/types";

const call = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", async (original) => ({
  ...(await original<object>()),
  api: call,
  absoluteApiUrl: (path: string) => `https://eq.test/api${path}`,
}));
vi.mock("@/lib/auth", () => ({ useOrganization: () => ({ id: "o", name: "Org" }), useCan: () => true }));

const BASE = "/orgs/o/projects/p1/mocks";

const mock = (patch: Partial<MockServerView> = {}): MockServerView => ({
  id: "m1",
  name: "el del front",
  publicId: "AbCdEfGhIjKlMnOpQrStUv",
  visibility: "public",
  apiKeyPreview: "",
  delay: { kind: "none" },
  enabled: true,
  createdAt: "2026-03-01T10:00:00.000Z",
  updatedAt: "2026-03-01T10:00:00.000Z",
  createdBy: "u1",
  archivedAt: null,
  deletedAt: null,
  ...patch,
});

/** Cada estado con su fila, para que el filtro tenga algo distinto que enseñar. */
function draw(mutate: (path: string, options?: { method?: string; body?: unknown }) => unknown = () => undefined) {
  call.mockReset();
  call.mockImplementation((path: string, options?: { method?: string; body?: unknown }) =>
    Promise.resolve().then(() => {
      if (options?.method) return mutate(path, options);
      if (path.endsWith("/calls")) return { calls: [], keep: 50 };
      const archived = path.includes("state=archived");
      const deleted = path.includes("state=deleted");
      const mocks = deleted
        ? [mock({ id: "m3", name: "el borrado", deletedAt: "2026-03-02T10:00:00.000Z" })]
        : archived
          ? [mock({ id: "m2", name: "el archivado", archivedAt: "2026-03-02T10:00:00.000Z" })]
          : [mock()];
      return { mocks, coverage: null, prefix: "/mock" } as unknown as MockListView;
    }),
  );
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <ToastProvider>
        <MemoryRouter initialEntries={["/p/p1/mocks"]}>
          <Routes>
            <Route path="/p/:projectId/mocks" element={<MocksPage />} />
          </Routes>
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

const tab = (name: RegExp) => fireEvent.click(screen.getByRole("tab", { name }));

describe("los tres filtros de la pantalla de mocks", () => {
  test("cada uno pide su lista, y la fila dice desde cuándo está fuera", async () => {
    draw();
    expect(await screen.findByText("el del front")).toBeTruthy();

    tab(/Archivados/);
    expect(await screen.findByText("el archivado")).toBeTruthy();
    expect(screen.getByText("archivado")).toBeTruthy();
    await waitFor(() => expect(call).toHaveBeenCalledWith(`${BASE}?state=archived`));
    // Apagar y la clave no se ofrecen sobre algo que ya no contesta.
    expect(screen.queryByRole("button", { name: "Apagar" })).toBeNull();

    tab(/Eliminados/);
    expect(await screen.findByText("el borrado")).toBeTruthy();
    expect(screen.getByText(/^eliminado /)).toBeTruthy();
    await waitFor(() => expect(call).toHaveBeenCalledWith(`${BASE}?state=deleted`));
  });

  test("archivar desde la fila, y desarchivar desde los archivados", async () => {
    draw();
    fireEvent.click(await screen.findByRole("button", { name: "Archivar" }));
    await waitFor(() =>
      expect(call).toHaveBeenCalledWith(`${BASE}/m1/archived`, { method: "PATCH", body: { archived: true } }),
    );
    expect(await screen.findByText("«el del front» archivado")).toBeTruthy();

    tab(/Archivados/);
    fireEvent.click(await screen.findByRole("button", { name: "Desarchivar" }));
    await waitFor(() =>
      expect(call).toHaveBeenCalledWith(`${BASE}/m2/archived`, { method: "PATCH", body: { archived: false } }),
    );
    expect(await screen.findByText("«el archivado» desarchivado")).toBeTruthy();
  });

  test("archivar desde el diálogo de borrado: es la salida que casi siempre se quería", async () => {
    draw();
    fireEvent.click(await screen.findByRole("button", { name: "Eliminar" }));
    fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Archivar" }));
    await waitFor(() =>
      expect(call).toHaveBeenCalledWith(`${BASE}/m1/archived`, { method: "PATCH", body: { archived: true } }),
    );
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  test("un fallo al archivar se dice", async () => {
    draw(() => {
      throw new Error("Sin permiso");
    });
    fireEvent.click(await screen.findByRole("button", { name: "Archivar" }));
    expect(await screen.findByText("Sin permiso")).toBeTruthy();
  });

  test("restaurar desde la papelera, y un fallo se dice", async () => {
    let fail = false;
    draw(() => {
      if (fail) throw new Error("Ya hay un mock llamado así");
      return mock();
    });
    tab(/Eliminados/);
    fireEvent.click(await screen.findByRole("button", { name: "Restaurar" }));
    await waitFor(() => expect(call).toHaveBeenCalledWith(`${BASE}/m3/restore`, { method: "POST" }));
    expect(await screen.findByText("«el borrado» restaurado")).toBeTruthy();

    fail = true;
    fireEvent.click(screen.getByRole("button", { name: "Restaurar" }));
    expect(await screen.findByText("Ya hay un mock llamado así")).toBeTruthy();
  });

  test("el definitivo pide el nombre escrito y manda `purge`", async () => {
    draw();
    tab(/Eliminados/);
    fireEvent.click(await screen.findByRole("button", { name: "Eliminar para siempre" }));
    const dialog = within(await screen.findByRole("dialog"));
    expect(dialog.getByText(/con su bitácora de llamadas/)).toBeTruthy();
    fireEvent.change(dialog.getByRole("textbox"), { target: { value: "el borrado" } });
    fireEvent.click(dialog.getByRole("button", { name: "Eliminar para siempre" }));
    await waitFor(() => expect(call).toHaveBeenCalledWith(`${BASE}/m3?purge=true`, { method: "DELETE" }));
    expect(await screen.findByText("«el borrado» eliminado para siempre")).toBeTruthy();
  });
});
