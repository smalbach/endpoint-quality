/**
 * Ajustes generales de un proyecto: el formulario, archivar y eliminar.
 *
 * Lo que decide algo:
 *
 * - **«Guardar» solo se activa si hay algo distinto** de lo guardado, y manda el formulario entero
 *   con la autenticación (los secretos como la máscara, que es «sin cambios»).
 * - **Archivar pide confirmación; restaurar no**, porque restaurar no quita nada de la vista.
 * - **Eliminar pide escribir el nombre** y, hecho, lleva a la lista de proyectos.
 * - **Un proyecto archivado no deja editar**, y quien no es admin no ve archivar ni eliminar.
 */
import { describe, expect, test, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";

import { ProjectGeneralPage, ProjectSettingsLayout, settingsTabs } from "@/routes/project-settings";
import { ToastProvider } from "@/components/toast";
import { ApiError } from "@/lib/api";
import { EMPTY_AUTH, MASK } from "@/lib/project-auth";
import type { ProjectSummary, Role } from "@/lib/types";

const call = vi.hoisted(() => vi.fn());
const session = vi.hoisted(() => ({ role: "admin" as string }));
vi.mock("@/lib/api", async (original) => ({ ...(await original<object>()), api: call }));
vi.mock("@/lib/auth", async () => {
  const { atLeast } = await import("@/lib/roles");
  return {
    useOrganization: () => ({ id: "o", name: "Org", role: session.role }),
    useCan: (needed: Role) => atLeast(session.role as Role, needed),
  };
});

const project = (over: Partial<ProjectSummary> = {}): ProjectSummary => ({
  id: "p1",
  name: "Tienda",
  slug: "tienda",
  description: "API de la tienda",
  archivedAt: null,
  baseUrl: "https://api.tienda.test",
  activeEnvironmentId: null,
  tags: ["prod"],
  auth: { ...EMPTY_AUTH, type: "bearer", token: MASK },
  lastRun: null,
  contract: { versionId: "v", title: "Tienda API", version: "2.0", operationCount: 3, importedAt: "2026-01-01T00:00:00.000Z" },
  source: null,
  fork: null,
  ...over,
});

type Mutate = (path: string, options: { method: string; body?: unknown }) => Promise<unknown>;

function draw(role: Role, data: ProjectSummary, mutate: Mutate = () => Promise.resolve(undefined)) {
  session.role = role;
  call.mockReset();
  call.mockImplementation((path: string, options?: { method: string; body?: unknown }) =>
    options?.method ? mutate(path, options) : Promise.resolve(data),
  );
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <ToastProvider>
        <MemoryRouter initialEntries={["/p/p1/settings"]}>
          <Routes>
            <Route path="/p/:projectId/settings" element={<ProjectSettingsLayout />}>
              <Route index element={<ProjectGeneralPage />} />
            </Route>
            <Route path="/projects" element={<p>Lista de proyectos</p>} />
          </Routes>
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

const saveButton = () => screen.getByRole("button", { name: "Guardar settings" }) as HTMLButtonElement;

describe("settingsTabs", () => {
  test("sin proyecto no hay pestañas; con él, cuatro rutas absolutas", () => {
    expect(settingsTabs(undefined)).toEqual([]);
    expect(settingsTabs("p1").map((tab) => tab.to)).toEqual([
      "/p/p1/settings",
      "/p/p1/settings/contract",
      "/p/p1/settings/environments",
      "/p/p1/settings/transfer",
    ]);
  });
});

describe("ProjectGeneralPage", () => {
  test("rellena el formulario, solo guarda si cambia algo y manda el formulario entero", async () => {
    draw("admin", project());
    expect(screen.getByText("Cargando…")).toBeTruthy();
    expect(screen.getByRole("link", { name: "General" })).toBeTruthy();
    const name = (await screen.findByDisplayValue("Tienda")) as HTMLInputElement;
    expect(screen.getByText("Tienda API v2.0", { exact: false })).toBeTruthy();
    expect(saveButton().disabled).toBe(true);

    fireEvent.change(name, { target: { value: "Tienda 2" } });
    fireEvent.change(screen.getByPlaceholderText("produccion, v2, interno"), { target: { value: "prod, beta" } });
    expect(saveButton().disabled).toBe(false);
    fireEvent.click(saveButton());
    await waitFor(() =>
      expect(call).toHaveBeenCalledWith("/orgs/o/projects/p1", {
        method: "PATCH",
        body: {
          name: "Tienda 2",
          description: "API de la tienda",
          baseUrl: "https://api.tienda.test",
          tags: ["prod", "beta"],
          auth: { type: "bearer", token: MASK, loginUrl: "", loginMethod: "POST", loginBody: "", tokenPath: "" },
        },
      }),
    );
    expect(await screen.findByText("Settings guardados")).toBeTruthy();
  });

  test("un error por campo va junto al campo; uno general, debajo del formulario", async () => {
    let attempt = 0;
    draw("editor", project({ contract: null }), () => {
      attempt += 1;
      return Promise.reject(
        attempt === 1
          ? new ApiError(422, {
              type: "",
              title: "",
              status: 422,
              detail: "Inválido",
              errors: [{ field: "baseUrl", detail: "No es una URL" }],
            })
          : new Error("Sin conexión"),
      );
    });
    expect(await screen.findByText("sin importar")).toBeTruthy();
    // Un editor edita pero no archiva ni elimina.
    expect(screen.queryByRole("button", { name: "Archivar" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Eliminar" })).toBeNull();

    fireEvent.change(screen.getByPlaceholderText("https://api.example.com"), { target: { value: "nada" } });
    fireEvent.click(saveButton());
    expect(await screen.findByText("No es una URL")).toBeTruthy();
    expect(screen.queryByText("Inválido")).toBeNull();
    fireEvent.click(saveButton());
    expect(await screen.findByText("Sin conexión")).toBeTruthy();
  });

  test("una autenticación incompleta no deja guardar", async () => {
    draw("admin", project());
    await screen.findByDisplayValue("Tienda");
    fireEvent.change(screen.getByLabelText(/^Tipo/), { target: { value: "api_key" } });
    expect(await screen.findByText("Falta la clave")).toBeTruthy();
    expect(saveButton().disabled).toBe(true);
  });

  test("archivar pide confirmación y lo dice al terminar", async () => {
    draw("admin", project());
    fireEvent.click(await screen.findByRole("button", { name: "Archivar" }));
    expect(screen.getByText(/«Tienda» dejará de aparecer/)).toBeTruthy();
    expect(call).not.toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ method: "PATCH" }));
    const buttons = screen.getAllByRole("button", { name: "Archivar" });
    fireEvent.click(buttons[buttons.length - 1]!);
    await waitFor(() =>
      expect(call).toHaveBeenCalledWith("/orgs/o/projects/p1/archived", { method: "PATCH", body: { archived: true } }),
    );
    expect(await screen.findByText("Proyecto archivado")).toBeTruthy();
  });

  test("un archivado no deja editar y se restaura sin confirmación; un fallo se dice", async () => {
    draw("admin", project({ archivedAt: "2026-02-01T00:00:00.000Z" }), () => Promise.reject(new Error("No se pudo")));
    expect(await screen.findByText(/Restáuralo para cambiar sus ajustes/)).toBeTruthy();
    expect((screen.getByDisplayValue("Tienda") as HTMLInputElement).disabled).toBe(true);
    expect(screen.queryByRole("button", { name: "Guardar settings" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Restaurar" }));
    await waitFor(() =>
      expect(call).toHaveBeenCalledWith("/orgs/o/projects/p1/archived", { method: "PATCH", body: { archived: false } }),
    );
    expect(await screen.findByText("No se pudo")).toBeTruthy();
  });

  test("eliminar pide escribir el nombre y lleva a la lista de proyectos", async () => {
    draw("admin", project());
    fireEvent.click(await screen.findByRole("button", { name: "Eliminar" }));
    const confirm = screen.getByRole("button", { name: "Eliminar para siempre" }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText(/Escribe «Tienda» para confirmar/), { target: { value: "Tiend" } });
    expect(confirm.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText(/Escribe «Tienda» para confirmar/), { target: { value: "Tienda" } });
    fireEvent.click(confirm);
    await waitFor(() => expect(call).toHaveBeenCalledWith("/orgs/o/projects/p1", { method: "DELETE" }));
    expect(await screen.findByText("Lista de proyectos")).toBeTruthy();
  });

  test("un fallo al eliminar se enseña en el diálogo, y cancelar lo cierra", async () => {
    draw("admin", project(), () => Promise.reject(new Error("Tiene corridas en curso")));
    fireEvent.click(await screen.findByRole("button", { name: "Eliminar" }));
    fireEvent.change(screen.getByLabelText(/Escribe «Tienda» para confirmar/), { target: { value: "Tienda" } });
    fireEvent.click(screen.getByRole("button", { name: "Eliminar para siempre" }));
    expect(await screen.findByText("Tiene corridas en curso")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Cancelar" }));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Eliminar para siempre" })).toBeNull());
  });

  test("un lector ve los ajustes sin poder tocarlos", async () => {
    draw("viewer", project());
    expect(((await screen.findByDisplayValue("Tienda")) as HTMLInputElement).disabled).toBe(true);
    expect(screen.queryByRole("button", { name: "Guardar settings" })).toBeNull();
  });
});
