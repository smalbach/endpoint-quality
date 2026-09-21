/**
 * El resto del botón de entorno: cómo se cierra el desplegable, qué enseña mientras carga o sin
 * entornos, las variables vacías, quien no puede cambiar el activo, «Gestionar entornos», y el
 * token de sesión que vino de un script, que ya caducó o del que no se sabe cuándo caduca.
 */
import { afterEach, describe, expect, test, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { EnvironmentButton } from "@/components/environment-button";
import { ToastProvider } from "@/components/toast";
import { ImportProvider } from "@/components/import-provider";
import type { Environment, SessionTokenView } from "@/lib/types";

const call = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", async (original) => ({ ...(await original<object>()), api: call }));
const can = vi.hoisted(() => ({ edit: true }));
vi.mock("@/lib/auth", () => ({ useOrganization: () => ({ id: "o", name: "Org" }), useCan: () => can.edit }));
// El gestor tiene sus propias pruebas; aquí sólo importa que se abre y se cierra.
vi.mock("@/components/environment-manager", () => ({
  EnvironmentManager: ({ onClose }: { onClose: () => void }) => (
    <div role="dialog" aria-label="Gestor de entornos">
      <button onClick={onClose}>cerrar gestor</button>
    </div>
  ),
}));

const BASE = "/orgs/o/projects/p";

afterEach(() => {
  can.edit = true;
});

const environment = (id: string, name: string, active: boolean, variables: Environment["variables"] = {}) =>
  ({
    id,
    name,
    baseUrl: `https://${name}.example.com`,
    specUrl: null,
    variables,
    disabledVariables: {},
    writesAllowed: false,
    authEnforced: false,
    active,
    credentials: [],
    archivedAt: null,
    deletedAt: null,
  }) as Environment;

function mount({
  environments = [environment("a", "local", true)] as Environment[] | "pending",
  token = null as SessionTokenView | null,
} = {}) {
  call.mockReset();
  call.mockImplementation(async (path: string, options?: { method?: string }) => {
    if (path === `${BASE}/environments`) return environments === "pending" ? new Promise(() => {}) : environments;
    if (path === `${BASE}/session-token` && !options?.method) return { token };
    return undefined;
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <ToastProvider>
        <ImportProvider projectId="p">
          <div>
            <EnvironmentButton projectId="p" />
            <p>fuera</p>
          </div>
        </ImportProvider>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

const trigger = () => screen.getAllByRole("button")[0]!;

describe("el desplegable", () => {
  test("se cierra con Escape o con un clic fuera, y no con otra tecla ni con un clic dentro", async () => {
    mount();
    await screen.findByText("local");
    fireEvent.click(trigger());
    expect(trigger().getAttribute("aria-expanded")).toBe("true");
    fireEvent.keyDown(document, { key: "Enter" });
    fireEvent.mouseDown(screen.getByText("Variables de local"));
    expect(trigger().getAttribute("aria-expanded")).toBe("true");
    fireEvent.keyDown(document, { key: "Escape" });
    expect(trigger().getAttribute("aria-expanded")).toBe("false");

    fireEvent.click(trigger());
    fireEvent.mouseDown(screen.getByText("fuera"));
    expect(trigger().getAttribute("aria-expanded")).toBe("false");
  });

  test("mientras carga lo dice", () => {
    mount({ environments: "pending" });
    fireEvent.click(trigger());
    expect(screen.getByText("Cargando…")).toBeDefined();
    expect(screen.getByText("Sin entorno")).toBeDefined();
  });

  test("sin entornos lo dice, y «Gestionar entornos» abre el gestor y se cierra", async () => {
    mount({ environments: [] });
    fireEvent.click(trigger());
    expect(await screen.findByText(/Sin entornos configurados/)).toBeDefined();
    fireEvent.click(screen.getByText("Gestionar entornos"));
    expect(screen.getByRole("dialog", { name: "Gestor de entornos" })).toBeDefined();
    expect(screen.queryByText("Gestionar entornos")).toBeNull();
    fireEvent.click(screen.getByText("cerrar gestor"));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  test("«Importar entorno» abre el import sin pasar por el gestor, y a un lector ni se le ofrece", async () => {
    mount({ environments: [] });
    fireEvent.click(trigger());
    fireEvent.click(await screen.findByText("Importar entorno"));
    expect(screen.getByRole("dialog", { name: "Importar entornos" })).toBeDefined();
    expect(screen.queryByText("Gestionar entornos")).toBeNull();

    can.edit = false;
    mount({ environments: [] });
    fireEvent.click(trigger());
    await screen.findAllByText(/Sin entornos configurados/);
    expect(screen.queryByText("Importar entorno")).toBeNull();
  });
});

describe("las variables del activo", () => {
  test("sin variables dice que no hay ninguna", async () => {
    mount();
    await screen.findByText("local");
    fireEvent.click(trigger());
    expect(screen.getByText("Ninguna activa.")).toBeDefined();
  });

  test("sin valor actual enseña el inicial, y sin ninguno de los dos dice «vacía»", async () => {
    mount({
      environments: [
        environment("a", "local", true, {
          host: { initial: "localhost", current: "", sensitive: false },
          empty: { initial: "", current: "", sensitive: false },
        }),
      ],
    });
    await screen.findByText("local");
    fireEvent.click(trigger());
    expect(screen.getByText("localhost")).toBeDefined();
    expect(screen.getByText("vacía").className).toContain("italic");
  });
});

describe("cambiar el activo", () => {
  test("pulsar el que ya está activo no pide nada", async () => {
    mount({ environments: [environment("a", "local", true), environment("b", "staging", false)] });
    await screen.findByText("local");
    fireEvent.click(trigger());
    fireEvent.click(screen.getAllByText("local").at(-1)!);
    expect(call.mock.calls.some(([, options]) => options?.method === "POST")).toBe(false);
  });

  test("sin rol de editor los demás se ven pero no se pueden elegir", async () => {
    can.edit = false;
    mount({ environments: [environment("a", "local", true), environment("b", "staging", false)] });
    await screen.findByText("local");
    fireEvent.click(trigger());
    const other = screen.getByText("staging").closest("button")!;
    expect(other.disabled).toBe(true);
    expect(other.title).toMatch(/necesita el rol editor/);
    expect(screen.getAllByText("local").at(-1)!.closest("button")!.disabled).toBe(false);
  });
});

describe("el token de sesión", () => {
  const token = (patch: Partial<SessionTokenView>): SessionTokenView => ({
    source: "script",
    capturedAt: new Date().toISOString(),
    expiresAt: null,
    expired: false,
    claims: {},
    preview: "abc…xyz",
    ...patch,
  });

  test("uno de un script sin caducidad conocida lo dice, sin claims que enseñar", async () => {
    mount({ token: token({}) });
    fireEvent.click(await screen.findByRole("button", { name: /Token/ }));
    expect(screen.getByText(/De un script/)).toBeDefined();
    expect(screen.getByText("desconocido")).toBeDefined();
  });

  test("uno caducado no marca el botón y dice «Caducado» en rojo", async () => {
    mount({ token: token({ expired: true, expiresAt: new Date(Date.now() + 3_600_000).toISOString() }) });
    await screen.findByText("local");
    fireEvent.click(trigger());
    expect(await screen.findByText("Caducado")).toBeDefined();
    expect(screen.getByText("Caducado").className).toContain("text-rose-600");
    expect(trigger().textContent).not.toContain("Token");
  });

  test("olvidarlo avisa", async () => {
    mount({ token: token({}) });
    fireEvent.click(await screen.findByRole("button", { name: /Token/ }));
    fireEvent.click(screen.getByRole("button", { name: "Olvidar" }));
    await waitFor(() => expect(screen.getByText("Token de sesión olvidado")).toBeDefined());
  });
});
