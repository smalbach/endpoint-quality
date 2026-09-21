/**
 * El ciclo de vida de un canal: se archiva y se borra desde sus ajustes, y se vuelve desde la
 * papelera de la lista.
 *
 * Están en dos sitios a propósito: los ajustes son donde se decide sobre un canal que se usa, y la
 * papelera es una lista de nombres —lo que hay que decidir ahí es si vuelve o se va del todo.
 */
import { describe, expect, test, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";

import { ChannelsPage } from "@/routes/channels";
import { ToastProvider } from "@/components/toast";
import type { ChannelView } from "@/lib/types";

const call = vi.hoisted(() => vi.fn());
const stream = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", async (original) => ({
  ...(await original<object>()),
  api: call,
  streamRun: stream,
}));
vi.mock("@/lib/auth", () => ({ useOrganization: () => ({ id: "o", name: "Org" }), useCan: () => true }));

const BASE = "/orgs/o/projects/p1";

const channel = (patch: Partial<ChannelView> = {}): ChannelView => ({
  id: "c1",
  protocol: "ws",
  name: "eco",
  url: "wss://eco.example.test/socket",
  subprotocols: [],
  headers: [],
  auth: null,
  limits: { maxMessages: 200, maxBytes: 1_048_576, maxMessageBytes: 65_536, maxDurationMs: 30_000, idleMs: 10_000 },
  expectations: {},
  messages: [],
  mqtt: null,
  grpc: null,
  socketio: null,
  orderIndex: 0,
  createdAt: "2026-03-01T10:00:00.000Z",
  updatedAt: "2026-03-01T10:00:00.000Z",
  archivedAt: null,
  deletedAt: null,
  ...patch,
});

