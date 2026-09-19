/**
 * «Contrato y configuración»: importar el contrato y editar sus secciones.
 *
 * Lo que decide algo:
 *
 * - **Volver a leer de la última URL no manda `source`**: el servidor reutiliza la credencial que
 *   guardó, y no hace falta reescribirla.
 * - **La cabecera Authorization solo viaja si se escribió.**
 * - **El grupo avanzado empieza plegado** mientras nada dentro esté configurado.
 * - **Formulario y JSON son la misma sección**: pasar a JSON enseña lo que construyó el formulario,
 *   y volver solo funciona desde un JSON que se lee.
 * - **«Guardar» solo con cambios; «Volver a los valores por defecto» solo si está configurada.**
 */
import { describe, expect, test, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";

import { ConfigPage } from "@/routes/config";
import { ApiError } from "@/lib/api";
import { SECTION_GUIDE } from "@/lib/config-sections";
import type { ConfigView, ProjectSummary } from "@/lib/types";

const call = vi.hoisted(() => vi.fn());
const can = vi.hoisted(() => ({ value: true }));
vi.mock("@/lib/api", async (original) => ({ ...(await original<object>()), api: call }));
vi.mock("@/lib/auth", () => ({
  useOrganization: () => ({ id: "o", name: "Org", role: "owner" }),
  useCan: () => can.value,
}));
// Traer piezas de otro proyecto tiene sus propias pruebas; aquí solo importa que está al lado.
vi.mock("@/components/import-elements", () => ({ ImportElements: () => <p>Traer elementos</p> }));

const BASE = "/orgs/o/projects/p1";

const config = (over: Partial<ConfigView["sections"]> = {}): ConfigView => ({
  sections: {
    parameters: { data: {}, configured: false, updatedAt: null },
    bodies: { data: { createOrder: { name: "x" } }, configured: true, updatedAt: "2026-03-01T10:00:00.000Z" },
    implemented: { data: {}, configured: false, updatedAt: null },
    authorization: { data: {}, configured: false, updatedAt: null },
    budgets: { data: { budgets: [] }, configured: false, updatedAt: null },
    envelope: { data: {}, configured: false, updatedAt: null },
    labels: { data: {}, configured: false, updatedAt: null },
    scenarios: { data: {}, configured: false, updatedAt: null },
    text: { data: {}, configured: false, updatedAt: null },
    ...over,
  },
});

const project = (over: Partial<ProjectSummary> = {}) =>
  ({
    id: "p1",
    name: "Tienda",
    contract: { versionId: "v3", title: "Tienda API", version: "3.1", operationCount: 7, importedAt: "2026-02-01T00:00:00.000Z" },
    source: { kind: "url", location: "https://tienda.test/openapi.json", headersStored: true },
    ...over,
  }) as ProjectSummary;

type Mutate = (path: string, options: { method: string; body?: unknown }) => Promise<unknown>;

function draw(options: { project?: ProjectSummary; config?: ConfigView; mutate?: Mutate; canEdit?: boolean } = {}) {
  can.value = options.canEdit ?? true;
  call.mockReset();
  call.mockImplementation((path: string, request?: { method: string; body?: unknown }) => {
    if (request?.method) return (options.mutate ?? (() => Promise.resolve(undefined)))(path, request);
    if (path === BASE) return Promise.resolve(options.project ?? project());
    if (path === `${BASE}/config`) return Promise.resolve(options.config ?? config());
    if (path === `${BASE}/operations`) return Promise.resolve({ operations: [{ id: "createOrder" }, { id: "listOrders" }] });
    return new Promise(() => {});
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={["/p/p1/settings/contract"]}>
        <Routes>
          <Route path="/p/:projectId/settings/contract" element={<ConfigPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const card = (title: string) => screen.getByText(title).closest("div.overflow-hidden") as HTMLElement;

describe("ConfigPage: el contrato", () => {
  test("enseña el contrato y vuelve a leerlo de la última URL sin mandar la fuente", async () => {
    draw({ mutate: () => Promise.resolve({ operationCount: 7, unchanged: true }) });
    expect(await screen.findByText(/Tienda API/)).toBeTruthy();
    expect(screen.getByText(/7 operaciones/)).toBeTruthy();
    expect(screen.getByText("https://tienda.test/openapi.json")).toBeTruthy();
    expect(screen.getByText(/con una credencial guardada/)).toBeTruthy();
    expect(screen.getByRole("link", { name: "Roles" }).getAttribute("href")).toBe("/p/p1/roles");

    fireEvent.click(screen.getByRole("button", { name: "Volver a leerlo de ahí" }));
    await waitFor(() => expect(call).toHaveBeenCalledWith(`${BASE}/spec-versions`, { method: "POST", body: {} }));
    expect(await screen.findByText(/El documento no ha cambiado/)).toBeTruthy();
    // El checklist de `implemented` sale de las operaciones del contrato.
    expect(call).toHaveBeenCalledWith(`${BASE}/operations`);
  });

  test("desde una URL, la cabecera solo viaja si se escribió", async () => {
    draw({ project: project({ contract: null, source: null }), mutate: () => Promise.resolve({ operationCount: 12, unchanged: false }) });
    expect(await screen.findByText("Todavía no hay contrato. Sin él no hay matriz.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Volver a leerlo de ahí" })).toBeNull();
    const fromUrl = screen.getByRole("button", { name: "Importar desde la URL" }) as HTMLButtonElement;
    expect(fromUrl.disabled).toBe(true);

    fireEvent.change(screen.getByPlaceholderText("https://api.example.com/openapi.json"), {
      target: { value: "https://x.test/spec.yaml" },
    });
    fireEvent.click(fromUrl);
    await waitFor(() =>
      expect(call).toHaveBeenCalledWith(`${BASE}/spec-versions`, {
        method: "POST",
        body: { source: { kind: "url", url: "https://x.test/spec.yaml" } },
      }),
    );
    expect(await screen.findByText("Importadas 12 operaciones.")).toBeTruthy();

    fireEvent.change(screen.getByPlaceholderText("Bearer …"), { target: { value: "  Bearer abc  " } });
    fireEvent.click(fromUrl);
    await waitFor(() =>
      expect(call).toHaveBeenCalledWith(`${BASE}/spec-versions`, {
        method: "POST",
        body: { source: { kind: "url", url: "https://x.test/spec.yaml", headers: { Authorization: "Bearer abc" } } },
      }),
    );
    // Importado, la credencial escrita se borra de la caja.
    await waitFor(() => expect((screen.getByPlaceholderText("Bearer …") as HTMLInputElement).value).toBe(""));
  });

  test("pegando el documento; un rechazo nombra los campos", async () => {
    draw({
      project: project({ source: null }),
      mutate: () =>
        Promise.reject(
          new ApiError(422, {
            type: "",
            title: "",
            status: 422,
            detail: "El documento no es OpenAPI",
            errors: [{ field: "paths", detail: "falta" }],
          }),
        ),
    });
    await screen.findByText(/Tienda API/);
    const importButton = screen.getByRole("button", { name: "Importar" }) as HTMLButtonElement;
    expect(importButton.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText(/Pegando el documento/), { target: { value: "openapi: 3.0.0" } });
    fireEvent.click(importButton);
    await waitFor(() =>
      expect(call).toHaveBeenCalledWith(`${BASE}/spec-versions`, {
        method: "POST",
        body: { source: { kind: "inline", raw: "openapi: 3.0.0" } },
      }),
    );
    expect(await screen.findByText("El documento no es OpenAPI")).toBeTruthy();
    expect(screen.getByText("paths: falta")).toBeTruthy();
  });

  test("sin permiso de edición nada se puede importar ni guardar", async () => {
    draw({ canEdit: false });
    await screen.findByText(/Tienda API/);
    expect((screen.getByRole("button", { name: "Volver a leerlo de ahí" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByPlaceholderText("https://api.example.com/openapi.json") as HTMLInputElement).disabled).toBe(true);
  });
});

describe("ConfigPage: las secciones", () => {
  test("agrupa las secciones y pliega el grupo avanzado mientras nada dentro esté configurado", async () => {
    draw();
    expect(await screen.findByText("Datos de la corrida")).toBeTruthy();
    expect(screen.getByText("Cuándo un caso es rojo")).toBeTruthy();
    expect(screen.queryByText(SECTION_GUIDE.labels!.title)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Mostrar las 3" }));
    expect(screen.getByText(SECTION_GUIDE.labels!.title)).toBeTruthy();
  });

  test("con una sección avanzada configurada, el grupo ya sale abierto", async () => {
    draw({ config: config({ text: { data: { a: 1 }, configured: true, updatedAt: null } }) });
    expect(await screen.findByText(SECTION_GUIDE.text!.title)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Mostrar las/ })).toBeNull();
  });

  test("una sección sin editor se edita como JSON; un JSON roto no se guarda", async () => {
    let saved: unknown;
    draw({
      mutate: (_path, options) => {
        saved = options.body;
        return Promise.resolve(undefined);
      },
    });
    await screen.findByText("Datos de la corrida");
    const bodies = card(SECTION_GUIDE.bodies!.title);
    expect(within(bodies).getByText("configurada")).toBeTruthy();
    fireEvent.click(within(bodies).getByText(SECTION_GUIDE.bodies!.title));
    expect(within(bodies).queryByRole("button", { name: /Ver como/ })).toBeNull();
    const save = within(bodies).getByRole("button", { name: "Guardar" }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);

    const textarea = bodies.querySelector("textarea")!;
    fireEvent.change(textarea, { target: { value: "{ roto" } });
    fireEvent.click(save);
    expect(bodies.querySelector("p.text-rose-700")?.textContent).toMatch(/JSON/);
    expect(call).not.toHaveBeenCalledWith(`${BASE}/config/bodies`, expect.anything());

    fireEvent.change(textarea, { target: { value: '{ "listOrders": {} }' } });
    fireEvent.click(save);
    await waitFor(() =>
      expect(call).toHaveBeenCalledWith(`${BASE}/config/bodies`, { method: "PUT", body: { listOrders: {} } }),
    );
    expect(saved).toEqual({ listOrders: {} });

    fireEvent.click(within(bodies).getByRole("button", { name: "Volver a los valores por defecto" }));
    await waitFor(() => expect(call).toHaveBeenCalledWith(`${BASE}/config/bodies`, { method: "DELETE" }));
  });

  test("formulario y JSON son la misma sección, y guardar manda lo que construyó el formulario", async () => {
    draw({
      mutate: () =>
        Promise.reject(
          new ApiError(422, {
            type: "",
            title: "",
            status: 422,
            detail: "Sección inválida",
            errors: [{ field: "budgets[0].thresholdMs", detail: "demasiado bajo" }],
          }),
        ),
    });
    await screen.findByText("Cuándo un caso es rojo");
    const budgets = card(SECTION_GUIDE.budgets!.title);
    expect(within(budgets).getByText("por defecto")).toBeTruthy();
    fireEvent.click(within(budgets).getByText(SECTION_GUIDE.budgets!.title));
    expect(within(budgets).queryByRole("button", { name: "Volver a los valores por defecto" })).toBeNull();

    fireEvent.click(within(budgets).getByRole("button", { name: "Añadir presupuesto" }));
    fireEvent.click(within(budgets).getByRole("button", { name: "Ver como JSON" }));
    const textarea = budgets.querySelector("textarea")!;
    expect(JSON.parse(textarea.value)).toEqual({
      budgets: [expect.objectContaining({ thresholdMs: 500, label: "Presupuesto", source: "manual" })],
    });

    // Volver al formulario desde un JSON roto no se puede.
    fireEvent.change(textarea, { target: { value: "{" } });
    fireEvent.click(within(budgets).getByRole("button", { name: "Ver como formulario" }));
    expect(budgets.querySelector("textarea")).toBeTruthy();
    fireEvent.change(textarea, {
      target: { value: JSON.stringify({ budgets: [{ id: "b", thresholdMs: 5, label: "Rápido", source: "manual" }] }) },
    });
    fireEvent.click(within(budgets).getByRole("button", { name: "Ver como formulario" }));
    expect(budgets.querySelector("textarea")).toBeNull();
    expect(within(budgets).getByDisplayValue("Rápido")).toBeTruthy();

    fireEvent.click(within(budgets).getByRole("button", { name: "Guardar" }));
    await waitFor(() =>
      expect(call).toHaveBeenCalledWith(`${BASE}/config/budgets`, {
        method: "PUT",
        body: { budgets: [{ id: "b", thresholdMs: 5, label: "Rápido", source: "manual" }] },
      }),
    );
    expect(await within(budgets).findByText("Sección inválida")).toBeTruthy();
    expect(within(budgets).getByText("budgets[0].thresholdMs: demasiado bajo")).toBeTruthy();

    // Plegar la sección.
    fireEvent.click(within(budgets).getByText(SECTION_GUIDE.budgets!.title));
    expect(within(budgets).queryByRole("button", { name: "Guardar" })).toBeNull();
  });
});
