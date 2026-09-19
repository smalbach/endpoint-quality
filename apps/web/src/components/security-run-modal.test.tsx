/**
 * «Nueva corrida de seguridad»: entorno, alcance, reglas y ajustes.
 *
 * Lo que se comprueba: que el entorno activo viene elegido y el aviso de «sin autorización» sale
 * cuando toca, que se nombran los roles sin credencial en ese entorno, que las reglas y los presets
 * cuentan bien y sin ninguna no se puede lanzar, que el alcance «Elegidos» exige elegir endpoints
 * (por carpeta o sueltos) y los manda, y que un error del servidor se enseña.
 */
import { describe, expect, test, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";

import { SecurityRunModal } from "@/components/security-run-modal";
import { ApiError } from "@/lib/api";
import type { Environment } from "@/lib/types";

const call = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", async (original) => ({ ...(await original<object>()), api: call }));

const env = (patch: Partial<Environment>): Environment =>
  ({
    id: "e",
    name: "Entorno",
    baseUrl: "https://api.ejemplo.com",
    specUrl: null,
    variables: {},
    disabledVariables: {},
    writesAllowed: false,
    authEnforced: true,
    active: false,
    credentials: [],
    ...patch,
  }) as Environment;

const ENVIRONMENTS = [
  env({ id: "dev", name: "Desarrollo", authEnforced: false, credentials: [] }),
  env({ id: "prod", name: "Producción", active: true, credentials: [{ role: "admin" } as never] }),
];
const ROLES = [{ name: "admin" }, { name: "cliente" }];
const ENDPOINTS = [
  { id: "u1", method: "GET", path: "/users" },
  { id: "u2", method: "DELETE", path: "/users/{id}" },
  { id: "o1", method: "GET", path: "/v1/orders" },
];

function mount(post?: () => Promise<unknown>) {
  call.mockReset();
  call.mockImplementation((path: string, init?: { method?: string }) => {
    if (init?.method === "POST") return post ? post() : Promise.resolve({ runId: "run-1" });
    if (path.endsWith("/environments")) return Promise.resolve(ENVIRONMENTS);
    if (path.endsWith("/roles")) return Promise.resolve(ROLES);
    if (path.includes("/endpoints")) return Promise.resolve({ data: ENDPOINTS });
    return Promise.resolve({});
  });
  const onClose = vi.fn();
  const onStarted = vi.fn();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <SecurityRunModal base="/api/p/p1" projectId="p1" onClose={onClose} onStarted={onStarted} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { onClose, onStarted };
}

const launch = () => screen.getByRole("button", { name: "Lanzar corrida" }) as HTMLButtonElement;
const posted = () => {
  const found = call.mock.calls.find((args: unknown[]) => (args[1] as { method?: string } | undefined)?.method === "POST");
  return found as [string, { body: Record<string, unknown> }] | undefined;
};

describe("la nueva corrida de seguridad", () => {
  test("elige el entorno activo, nombra los roles sin credencial y lanza con lo de siempre", async () => {
    const { onStarted } = mount();
    await waitFor(() => expect(screen.getByText(/Sin credencial en este entorno: cliente\./)).toBeTruthy());
    const select = screen.getByRole("combobox") as HTMLSelectElement;
    expect(select.value).toBe("prod");
    expect(screen.queryByText(/no aplica autorización/)).toBeNull();
    expect(screen.getByRole("link", { name: "Añadirlas" }).getAttribute("href")).toBe("/p/p1/settings/environments");

    fireEvent.change(screen.getByPlaceholderText("Antes del despliegue"), { target: { value: "  Antes  " } });
    fireEvent.click(launch());
    await waitFor(() => expect(onStarted).toHaveBeenCalledWith("run-1"));
    const [path, init] = posted()!;
    expect(path).toBe("/api/p/p1/security-runs");
    expect(init.body.environmentId).toBe("prod");
    expect(init.body.label).toBe("Antes");
    expect(init.body.endpointIds).toBeUndefined();
    expect(init.body.crossUserPermutations).toBe(false);
  });

  test("un entorno sin autorización lo avisa, y ahí faltan todas las credenciales", async () => {
    mount();
    await waitFor(() => expect(screen.getByRole("combobox")).toBeTruthy());
    await waitFor(() => expect(screen.getAllByRole("option")).toHaveLength(2));
    expect(screen.getByRole("option", { name: /Desarrollo · sin autorización/ })).toBeTruthy();
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "dev" } });
    expect(screen.getByText(/no aplica autorización/)).toBeTruthy();
    await waitFor(() => expect(screen.getByText(/Sin credencial en este entorno: admin, cliente\./)).toBeTruthy());
  });

  test("las reglas: presets, «Ninguna» deja el botón apagado, y el límite pide iteraciones", async () => {
    mount();
    await waitFor(() => expect(launch().disabled).toBe(false));
    expect(screen.getByText("Reglas (14/17)")).toBeTruthy();
    expect(screen.queryByText("Iteraciones del límite")).toBeNull();

    fireEvent.click(screen.getByText("Ninguna"));
    expect(screen.getByText("Reglas (0/17)")).toBeTruthy();
    expect(launch().disabled).toBe(true);

    fireEvent.click(screen.getByText("Recomendadas"));
    expect(screen.getByText("Reglas (14/17)")).toBeTruthy();

    // Encender el límite de peticiones enseña sus iteraciones.
    const rateLimit = screen.getByLabelText("Límite de peticiones");
    fireEvent.click(rateLimit);
    expect(screen.getByText("Reglas (15/17)")).toBeTruthy();
    const iterations = screen.getByRole("spinbutton");
    fireEvent.change(iterations, { target: { value: "35" } });

    fireEvent.click(screen.getByLabelText(/Permutaciones entre usuarios/));
    fireEvent.click(launch());
    await waitFor(() => expect(posted()).toBeTruthy());
    const body = posted()![1].body;
    expect(body.rateLimitIterations).toBe(35);
    expect(body.crossUserPermutations).toBe(true);
    expect((body.rules as Record<string, boolean>).rate_limit).toBe(true);
  });

  test("alcance «Elegidos»: sin endpoints no se lanza; por carpeta y sueltos, y se mandan esos", async () => {
    mount();
    await waitFor(() => expect(launch().disabled).toBe(false));
    fireEvent.click(screen.getByLabelText(/Elegidos/));
    expect(screen.getByText(/Elegidos\s*\(0\)/)).toBeTruthy();
    expect(launch().disabled).toBe(true);

    // La carpeta «users» marca sus dos endpoints de una vez.
    const users = screen.getByText("users").closest("label")!;
    fireEvent.click(within(users).getByRole("checkbox"));
    expect(screen.getByText(/Elegidos\s*\(2\)/)).toBeTruthy();
    expect(launch().disabled).toBe(false);

    // Quitar uno suelto deja la carpeta a medias.
    const deleteRow = screen.getByText("/users/{id}").closest("label")!;
    fireEvent.click(within(deleteRow).getByRole("checkbox"));
    expect(screen.getByText(/Elegidos\s*\(1\)/)).toBeTruthy();
    expect((within(users).getByRole("checkbox") as HTMLInputElement).indeterminate).toBe(true);

    // Y uno de la carpeta de versión, anidada.
    const ordersRow = screen.getByText("/v1/orders").closest("label")!;
    fireEvent.click(within(ordersRow).getByRole("checkbox"));

    fireEvent.click(launch());
    await waitFor(() => expect(posted()).toBeTruthy());
    expect(posted()![1].body.endpointIds).toEqual(["u1", "o1"]);

    // Volver a «Todos» esconde el árbol.
    fireEvent.click(screen.getByLabelText(/Todos los endpoints/));
    expect(screen.queryByText("/v1/orders")).toBeNull();
  });

  test("un error del servidor se enseña: el detalle del campo o el mensaje", async () => {
    mount(() =>
      Promise.reject(
        new ApiError(422, { title: "Inválido", status: 422, errors: [{ field: "environmentId", detail: "Entorno borrado" }] } as never),
      ),
    );
    await waitFor(() => expect(launch().disabled).toBe(false));
    fireEvent.click(launch());
    await waitFor(() => expect(screen.getByText("Entorno borrado")).toBeTruthy());
  });

  test("mientras se lanza el botón lo dice y no deja pulsarlo; un rechazo sin campos enseña su detalle", async () => {
    let reject!: (error: unknown) => void;
    mount(() => new Promise((_resolve, fail) => (reject = fail)));
    await waitFor(() => expect(launch().disabled).toBe(false));
    fireEvent.click(launch());
    const pending = (await screen.findByRole("button", { name: "Lanzando…" })) as HTMLButtonElement;
    expect(pending.disabled).toBe(true);
    reject(new ApiError(409, { type: "about:blank", title: "Conflicto", status: 409, detail: "Ya hay una corrida en marcha" }));
    await waitFor(() => expect(screen.getByText("Ya hay una corrida en marcha")).toBeTruthy());
    expect(launch().disabled).toBe(false);
  });

  test("un error que no es del API enseña su mensaje, y Cancelar cierra", async () => {
    const { onClose } = mount(() => Promise.reject(new Error("Sin red")));
    await waitFor(() => expect(launch().disabled).toBe(false));
    fireEvent.click(launch());
    await waitFor(() => expect(screen.getByText("Sin red")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Cancelar" }));
    expect(onClose).toHaveBeenCalled();
  });
});
