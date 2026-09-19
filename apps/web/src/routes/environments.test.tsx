/**
 * La pantalla de entornos.
 *
 * Lo que decide algo:
 *
 * - **Todo es borrador hasta «Guardar»**, y se guarda en un solo `PATCH` con los dos mapas de
 *   variables; «Descartar» vuelve a lo guardado.
 * - **Una variable con problemas no deja guardar.**
 * - **Borrar pide confirmación nombrando el entorno.**
 * - **Una credencial nunca vuelve**: se listan sus datos, y faltar la de un rol declarado se dice.
 * - **Solo `admin` gestiona credenciales y revela secretos; sin `editor` no se toca nada.**
 */
import { beforeEach, describe, expect, test, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";

import { EnvironmentsPage } from "@/routes/environments";
import { ApiError } from "@/lib/api";
import type { ConfigView, Environment } from "@/lib/types";

const call = vi.hoisted(() => vi.fn());
const can = vi.hoisted(() => ({ editor: true, admin: true }) as Record<string, boolean>);
vi.mock("@/lib/api", async (original) => ({
  ...(await original<object>()),
  api: call,
}));
vi.mock("@/lib/auth", () => ({
  useOrganization: () => ({ id: "o", name: "Org" }),
  useCan: (role: string) => can[role] ?? true,
}));

const environment = (patch: Partial<Environment> = {}): Environment => ({
  id: "e1",
  name: "staging",
  baseUrl: "https://staging.test",
  specUrl: null,
  variables: { userId: { initial: "42", current: "42", sensitive: false } },
  disabledVariables: { legacy: { initial: "7", current: "7", sensitive: false } },
  writesAllowed: false,
  authEnforced: true,
  active: true,
  credentials: [
    {
      id: "c1",
      name: "primary",
      role: "primary",
      kind: "api_key",
      headerName: "X-API-Key",
      updatedAt: "2026-03-01T10:00:00.000Z",
    },
  ],
  ...patch,
});

const config = (roles: string[]): ConfigView => ({
  sections: { access: { data: { access: { roles } }, configured: true, updatedAt: null } },
});

type Handlers = {
  environments?: Environment[];
  roles?: string[];
  write?: (path: string, options: { method: string; body?: unknown }) => Promise<unknown>;
};

function draw(handlers: Handlers = {}) {
  let list = handlers.environments ?? [environment()];
  call.mockImplementation((path: string, options?: { method?: string; body?: unknown }) => {
    if (options?.method) {
      const result = (handlers.write ?? (() => Promise.resolve(undefined)))(path, options as { method: string });
      return result;
    }
    if (path.endsWith("/environments")) return Promise.resolve(list);
    if (path.endsWith("/config")) return Promise.resolve(config(handlers.roles ?? []));
    if (path.endsWith("/variables/reveal")) return Promise.resolve({ userId: "42" });
    return Promise.reject(new Error(`inesperado ${path}`));
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={["/p/p1/settings/environments"]}>
        <Routes>
          <Route path="/p/:projectId/settings/environments" element={<EnvironmentsPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { setList: (next: Environment[]) => (list = next) };
}

const fieldByLabel = (label: string) =>
  screen.getByText(label, { selector: "span" }).closest("label")!.querySelector("input") as HTMLInputElement;
const saveBar = () => screen.getByText("Eliminar entorno").parentElement as HTMLElement;
const saveButton = () => within(saveBar()).getByRole("button", { name: "Guardar" }) as HTMLButtonElement;

const apiError = (detail: string, fields: { field: string; detail: string }[] = []) =>
  new ApiError(422, { type: "about:blank", title: "Unprocessable", status: 422, detail, errors: fields });

beforeEach(() => {
  call.mockReset();
  can.editor = true;
  can.admin = true;
});

describe("EnvironmentsPage", () => {
  test("sin entornos invita a crear uno, y crearlo manda nombre y URL y lo selecciona", async () => {
    const created = environment({ id: "e9", name: "e2e", baseUrl: "https://e2e.test", credentials: [] });
    const { setList } = draw({
      environments: [],
      write: (path, options) => {
        expect(path).toBe("/orgs/o/projects/p1/environments");
        expect(options).toEqual({ method: "POST", body: { name: "e2e", baseUrl: "https://e2e.test" } });
        setList([environment(), created]);
        return Promise.resolve({ environmentId: "e9" });
      },
    });
    expect(await screen.findByText("Sin entornos")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Nuevo entorno" }));

    fireEvent.change(screen.getByPlaceholderText("e2e"), { target: { value: "e2e" } });
    fireEvent.change(screen.getByPlaceholderText("https://api.ejemplo.com"), { target: { value: "https://e2e.test" } });
    fireEvent.click(screen.getByRole("button", { name: "Crear" }));

    await waitFor(() => expect(fieldByLabel("Nombre").value).toBe("e2e"));
    expect(screen.queryByPlaceholderText("https://api.ejemplo.com")).toBeNull();
  });

  test("sin permiso de edición, el vacío no ofrece crear", async () => {
    can.editor = false;
    draw({ environments: [] });
    expect(await screen.findByText("Sin entornos")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Nuevo entorno" })).toBeNull();
  });

  test("un error al crear se enseña junto al formulario, y cancelar lo cierra", async () => {
    draw({
      write: () => Promise.reject(apiError("inválido", [{ field: "baseUrl", detail: "Solo http o https" }])),
    });
    await screen.findByText("Entorno activo");
    fireEvent.click(screen.getByRole("button", { name: "+ Nuevo" }));
    fireEvent.change(screen.getByPlaceholderText("e2e"), { target: { value: "x" } });
    fireEvent.change(screen.getByPlaceholderText("https://api.ejemplo.com"), { target: { value: "ftp://x" } });
    fireEvent.click(screen.getByRole("button", { name: "Crear" }));
    expect(await screen.findByText("Solo http o https")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Cancelar" }));
    expect(screen.queryByPlaceholderText("https://api.ejemplo.com")).toBeNull();
  });

  test("el riel enseña cada entorno con sus variables y cambia la selección", async () => {
    draw({
      environments: [
        environment(),
        environment({ id: "e2", name: "prod", baseUrl: "https://prod.test", active: false, disabledVariables: {}, credentials: [] }),
      ],
    });
    await screen.findByText("Entorno activo");
    expect(screen.getByText(/1 variables · 1 apagadas/)).toBeTruthy();
    expect(screen.getByText("activo")).toBeTruthy();
    // La credencial se lista sin su secreto.
    expect(screen.getByText("X-API-Key")).toBeTruthy();
    expect(screen.getByText("api_key", { selector: "li span" })).toBeTruthy();

    fireEvent.click(screen.getByText("https://prod.test"));
    expect(await screen.findByText("No activo")).toBeTruthy();
    expect(fieldByLabel("Nombre").value).toBe("prod");
    expect(screen.getByText("Ninguna guardada.")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Activar" }));
    await waitFor(() =>
      expect(call).toHaveBeenCalledWith("/orgs/o/projects/p1/environments/e2/activate", { method: "POST" }),
    );
  });

  test("todo es borrador hasta guardar, que manda un único PATCH con los dos mapas", async () => {
    draw();
    await screen.findByText("Entorno activo");
    expect(screen.getByText("Todo guardado")).toBeTruthy();
    expect(saveButton().disabled).toBe(true);

    fireEvent.change(fieldByLabel("Nombre"), { target: { value: "  staging-2 " } });
    fireEvent.change(fieldByLabel("URL del OpenAPI"), { target: { value: "https://staging.test/spec.json" } });
    expect(screen.getByText("solo lectura")).toBeTruthy();
    fireEvent.click(screen.getByText("Permitir escrituras").previousElementSibling as HTMLElement);
    expect(screen.getByText("escrituras permitidas")).toBeTruthy();
    fireEvent.click(screen.getByText("Ejecutar casos de autorización").previousElementSibling as HTMLElement);
    expect(screen.getByText("sin autorización")).toBeTruthy();
    expect(screen.getByText("Cambios sin guardar")).toBeTruthy();

    fireEvent.click(saveButton());
    await waitFor(() =>
      expect(call).toHaveBeenCalledWith("/orgs/o/projects/p1/environments/e1", {
        method: "PATCH",
        body: {
          name: "staging-2",
          baseUrl: "https://staging.test",
          specUrl: "https://staging.test/spec.json",
          writesAllowed: true,
          authEnforced: false,
          variables: { userId: { initial: "42", current: "42", sensitive: false } },
          disabledVariables: { legacy: { initial: "7", current: "7", sensitive: false } },
        },
      }),
    );
  });

  test("descartar vuelve a lo guardado", async () => {
    draw();
    await screen.findByText("Entorno activo");
    fireEvent.change(fieldByLabel("URL base"), { target: { value: "https://otro.test" } });
    expect(screen.getByText("Cambios sin guardar")).toBeTruthy();
    fireEvent.click(within(saveBar()).getByRole("button", { name: "Descartar" }));
    expect(fieldByLabel("URL base").value).toBe("https://staging.test");
    expect(screen.getByText("Todo guardado")).toBeTruthy();
  });

  test("una variable con nombre inválido no deja guardar", async () => {
    draw();
    await screen.findByText("Entorno activo");
    const names = screen.getAllByLabelText("Nombre de variable") as HTMLInputElement[];
    fireEvent.change(names.find((input) => input.value === "userId")!, { target: { value: "1mal" } });
    expect(screen.getByText("Hay variables con problemas")).toBeTruthy();
    expect(saveButton().disabled).toBe(true);
  });

  test("el error del servidor al guardar se enseña con el detalle del campo", async () => {
    draw({ write: () => Promise.reject(apiError("inválido", [{ field: "baseUrl", detail: "La URL no resuelve" }])) });
    await screen.findByText("Entorno activo");
    fireEvent.change(fieldByLabel("URL base"), { target: { value: "https://nada.invalid" } });
    fireEvent.click(saveButton());
    expect(await screen.findByText("La URL no resuelve")).toBeTruthy();
  });

  test("borrar pide confirmación nombrando el entorno y solo entonces borra", async () => {
    draw();
    await screen.findByText("Entorno activo");
    fireEvent.click(screen.getByText("Eliminar entorno"));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/«staging» se elimina con sus variables y sus credenciales/)).toBeTruthy();

    fireEvent.click(within(dialog).getByRole("button", { name: "Cancelar" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(call).not.toHaveBeenCalledWith(expect.anything(), { method: "DELETE" });

    fireEvent.click(screen.getByText("Eliminar entorno"));
    fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Eliminar" }));
    await waitFor(() =>
      expect(call).toHaveBeenCalledWith("/orgs/o/projects/p1/environments/e1", { method: "DELETE" }),
    );
  });

  test("si borrar falla se dice por qué", async () => {
    draw({ write: () => Promise.reject(new Error("tiene monitores")) });
    await screen.findByText("Entorno activo");
    fireEvent.click(screen.getByText("Eliminar entorno"));
    fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Eliminar" }));
    expect(await screen.findByText("tiene monitores")).toBeTruthy();
  });

  test("faltar la credencial de un rol declarado se dice, y se puede guardar para ese rol", async () => {
    draw({ roles: ["vendedor", "primary"] });
    expect(await screen.findByText(/Faltan las de vendedor:/)).toBeTruthy();

    const roleSelect = screen.getByText("Rol", { selector: "label" }).querySelector("select") as HTMLSelectElement;
    await waitFor(() =>
      expect([...roleSelect.options].map((option) => option.value)).toEqual([
        "primary",
        "insufficient",
        "alternate",
        "vendedor",
      ]),
    );
    expect(roleSelect.options[3].textContent).toBe("vendedor · un rol de este proyecto");
    fireEvent.change(roleSelect, { target: { value: "vendedor" } });

    const secret = screen.getByText("Secreto", { selector: "label" }).querySelector("input") as HTMLInputElement;
    fireEvent.change(secret, { target: { value: "tok-123" } });
    const form = secret.closest("form")!;
    fireEvent.submit(form);
    await waitFor(() =>
      expect(call).toHaveBeenCalledWith("/orgs/o/projects/p1/environments/e1/credentials", {
        method: "PUT",
        body: { name: "vendedor", role: "vendedor", kind: "bearer", secret: "tok-123" },
      }),
    );
    await waitFor(() => expect(secret.value).toBe(""));
  });

  test("una api_key pide su cabecera y un error del servidor se enseña", async () => {
    draw({ write: () => Promise.reject(apiError("no", [{ field: "secret", detail: "Demasiado corto" }])) });
    await screen.findByText("Entorno activo");
    const kind = screen.getByText("Tipo", { selector: "label" }).querySelector("select") as HTMLSelectElement;
    fireEvent.change(kind, { target: { value: "api_key" } });
    fireEvent.change(screen.getByPlaceholderText("X-API-Key"), { target: { value: "X-Key" } });
    const secret = screen.getByText("Secreto", { selector: "label" }).querySelector("input") as HTMLInputElement;
    fireEvent.change(secret, { target: { value: "s" } });
    fireEvent.submit(secret.closest("form")!);
    await waitFor(() =>
      expect(call).toHaveBeenCalledWith("/orgs/o/projects/p1/environments/e1/credentials", {
        method: "PUT",
        body: { name: "primary", role: "primary", kind: "api_key", secret: "s", headerName: "X-Key" },
      }),
    );
    expect(await screen.findByText("Demasiado corto")).toBeTruthy();
  });

  test("sin admin no hay formulario de credenciales; sin editor los campos están quietos", async () => {
    can.admin = false;
    can.editor = false;
    draw({ environments: [environment({ active: false })] });
    await screen.findByText("No activo");
    expect(screen.queryByRole("button", { name: "Activar" })).toBeNull();
    expect(screen.queryByText("Secreto")).toBeNull();
    expect(screen.queryByText("Eliminar entorno")).toBeNull();
    expect(screen.queryByRole("button", { name: "+ Nuevo" })).toBeNull();
    expect(fieldByLabel("Nombre").disabled).toBe(true);
  });
});