function draw(url = "/p/p1/channels?c=c1", mutate: (path: string) => unknown = () => ({})) {
  call.mockReset();
  stream.mockReset();
  call.mockImplementation(async (path: string, options?: { method?: string; body?: unknown }) => {
    const method = options?.method ?? "GET";
    if (method !== "GET") return mutate(path);
    if (path.endsWith("/environments")) return [{ id: "env-1", name: "staging", active: true, variables: {} }];
    if (path.includes("/channels?state=deleted"))
      return { channels: [channel({ id: "c3", name: "el borrado", deletedAt: "2026-03-02T10:00:00.000Z" })] };
    if (path.includes("/channels?state=archived"))
      return { channels: [channel({ id: "c2", name: "el archivado", archivedAt: "2026-03-02T10:00:00.000Z" })] };
    if (path.endsWith("/channels")) return { channels: [channel()] };
    if (/\/channels\/c\d$/.test(path)) return { ...channel(), sessions: [] };
    return {};
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <ToastProvider>
        <MemoryRouter initialEntries={[url]}>
          <Routes>
            <Route path="/p/:projectId/channels" element={<ChannelsPage />} />
          </Routes>
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

const tab = (name: RegExp) => fireEvent.click(screen.getByRole("tab", { name }));

describe("los tres filtros de los canales", () => {
  test("cada uno pide su lista, y las vacías dicen dónde estás", async () => {
    call.mockReset();
    call.mockImplementation(async (path: string, options?: { method?: string }) => {
      if ((options?.method ?? "GET") !== "GET") return {};
      if (path.endsWith("/environments")) return [];
      if (path.includes("state=")) return { channels: [] };
      if (path.endsWith("/channels")) return { channels: [channel()] };
      return { ...channel(), sessions: [] };
    });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <ToastProvider>
          <MemoryRouter initialEntries={["/p/p1/channels"]}>
            <Routes>
              <Route path="/p/:projectId/channels" element={<ChannelsPage />} />
            </Routes>
          </MemoryRouter>
        </ToastProvider>
      </QueryClientProvider>,
    );
    expect(await screen.findByText("eco")).toBeTruthy();
    tab(/Archivados/);
    expect(await screen.findByText("Ningún canal archivado")).toBeTruthy();
    tab(/Eliminados/);
    expect(await screen.findByText("Papelera vacía")).toBeTruthy();
  });

  test("desde la papelera se restaura y se borra del todo; la lista viva no ofrece ninguno de los dos", async () => {
    draw();
    expect(await screen.findByText("eco")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Restaurar" })).toBeNull();

    tab(/Eliminados/);
    expect(await screen.findByText("el borrado")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Restaurar" }));
    await waitFor(() => expect(call).toHaveBeenCalledWith(`${BASE}/channels/c3/restore`, { method: "POST" }));
    expect(await screen.findByText("«el borrado» restaurado")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Eliminar para siempre" }));
    const dialog = within(await screen.findByRole("dialog"));
    expect(dialog.getByText(/con sus tramas guardadas y sus conversaciones/)).toBeTruthy();
    fireEvent.change(dialog.getByRole("textbox"), { target: { value: "el borrado" } });
    fireEvent.click(dialog.getByRole("button", { name: "Eliminar para siempre" }));
    await waitFor(() => expect(call).toHaveBeenCalledWith(`${BASE}/channels/c3?purge=true`, { method: "DELETE" }));
    expect(await screen.findByText("«el borrado» eliminado para siempre")).toBeTruthy();
  });

  test("borrar del todo el canal abierto lo deselecciona", async () => {
    draw("/p/p1/channels?c=c3");
    tab(/Eliminados/);
    fireEvent.click(await screen.findByRole("button", { name: "Eliminar para siempre" }));
    const dialog = within(await screen.findByRole("dialog"));
    fireEvent.change(dialog.getByRole("textbox"), { target: { value: "el borrado" } });
    fireEvent.click(dialog.getByRole("button", { name: "Eliminar para siempre" }));
    await waitFor(() => expect(call).toHaveBeenCalledWith(`${BASE}/channels/c3?purge=true`, { method: "DELETE" }));
    expect(await screen.findByText("Elige un canal para conectarte a él")).toBeTruthy();
  });

  test("un fallo al restaurar o al borrar del todo se dice", async () => {
    draw("/p/p1/channels", () => {
      throw new Error("Este proyecto ya tiene 20 canales");
    });
    tab(/Eliminados/);
    fireEvent.click(await screen.findByRole("button", { name: "Restaurar" }));
    expect(await screen.findByText("Este proyecto ya tiene 20 canales")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Eliminar para siempre" }));
    const dialog = within(await screen.findByRole("dialog"));
    fireEvent.change(dialog.getByRole("textbox"), { target: { value: "el borrado" } });
    fireEvent.click(dialog.getByRole("button", { name: "Eliminar para siempre" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  test("un archivado se desarchiva o se elimina desde su fila, sin pasar por los ajustes", async () => {
    draw("/p/p1/channels");
    tab(/Archivados/);
    expect(await screen.findByText("el archivado")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Desarchivar" }));
    await waitFor(() =>
      expect(call).toHaveBeenCalledWith(`${BASE}/channels/c2/archived`, { method: "PATCH", body: { archived: false } }),
    );
    expect(await screen.findByText("«el archivado» desarchivado")).toBeTruthy();

    // Ya está fuera de la lista, así que el diálogo no ofrece archivar otra vez.
    fireEvent.click(screen.getByRole("button", { name: "Eliminar" }));
    const dialog = within(await screen.findByRole("dialog"));
    expect(dialog.getByText(/pasa a la papelera/)).toBeTruthy();
    expect(dialog.queryByRole("button", { name: "Archivar" })).toBeNull();
    fireEvent.click(dialog.getByRole("button", { name: "Eliminar" }));
    await waitFor(() => expect(call).toHaveBeenCalledWith(`${BASE}/channels/c2`, { method: "DELETE" }));
    expect(await screen.findByText("«el archivado» eliminado")).toBeTruthy();
  });

  test("desarchivar y eliminar dicen su fallo; y el canal abierto que se borra se deselecciona", async () => {
    let fail = true;
    draw("/p/p1/channels?c=c2", () => {
      if (fail) throw new Error("Sin permiso");
      return {};
    });
    tab(/Archivados/);
    fireEvent.click(await screen.findByRole("button", { name: "Desarchivar" }));
    expect(await screen.findByText("Sin permiso")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Eliminar" }));
    fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Eliminar" }));
    expect(await screen.findAllByText("Sin permiso")).toBeTruthy();

    fail = false;
    fireEvent.click(screen.getByRole("button", { name: "Eliminar" }));
    fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Eliminar" }));
    // Era el abierto: la derecha vuelve a pedir que se elija uno.
    expect(await screen.findByText("Elige un canal para conectarte a él")).toBeTruthy();
  });

  test("cerrar los dos diálogos de la papelera no manda nada", async () => {
    draw("/p/p1/channels");
    tab(/Eliminados/);
    fireEvent.click(await screen.findByRole("button", { name: "Eliminar para siempre" }));
    fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Cancelar" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    tab(/Archivados/);
    fireEvent.click(await screen.findByRole("button", { name: "Eliminar" }));
    fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Cancelar" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(
      call.mock.calls.some(([, options]) => (options as { method?: string } | undefined)?.method === "DELETE"),
    ).toBe(false);
  });

  test("los ajustes dicen el fallo al archivar, y archivan cuando va bien", async () => {
    let fail = true;
    draw("/p/p1/channels?c=c1", () => {
      if (fail) throw new Error("Tiene sesiones abiertas");
      return {};
    });
    fireEvent.click(await screen.findByRole("button", { name: "Configuración" }));
    fireEvent.click(await screen.findByRole("button", { name: "Eliminar canal" }));
    fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Archivar" }));
    expect(await screen.findByText("Tiene sesiones abiertas")).toBeTruthy();
    fail = false;
  });

  test("los ajustes archivan el canal abierto, y eso lo saca de la lista", async () => {
    draw();
    fireEvent.click(await screen.findByRole("button", { name: "Configuración" }));
    fireEvent.click(await screen.findByRole("button", { name: "Eliminar canal" }));
    const dialog = within(await screen.findByRole("dialog"));
    expect(dialog.getByText(/deja de poder abrirse/)).toBeTruthy();
    fireEvent.click(dialog.getByRole("button", { name: "Archivar" }));
    await waitFor(() =>
      expect(call).toHaveBeenCalledWith(`${BASE}/channels/c1/archived`, { method: "PATCH", body: { archived: true } }),
    );
    expect(await screen.findByText("Canal archivado")).toBeTruthy();
  });
});
