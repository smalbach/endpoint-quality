/**
 * La pantalla de mocks: lo que se hace con un mock que ya existe, y lo que manda el formulario.
 *
 * Apagar, rotar la clave y eliminar mandan cada uno su petición y dicen lo que pasó; un fallo se
 * dice con lo que contestó el servidor. El retardo se enseña como se configuró.
 */
import { afterEach, describe, expect, test, vi } from "vitest";
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
const can = vi.hoisted(() => ({ edit: true }));
vi.mock("@/lib/auth", () => ({ useOrganization: () => ({ id: "o", name: "Org" }), useCan: () => can.edit }));

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

type Answer = (path: string, options?: { method?: string; body?: unknown }) => unknown;

function draw(mocks: MockServerView[], mutate: Answer = () => undefined) {
  call.mockReset();
  call.mockImplementation((path: string, options?: { method?: string; body?: unknown }) =>
    Promise.resolve().then(() => {
      if (options?.method) return mutate(path, options);
      if (path.endsWith("/calls")) return { calls: [], keep: 50 };
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

afterEach(() => {
  can.edit = true;
});

describe("un mock que ya existe", () => {
  test("el retardo sale como se configuró: fijo o entre dos valores", async () => {
    draw([
      mock({ id: "a", name: "fijo", delay: { kind: "fixed", ms: 250 } }),
      mock({ id: "b", name: "al azar", delay: { kind: "random", minMs: 100, maxMs: 900 } }),
    ]);
    expect(await screen.findByText(/250 ms · creado/)).toBeTruthy();
    expect(screen.getByText(/100–900 ms · creado/)).toBeTruthy();
  });

  test("apagar y encender mandan lo contrario de lo que hay, y lo dicen", async () => {
    draw([mock(), mock({ id: "m2", name: "el viejo", enabled: false })]);
    expect(await screen.findByText("apagado")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Apagar" }));
    await waitFor(() => expect(call).toHaveBeenCalledWith(`${BASE}/m1`, { method: "PATCH", body: { enabled: false } }));
    expect(await screen.findByText("«el del front» apagado")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Encender" }));
    await waitFor(() => expect(call).toHaveBeenCalledWith(`${BASE}/m2`, { method: "PATCH", body: { enabled: true } }));
    expect(await screen.findByText("«el viejo» encendido")).toBeTruthy();
  });

  test("un fallo al apagar se dice", async () => {
    draw([mock()], () => {
      throw new Error("Sin permiso");
    });
    fireEvent.click(await screen.findByRole("button", { name: "Apagar" }));
    expect(await screen.findByText("Sin permiso")).toBeTruthy();
  });

  test("un privado rota su clave y la nueva se enseña una vez, con su botón de copiar", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    draw([mock({ visibility: "private" })], (path) =>
      path.endsWith("/key") ? { mock: mock({ name: "el privado" }), apiKey: "clave-nueva" } : undefined,
    );
    // Sin resumen de la clave no se inventa uno.
    expect(await screen.findByText(/acaba en …\./)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Nueva clave" }));
    await waitFor(() => expect(call).toHaveBeenCalledWith(`${BASE}/m1/key`, { method: "POST", body: {} }));
    const dialog = within(await screen.findByRole("dialog"));
    expect(dialog.getByText("La clave de «el privado»")).toBeTruthy();
    fireEvent.click(dialog.getByRole("button", { name: "Copiar" }));
    expect(writeText).toHaveBeenCalledWith("clave-nueva");
    fireEvent.click(dialog.getByRole("button", { name: "Ya la he guardado" }));
    await waitFor(() => expect(screen.queryByText("clave-nueva")).toBeNull());
  });

  test("rotar sin clave de vuelta no abre el aviso, y un fallo se dice", async () => {
    let fail = false;
    draw([mock({ visibility: "private", apiKeyPreview: "AbC…xYz" })], () => {
      if (fail) throw new Error("No se pudo rotar");
      return { mock: mock(), apiKey: null };
    });
    fireEvent.click(await screen.findByRole("button", { name: "Nueva clave" }));
    await waitFor(() => expect(call).toHaveBeenCalledWith(`${BASE}/m1/key`, { method: "POST", body: {} }));
    expect(screen.queryByRole("dialog")).toBeNull();

    fail = true;
    fireEvent.click(screen.getByRole("button", { name: "Nueva clave" }));
    expect(await screen.findByText("No se pudo rotar")).toBeTruthy();
  });

  test("copiar la URL la deja en el portapapeles y lo dice", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    draw([mock()]);
    fireEvent.click(await screen.findByRole("button", { name: "Copiar" }));
    expect(writeText).toHaveBeenCalledWith("https://eq.test/api/mock/AbCdEfGhIjKlMnOpQrStUv");
    expect(await screen.findByText("URL copiada")).toBeTruthy();
  });

  test("el panel de llamadas se abre y se vuelve a cerrar", async () => {
    draw([mock()]);
    fireEvent.click(await screen.findByRole("button", { name: "Llamadas" }));
    expect(await screen.findByText(/Las 50 últimas/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Ocultar llamadas" }));
    expect(screen.queryByText(/Las 50 últimas/)).toBeNull();
  });

  test("eliminar: cancelar no borra; confirmar borra y lo dice; un fallo se dice", async () => {
    let fail = false;
    draw([mock()], () => {
      if (fail) throw new Error("No se pudo eliminar");
      return undefined;
    });
    fireEvent.click(await screen.findByRole("button", { name: "Eliminar" }));
    fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Cancelar" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(call.mock.calls.some(([, options]) => options?.method === "DELETE")).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: "Eliminar" }));
    fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Eliminar" }));
    await waitFor(() => expect(call).toHaveBeenCalledWith(`${BASE}/m1`, { method: "DELETE" }));
    expect(await screen.findByText("«el del front» eliminado")).toBeTruthy();
    expect(screen.queryByRole("dialog")).toBeNull();

    fail = true;
    fireEvent.click(screen.getByRole("button", { name: "Eliminar" }));
    fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Eliminar" }));
    expect(await screen.findByText("No se pudo eliminar")).toBeTruthy();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  test("quien solo lee ve los mocks y sus llamadas, sin botones para cambiarlos", async () => {
    can.edit = false;
    draw([mock()]);
    expect(await screen.findByText("el del front")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Llamadas" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Crear un mock" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Apagar" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Eliminar" })).toBeNull();
  });
});

describe("crear", () => {
  const open = async () => {
    fireEvent.click(await screen.findByRole("button", { name: "Crear un mock" }));
    return within(await screen.findByRole("dialog"));
  };

  test("manda el nombre recortado y el retardo fijo; uno público se anuncia sin aviso de clave", async () => {
    let finish: (value: unknown) => void = () => {};
    draw([], () => new Promise((resolve) => (finish = resolve)));
    const dialog = await open();
    fireEvent.change(dialog.getByLabelText(/Nombre/), { target: { value: "  el nuevo  " } });
    fireEvent.click(dialog.getByRole("radio", { name: "Público" }));
    fireEvent.change(dialog.getByLabelText(/Retardo simulado/), { target: { value: "300" } });
    fireEvent.click(dialog.getByRole("button", { name: "Crear" }));

    expect(await dialog.findByRole("button", { name: "Creando…" })).toBeTruthy();
    expect(call).toHaveBeenCalledWith(BASE, {
      method: "POST",
      body: { name: "el nuevo", visibility: "public", delay: { kind: "fixed", ms: 300 } },
    });
    finish({ mock: mock({ name: "el nuevo" }), apiKey: null });
    expect(await screen.findByText("«el nuevo» creado")).toBeTruthy();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  test("un fallo al crear se enseña en el formulario", async () => {
    draw([], () => {
      throw new Error("Ese nombre ya existe");
    });
    const dialog = await open();
    fireEvent.change(dialog.getByLabelText(/Nombre/), { target: { value: "repetido" } });
    fireEvent.click(dialog.getByRole("radio", { name: "Privado" }));
    fireEvent.click(dialog.getByRole("button", { name: "Crear" }));
    expect(await dialog.findByText("Ese nombre ya existe")).toBeTruthy();
    // Sin retardo escrito no se manda ninguno.
    expect(call).toHaveBeenCalledWith(BASE, { method: "POST", body: { name: "repetido", visibility: "private" } });
  });

  test("cancelar cierra sin mandar nada", async () => {
    draw([]);
    const dialog = await open();
    fireEvent.click(dialog.getByRole("button", { name: "Cancelar" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(call.mock.calls.some(([, options]) => options?.method)).toBe(false);
  });
});
