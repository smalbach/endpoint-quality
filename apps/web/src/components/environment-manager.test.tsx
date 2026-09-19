/**
 * El gestor de entornos que se abre desde la barra.
 *
 * Lo que se comprueba: la lista (activo, activar, crear, eliminar con confirmación) y la vista de un
 * entorno, que guarda nombre, URL y variables en un solo PATCH con las apagadas **aparte**, que no
 * deja guardar sin cambios o con una variable mal nombrada, que descartar vuelve a lo guardado, y
 * que lo que no puede un lector (editar, crear, eliminar, ver secretos) ni se le ofrece.
 */
import { beforeEach, describe, expect, test, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";

import { EnvironmentManager } from "@/components/environment-manager";
import { ToastProvider } from "@/components/toast";
import { ApiError } from "@/lib/api";
import type { Environment } from "@/lib/types";

const call = vi.hoisted(() => vi.fn());
const role = vi.hoisted(() => ({ current: "admin" as "admin" | "editor" | "viewer" }));
vi.mock("@/lib/api", async (original) => ({ ...(await original<object>()), api: call }));
vi.mock("@/lib/auth", () => {
  const rank = { viewer: 0, editor: 1, admin: 2 } as const;
  return {
    useOrganization: () => ({ id: "o", name: "Org" }),
    useCan: (needed: keyof typeof rank) => rank[role.current] >= rank[needed],
  };
});

const BASE = "/orgs/o/projects/p";

const environment = (id: string, name: string, active: boolean): Environment => ({
  id,
  name,
  baseUrl: `https://${name}.example.com`,
  specUrl: null,
  variables: { userId: { initial: "42", current: "42", sensitive: false } },
  disabledVariables: { old: { initial: "1", current: "1", sensitive: false } },
  writesAllowed: false,
  authEnforced: false,
  active,
  credentials: [],
});

let environments: Environment[];
let onPost: (body: unknown) => unknown;
let onPatch: (body: unknown) => unknown;
let project: { baseUrl?: string };

function mount() {
  call.mockReset();
  call.mockImplementation(async (path: string, options?: { method?: string; body?: unknown }) => {
    if (path === `${BASE}/environments` && !options?.method) return environments;
    if (path === `${BASE}/environments` && options?.method === "POST") return onPost(options.body);
    if (path === BASE) return project;
    if (options?.method === "PATCH") return onPatch(options.body);
    if (path.endsWith("/variables/reveal")) return { userId: "42" };
    return undefined;
  });
  const onClose = vi.fn();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(
    <MemoryRouter>
      <QueryClientProvider client={client}>
        <ToastProvider>
          <EnvironmentManager projectId="p" onClose={onClose} />
        </ToastProvider>
      </QueryClientProvider>
    </MemoryRouter>,
  );
  return { onClose };
}

const problem = (detail: string, fields: { field: string; detail: string }[] = []) =>
  new ApiError(400, { type: "about:blank", title: "Bad", status: 400, detail, errors: fields });

beforeEach(() => {
  role.current = "admin";
  environments = [environment("a", "local", true), environment("b", "staging", false)];
  onPost = () => ({});
  onPatch = () => undefined;
  project = { baseUrl: "https://proyecto.example.com" };
});

describe("la lista de entornos", () => {
  test("dice cuál es el activo, cuántas variables tiene cada uno, y activar otro lo pide al servidor", async () => {
    mount();
    expect(await screen.findByText("local")).toBeDefined();
    expect(screen.getByText("Activo")).toBeDefined();
    expect(screen.getByText("https://staging.example.com · 1 variables")).toBeDefined();

    fireEvent.click(screen.getByRole("button", { name: "Activar" }));
    await waitFor(() =>
      expect(call).toHaveBeenCalledWith(`${BASE}/environments/b/activate`, expect.objectContaining({ method: "POST" })),
    );
    expect(await screen.findByText("Entorno «staging» activo")).toBeDefined();
  });

  test("sin entornos lo explica", async () => {
    environments = [];
    mount();
    expect(await screen.findByText(/Sin entornos\./)).toBeDefined();
  });

  test("un lector solo puede ver: ni activar, ni crear, ni eliminar", async () => {
    role.current = "viewer";
    mount();
    await screen.findByText("local");
    expect(screen.queryByRole("button", { name: "Activar" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Eliminar" })).toBeNull();
    expect(screen.queryByText("+ Nuevo entorno")).toBeNull();
    expect(screen.getAllByRole("button", { name: "Ver" })).toHaveLength(2);
  });

  test("el enlace a Settings cierra el gestor", async () => {
    const { onClose } = mount();
    fireEvent.click(await screen.findByRole("link", { name: "Settings → Entornos" }));
    expect(onClose).toHaveBeenCalled();
  });

  test("crear uno parte de la URL del proyecto y manda nombre y URL recortados", async () => {
    mount();
    await screen.findByText("local");
    fireEvent.click(screen.getByText("+ Nuevo entorno"));
    const url = screen.getByLabelText<HTMLInputElement>("URL base del entorno");
    await waitFor(() => expect(url.value).toBe("https://proyecto.example.com"));
    const create = screen.getByRole<HTMLButtonElement>("button", { name: "Crear" });
    expect(create.disabled).toBe(true);

    fireEvent.change(screen.getByLabelText("Nombre del entorno"), { target: { value: "  qa  " } });
    fireEvent.click(create);
    await waitFor(() =>
      expect(call).toHaveBeenCalledWith(
        `${BASE}/environments`,
        expect.objectContaining({ method: "POST", body: { name: "qa", baseUrl: "https://proyecto.example.com" } }),
      ),
    );
    expect(await screen.findByText("Entorno creado")).toBeDefined();
    expect(screen.queryByLabelText("Nombre del entorno")).toBeNull();
  });

  test("si el servidor rechaza el nuevo, el motivo de su campo sale en el formulario", async () => {
    onPost = () => {
      throw problem("Inválido", [{ field: "baseUrl", detail: "La URL no es válida" }]);
    };
    mount();
    await screen.findByText("local");
    fireEvent.click(screen.getByText("+ Nuevo entorno"));
    fireEvent.change(screen.getByLabelText("Nombre del entorno"), { target: { value: "qa" } });
    fireEvent.change(screen.getByLabelText("URL base del entorno"), { target: { value: "nada" } });
    fireEvent.click(screen.getByRole("button", { name: "Crear" }));
    expect(await screen.findByText("La URL no es válida")).toBeDefined();
  });

  test("sin URL en el proyecto el nuevo parte vacío, y un rechazo sin campo se dice con su mensaje", async () => {
    onPost = () => {
      throw problem("Ya hay un entorno con ese nombre");
    };
    project = {};
    mount();
    await screen.findByText("local");
    fireEvent.click(screen.getByText("+ Nuevo entorno"));
    expect(screen.getByLabelText<HTMLInputElement>("URL base del entorno").value).toBe("");
    fireEvent.change(screen.getByLabelText("Nombre del entorno"), { target: { value: "local" } });
    fireEvent.change(screen.getByLabelText("URL base del entorno"), { target: { value: "https://x" } });
    fireEvent.click(screen.getByRole("button", { name: "Crear" }));
    expect(await screen.findByText("Ya hay un entorno con ese nombre")).toBeDefined();
  });

  test("cancelar la confirmación de borrado no borra nada", async () => {
    mount();
    await screen.findByText("local");
    fireEvent.click(screen.getAllByRole("button", { name: "Eliminar" })[1]);
    expect(screen.getByText(/«staging» se elimina/)).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Cancelar" }));
    expect(screen.queryByText(/«staging» se elimina/)).toBeNull();
    expect(call.mock.calls.some(([, options]) => options?.method === "DELETE")).toBe(false);
  });

  test("Cancelar y Escape cierran el formulario sin crear nada", async () => {
    mount();
    await screen.findByText("local");
    fireEvent.click(screen.getByText("+ Nuevo entorno"));
    fireEvent.click(screen.getByRole("button", { name: "Cancelar" }));
    expect(screen.queryByLabelText("Nombre del entorno")).toBeNull();

    fireEvent.click(screen.getByText("+ Nuevo entorno"));
    fireEvent.keyDown(screen.getByLabelText("Nombre del entorno"), { key: "Escape" });
    expect(screen.queryByLabelText("Nombre del entorno")).toBeNull();
    expect(call.mock.calls.some(([, options]) => options?.method === "POST")).toBe(false);
  });

  test("eliminar pide confirmación, avisa si era el activo, y borra", async () => {
    mount();
    await screen.findByText("local");
    fireEvent.click(screen.getAllByRole("button", { name: "Eliminar" })[0]);
    expect(screen.getByText(/Era el activo: pasará a serlo el más antiguo/)).toBeDefined();
    const dialogButtons = screen.getAllByRole("button", { name: "Eliminar" });
    fireEvent.click(dialogButtons[dialogButtons.length - 1]);
    await waitFor(() =>
      expect(call).toHaveBeenCalledWith(`${BASE}/environments/a`, expect.objectContaining({ method: "DELETE" })),
    );
    expect(await screen.findByText("Entorno «local» eliminado")).toBeDefined();
  });

  test("un borrado rechazado se dice", async () => {
    mount();
    await screen.findByText("local");
    call.mockImplementation(async (path: string, options?: { method?: string }) => {
      if (options?.method === "DELETE") throw new Error("No se pudo");
      if (path === `${BASE}/environments`) return environments;
      return {};
    });
    fireEvent.click(screen.getAllByRole("button", { name: "Eliminar" })[1]);
    expect(screen.queryByText(/Era el activo/)).toBeNull();
    const dialogButtons = screen.getAllByRole("button", { name: "Eliminar" });
    fireEvent.click(dialogButtons[dialogButtons.length - 1]);
    expect(await screen.findByText("No se pudo")).toBeDefined();
  });
});

describe("editar un entorno", () => {
  async function open(name = "Editar", index = 1) {
    mount();
    await screen.findByText("local");
    fireEvent.click(screen.getAllByRole("button", { name })[index]);
    return screen.findByDisplayValue("staging");
  }

  test("sin cambios no se guarda; con cambios se manda todo en un PATCH, con las apagadas aparte", async () => {
    const name = await open();
    const save = screen.getByRole<HTMLButtonElement>("button", { name: "Guardar" });
    expect(save.disabled).toBe(true);

    fireEvent.change(name, { target: { value: " staging2 " } });
    expect(screen.getByText("Cambios sin guardar")).toBeDefined();
    fireEvent.click(save);
    await waitFor(() =>
      expect(call).toHaveBeenCalledWith(
        `${BASE}/environments/b`,
        expect.objectContaining({
          method: "PATCH",
          body: {
            name: "staging2",
            baseUrl: "https://staging.example.com",
            variables: { userId: { initial: "42", current: "42", sensitive: false } },
            disabledVariables: { old: { initial: "1", current: "1", sensitive: false } },
          },
        }),
      ),
    );
    expect(await screen.findByText("Entorno guardado")).toBeDefined();
    // Vuelve a la lista.
    expect(await screen.findByText("+ Nuevo entorno")).toBeDefined();
  });

  test("una variable mal nombrada bloquea el guardado y se dice", async () => {
    await open();
    fireEvent.change(screen.getByPlaceholderText("nueva variable"), { target: { value: "1mal" } });
    expect(screen.getByText("Hay variables con problemas")).toBeDefined();
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "Guardar" }).disabled).toBe(true);
  });

  test("descartar vuelve a lo guardado, y sin cambios el botón es Cancelar y vuelve a la lista", async () => {
    await open();
    const url = screen.getByDisplayValue("https://staging.example.com");
    fireEvent.change(url, { target: { value: "https://otro" } });
    fireEvent.click(screen.getByRole("button", { name: "Descartar" }));
    expect(screen.getByDisplayValue("https://staging.example.com")).toBeDefined();

    fireEvent.click(screen.getByRole("button", { name: "Cancelar" }));
    expect(await screen.findByText("+ Nuevo entorno")).toBeDefined();
  });

  test("el error del servidor al guardar sale debajo", async () => {
    onPatch = () => {
      throw problem("El nombre ya existe");
    };
    const name = await open();
    fireEvent.change(name, { target: { value: "local" } });
    fireEvent.click(screen.getByRole("button", { name: "Guardar" }));
    expect(await screen.findByText("El nombre ya existe")).toBeDefined();
  });

  test("si el servidor señala un campo al guardar, sale su motivo", async () => {
    onPatch = () => {
      throw problem("Inválido", [{ field: "baseUrl", detail: "La URL no es válida" }]);
    };
    const name = await open();
    fireEvent.change(name, { target: { value: "otro" } });
    fireEvent.click(screen.getByRole("button", { name: "Guardar" }));
    expect(await screen.findByText("La URL no es válida")).toBeDefined();
  });

  test("«← Entornos» vuelve a la lista", async () => {
    await open();
    fireEvent.click(screen.getByText("← Entornos"));
    expect(await screen.findByText("+ Nuevo entorno")).toBeDefined();
  });

  test("un lector ve el entorno sin poder tocarlo ni guardar", async () => {
    role.current = "viewer";
    const name = await open("Ver");
    expect((name as HTMLInputElement).disabled).toBe(true);
    expect(screen.queryByRole("button", { name: "Guardar" })).toBeNull();
  });

  test("un admin puede pedir los secretos", async () => {
    environments = [
      {
        ...environment("b", "staging", false),
        variables: { token: { initial: "••••••••", current: "••••••••", sensitive: true } },
      },
    ];
    mount();
    await screen.findByText("staging");
    fireEvent.click(screen.getByRole("button", { name: "Editar" }));
    fireEvent.click(await screen.findByRole("button", { name: "Ver secretos" }));
    await waitFor(() => expect(call).toHaveBeenCalledWith(`${BASE}/environments/b/variables/reveal`));
  });
});
