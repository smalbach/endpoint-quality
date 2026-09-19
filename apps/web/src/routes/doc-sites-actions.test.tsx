/**
 * La pantalla de documentación publicada: lo que se hace con una página que ya existe.
 *
 * Despublicar, quitar los ejemplos, rotar la clave y eliminar mandan cada uno su petición y dicen
 * lo que pasó; un fallo se dice con lo que contestó el servidor. Y el formulario de publicar manda
 * exactamente lo que se escribió en él.
 */
import { afterEach, describe, expect, test, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";

import { DocSitesPage } from "@/routes/doc-sites";
import { ToastProvider } from "@/components/toast";
import type { DocSiteListView, DocSiteView } from "@/lib/types";

const call = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", async (original) => ({
  ...(await original<object>()),
  api: call,
}));
const can = vi.hoisted(() => ({ edit: true }));
vi.mock("@/lib/auth", () => ({ useOrganization: () => ({ id: "o", name: "Org" }), useCan: () => can.edit }));

const BASE = "/orgs/o/projects/p1/doc-sites";

const site = (patch: Partial<DocSiteView> = {}): DocSiteView => ({
  id: "d1",
  name: "la pública",
  publicId: "AbCdEfGhIjKlMnOpQrStUv",
  visibility: "public",
  apiKeyPreview: "",
  baseUrl: "https://api.ejemplo.com",
  intro: "",
  includeExamples: false,
  enabled: true,
  createdAt: "2026-03-01T10:00:00.000Z",
  updatedAt: "2026-03-01T10:00:00.000Z",
  createdBy: "u1",
  ...patch,
});

type Answer = (path: string, options?: { method?: string; body?: unknown }) => unknown;

function draw(sites: DocSiteView[], mutate: Answer = () => undefined, project: Answer = () => ({ baseUrl: "" })) {
  call.mockReset();
  call.mockImplementation((path: string, options?: { method?: string; body?: unknown }) =>
    Promise.resolve().then(() => {
      if (options?.method) return mutate(path, options);
      if (path === BASE) return { sites, coverage: null, prefix: "/docs" } as unknown as DocSiteListView;
      return project(path, options);
    }),
  );
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <ToastProvider>
        <MemoryRouter initialEntries={["/p/p1/doc-sites"]}>
          <Routes>
            <Route path="/p/:projectId/doc-sites" element={<DocSitesPage />} />
          </Routes>
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  can.edit = true;
});

