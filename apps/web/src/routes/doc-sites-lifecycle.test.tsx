/**
 * El ciclo de vida de una documentación publicada: archivar, restaurar y borrar del todo.
 *
 * Lo que aquí importa: que el filtro pide la lista que dice, que la URL pública deja de ofrecerse
 * en lo que no está vivo, y que restaurar conserva el enlace —el mismo `publicId`— porque esa
 * dirección ya circula por el correo de otro equipo.
 */
import { describe, expect, test, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";

import { DocSitesPage } from "@/routes/doc-sites";
import { ToastProvider } from "@/components/toast";
import type { DocSiteListView, DocSiteView } from "@/lib/types";

const call = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", async (original) => ({ ...(await original<object>()), api: call }));
vi.mock("@/lib/auth", () => ({ useOrganization: () => ({ id: "o", name: "Org" }), useCan: () => true }));

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
  archivedAt: null,
  deletedAt: null,
  ...patch,
});

function draw(mutate: (path: string, options?: { method?: string; body?: unknown }) => unknown = () => undefined) {
  call.mockReset();
  call.mockImplementation((path: string, options?: { method?: string; body?: unknown }) =>
    Promise.resolve().then(() => {
      if (options?.method) return mutate(path, options);
      if (path.startsWith(BASE)) {
        const sites = path.includes("state=deleted")
          ? [site({ id: "d3", name: "la borrada", deletedAt: "2026-03-02T10:00:00.000Z" })]
          : path.includes("state=archived")
            ? [site({ id: "d2", name: "la archivada", archivedAt: "2026-03-02T10:00:00.000Z" })]
            : [site()];
        return { sites, coverage: null, prefix: "/docs" } as unknown as DocSiteListView;
      }
      return { baseUrl: "" };
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

const tab = (name: RegExp) => fireEvent.click(screen.getByRole("tab", { name }));

describe("los tres filtros de la documentación", () => {
  test("cada uno pide su lista, y en femenino: «Archivadas», «Eliminadas»", async () => {
    draw();
    expect(await screen.findByText("la pública")).toBeTruthy();

    tab(/Archivadas/);
    expect(await screen.findByText("la archivada")).toBeTruthy();
    expect(screen.getByText("archivada")).toBeTruthy();
    await waitFor(() => expect(call).toHaveBeenCalledWith(`${BASE}?state=archived`));
    // Publicar y la clave no se ofrecen sobre una página que ya no sirve nada.
    expect(screen.queryByRole("button", { name: "Despublicar" })).toBeNull();

    tab(/Eliminadas/);
    expect(await screen.findByText("la borrada")).toBeTruthy();
    expect(screen.getByText(/^eliminada /)).toBeTruthy();
    await waitFor(() => expect(call).toHaveBeenCalledWith(`${BASE}?state=deleted`));
  });

  test("archivar, desarchivar y el fallo de cualquiera de los dos", async () => {
    let fail = false;
    draw(() => {
      if (fail) throw new Error("Sin permiso");
      return site();
    });
    fireEvent.click(await screen.findByRole("button", { name: "Archivar" }));
    await waitFor(() =>
      expect(call).toHaveBeenCalledWith(`${BASE}/d1/archived`, { method: "PATCH", body: { archived: true } }),
    );
    expect(await screen.findByText("«la pública» archivada")).toBeTruthy();

    tab(/Archivadas/);
    fireEvent.click(await screen.findByRole("button", { name: "Desarchivar" }));
    await waitFor(() =>
      expect(call).toHaveBeenCalledWith(`${BASE}/d2/archived`, { method: "PATCH", body: { archived: false } }),
    );
    expect(await screen.findByText("«la archivada» desarchivada")).toBeTruthy();

    fail = true;
    fireEvent.click(screen.getByRole("button", { name: "Desarchivar" }));
    expect(await screen.findByText("Sin permiso")).toBeTruthy();
  });

  test("el diálogo de borrado ofrece archivar, y eliminar avisa de que la URL deja de contestar", async () => {
    draw();
    fireEvent.click(await screen.findByRole("button", { name: "Eliminar" }));
    const dialog = within(await screen.findByRole("dialog"));
    expect(dialog.getByText(/deja de contestar en el mismo momento/)).toBeTruthy();
    fireEvent.click(dialog.getByRole("button", { name: "Archivar" }));
    await waitFor(() =>
      expect(call).toHaveBeenCalledWith(`${BASE}/d1/archived`, { method: "PATCH", body: { archived: true } }),
    );
  });

  test("eliminar lo dice, y un fallo también", async () => {
    let fail = false;
    draw(() => {
      if (fail) throw new Error("No se pudo");
      return undefined;
    });
    fireEvent.click(await screen.findByRole("button", { name: "Eliminar" }));
    fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Eliminar" }));
    await waitFor(() => expect(call).toHaveBeenCalledWith(`${BASE}/d1`, { method: "DELETE" }));
    expect(await screen.findByText("«la pública» eliminada")).toBeTruthy();

    fail = true;
    fireEvent.click(screen.getByRole("button", { name: "Eliminar" }));
    fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Eliminar" }));
    expect(await screen.findByText("No se pudo")).toBeTruthy();
  });

  test("restaurar desde la papelera, y el definitivo con el nombre escrito", async () => {
    let fail = false;
    draw(() => {
      if (fail) throw new Error("Ya hay una documentación con ese nombre");
      return site();
    });
    tab(/Eliminadas/);
    fireEvent.click(await screen.findByRole("button", { name: "Restaurar" }));
    await waitFor(() => expect(call).toHaveBeenCalledWith(`${BASE}/d3/restore`, { method: "POST" }));
    expect(await screen.findByText("«la borrada» restaurada")).toBeTruthy();

    fail = true;
    fireEvent.click(screen.getByRole("button", { name: "Restaurar" }));
    expect(await screen.findByText("Ya hay una documentación con ese nombre")).toBeTruthy();

    fail = false;
    fireEvent.click(screen.getByRole("button", { name: "Eliminar para siempre" }));
    const dialog = within(await screen.findByRole("dialog"));
    expect(dialog.getByText(/Su URL no se podrá recuperar/)).toBeTruthy();
    fireEvent.change(dialog.getByRole("textbox"), { target: { value: "la borrada" } });
    fireEvent.click(dialog.getByRole("button", { name: "Eliminar para siempre" }));
    await waitFor(() => expect(call).toHaveBeenCalledWith(`${BASE}/d3?purge=true`, { method: "DELETE" }));
    expect(await screen.findByText("«la borrada» eliminada para siempre")).toBeTruthy();
  });
});