describe("una página publicada", () => {
  test("despublicar y quitar los ejemplos mandan lo contrario de lo que hay, y lo dicen", async () => {
    draw([site({ includeExamples: true })]);
    expect(await screen.findByText("con ejemplos")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Despublicar" }));
    await waitFor(() => expect(call).toHaveBeenCalledWith(`${BASE}/d1`, { method: "PATCH", body: { enabled: false } }));
    expect(await screen.findByText("«la pública» despublicada")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Quitar los ejemplos" }));
    await waitFor(() =>
      expect(call).toHaveBeenCalledWith(`${BASE}/d1`, { method: "PATCH", body: { includeExamples: false } }),
    );
    expect(await screen.findByText("Los ejemplos ya no salen")).toBeTruthy();
  });

  test("una despublicada se vuelve a publicar, y los ejemplos se incluyen", async () => {
    draw([site({ enabled: false })]);
    expect(await screen.findByText("despublicada")).toBeTruthy();

    // El primero es el de la cabecera, que crea otra; el de la tarjeta vuelve a publicar esta.
    fireEvent.click(screen.getAllByRole("button", { name: "Publicar" })[1]!);
    await waitFor(() => expect(call).toHaveBeenCalledWith(`${BASE}/d1`, { method: "PATCH", body: { enabled: true } }));
    expect(await screen.findByText("«la pública» publicada")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Incluir los ejemplos" }));
    await waitFor(() =>
      expect(call).toHaveBeenCalledWith(`${BASE}/d1`, { method: "PATCH", body: { includeExamples: true } }),
    );
    expect(await screen.findByText("Los ejemplos salen en la página")).toBeTruthy();
  });

  test("los fallos de despublicar y de los ejemplos se dicen", async () => {
    draw([site()], () => {
      throw new Error("Sin permiso");
    });
    fireEvent.click(await screen.findByRole("button", { name: "Despublicar" }));
    expect(await screen.findByText("Sin permiso")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Incluir los ejemplos" }));
    await waitFor(() => expect(screen.getAllByText("Sin permiso").length).toBe(2));
  });

  test("una privada rota su clave y la nueva se enseña una vez, con su botón de copiar", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    draw([site({ visibility: "private", apiKeyPreview: "" })], (path) =>
      path.endsWith("/key") ? { site: site({ name: "la privada" }), apiKey: "clave-nueva" } : undefined,
    );
    // Sin resumen de la clave no se inventa uno.
    expect(await screen.findByText(/acaba en …\./)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Nueva clave" }));
    await waitFor(() => expect(call).toHaveBeenCalledWith(`${BASE}/d1/key`, { method: "POST", body: {} }));
    const dialog = within(await screen.findByRole("dialog"));
    expect(dialog.getByText("La clave de «la privada»")).toBeTruthy();
    fireEvent.click(dialog.getByRole("button", { name: "Copiar" }));
    expect(writeText).toHaveBeenCalledWith("clave-nueva");

    fireEvent.click(dialog.getByRole("button", { name: "Ya la he guardado" }));
    await waitFor(() => expect(screen.queryByText("clave-nueva")).toBeNull());
  });

  test("rotar sin clave de vuelta no abre el aviso, y un fallo se dice", async () => {
    let fail = false;
    draw([site({ visibility: "private", apiKeyPreview: "AbC…xYz" })], () => {
      if (fail) throw new Error("No se pudo rotar");
      return { site: site(), apiKey: null };
    });
    fireEvent.click(await screen.findByRole("button", { name: "Nueva clave" }));
    await waitFor(() => expect(call).toHaveBeenCalledWith(`${BASE}/d1/key`, { method: "POST", body: {} }));
    expect(screen.queryByRole("dialog")).toBeNull();

    fail = true;
    fireEvent.click(screen.getByRole("button", { name: "Nueva clave" }));
    expect(await screen.findByText("No se pudo rotar")).toBeTruthy();
  });

  test("copiar la URL la deja en el portapapeles y lo dice", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    draw([site()]);
    fireEvent.click(await screen.findByRole("button", { name: "Copiar" }));
    expect(writeText).toHaveBeenCalledWith(`${window.location.origin}/docs/AbCdEfGhIjKlMnOpQrStUv`);
    expect(await screen.findByText("URL copiada")).toBeTruthy();
  });

  test("eliminar: cancelar no borra; confirmar borra y lo dice; un fallo se dice", async () => {
    let fail = false;
    draw([site()], () => {
      if (fail) throw new Error("No se pudo eliminar");
      return undefined;
    });
    fireEvent.click(await screen.findByRole("button", { name: "Eliminar" }));
    fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Cancelar" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(call.mock.calls.some(([, options]) => options?.method === "DELETE")).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: "Eliminar" }));
    fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Eliminar" }));
    await waitFor(() => expect(call).toHaveBeenCalledWith(`${BASE}/d1`, { method: "DELETE" }));
    expect(await screen.findByText("«la pública» eliminada")).toBeTruthy();
    expect(screen.queryByRole("dialog")).toBeNull();

    fail = true;
    fireEvent.click(screen.getByRole("button", { name: "Eliminar" }));
    fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Eliminar" }));
    expect(await screen.findByText("No se pudo eliminar")).toBeTruthy();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  test("quien solo lee ve las páginas sin botones para cambiarlas", async () => {
    can.edit = false;
    draw([site()]);
    expect(await screen.findByText("la pública")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Publicar" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Despublicar" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Eliminar" })).toBeNull();
  });
});

describe("publicar", () => {
  const open = async () => {
    fireEvent.click(await screen.findByRole("button", { name: "Publicar" }));
    return within(await screen.findByRole("dialog"));
  };

  test("manda lo escrito, recortado, y una pública se anuncia sin aviso de clave", async () => {
    let finish: (value: unknown) => void = () => {};
    draw([], () => new Promise((resolve) => (finish = resolve)));
    const dialog = await open();
    fireEvent.change(dialog.getByLabelText(/Nombre/), { target: { value: "  la nueva  " } });
    fireEvent.click(dialog.getByRole("radio", { name: "Pública" }));
    fireEvent.change(dialog.getByLabelText(/URL base/), { target: { value: " https://api.x.com " } });
    fireEvent.change(dialog.getByLabelText(/Introducción/), { target: { value: " Para pagos " } });
    fireEvent.click(dialog.getByLabelText("Incluir los cuerpos de ejemplo"));
    fireEvent.click(dialog.getByRole("button", { name: "Publicar" }));

    expect(await dialog.findByRole("button", { name: "Publicando…" })).toBeTruthy();
    expect(call).toHaveBeenCalledWith(BASE, {
      method: "POST",
      body: {
        name: "la nueva",
        visibility: "public",
        baseUrl: "https://api.x.com",
        intro: "Para pagos",
        includeExamples: true,
      },
    });
    finish({ site: site({ name: "la nueva" }), apiKey: null });
    expect(await screen.findByText("«la nueva» publicada")).toBeTruthy();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  test("un fallo al publicar se enseña en el formulario", async () => {
    draw([], () => {
      throw new Error("Ese nombre ya existe");
    });
    const dialog = await open();
    fireEvent.change(dialog.getByLabelText(/Nombre/), { target: { value: "repetida" } });
    fireEvent.click(dialog.getByRole("radio", { name: "Privada" }));
    fireEvent.click(dialog.getByRole("button", { name: "Publicar" }));
    expect(await dialog.findByText("Ese nombre ya existe")).toBeTruthy();
  });

  test("cancelar cierra sin mandar nada; sin proyecto legible no se ofrece su URL base", async () => {
    draw([], undefined, () => {
      throw new Error("No se pudo leer el proyecto");
    });
    await waitFor(() => expect(call).toHaveBeenCalledWith("/orgs/o/projects/p1"));
    const dialog = await open();
    expect(dialog.queryByText(/Usar la del proyecto/)).toBeNull();
    fireEvent.click(dialog.getByRole("button", { name: "Cancelar" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(call.mock.calls.some(([, options]) => options?.method)).toBe(false);
  });
});
