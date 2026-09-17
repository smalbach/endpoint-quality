/**
 * El panel de ejemplos guardados.
 *
 * Lo que se comprueba: que **el parte de lo que se quitó se enseña**, que el botón de guardar está
 * apagado mientras no hay una respuesta que guardar, que borrar manda el id del ejemplo y no el del
 * endpoint, y que un endpoint sin guardar lo dice en vez de enseñar una lista vacía que nunca se va
 * a llenar.
 *
 * El parte es la parte que importa. Un ejemplo que perdió la cabecera de autenticación en silencio
 * se lee como «esto funcionaba sin credencial», así que si esta prueba se pone roja lo que se rompe
 * no es un aviso: es lo que alguien va a creer del endpoint.
 */
import { describe, expect, test, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { ExamplePanel } from "@/components/example-panel";
import { ToastProvider } from "@/components/toast";
import type { ExampleView, SavedExampleView, SentRequestView } from "@/lib/types";

const call = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", async (original) => ({ ...(await original<object>()), api: call }));
vi.mock("@/lib/auth", () => ({ useOrganization: () => ({ id: "o", name: "Org" }), useCan: () => true }));

const example = (patch: Partial<ExampleView> = {}): ExampleView => ({
  id: "ex1",
  endpointId: "en1",
  name: "200 correcto",
  request: {
    method: "POST",
    url: "https://api.ejemplo.com/v1/sesiones",
    headers: [],
    body: { text: "", contentType: "application/json" },
  },
  response: {
    status: 200,
    headers: [],
    body: '{"id":7}',
    contentType: "application/json",
    durationMs: 12,
  },
  origin: "manual",
  orderIndex: 0,
  createdAt: "2026-03-01T10:00:00.000Z",
  updatedAt: "2026-03-01T10:00:00.000Z",
  createdBy: "u1",
  sizeBytes: 8,
  ...patch,
});

const sent = (): SentRequestView =>
  ({
    request: { method: "POST", url: "https://api.ejemplo.com/v1/sesiones", headers: {}, body: null },
    response: {
      status: 200,
      headers: { "content-type": "application/json" },
      body: '{"id":7}',
      sizeBytes: 8,
      durationMs: 12,
      timing: { dnsMs: 0, ttfbMs: 0, downloadMs: 0 },
    },
    error: null,
    auth: "",
    environment: null,
    scripts: { pre: null, post: null },
    sessionToken: null,
    cookies: { sent: [], stored: [], rejected: [] },
  }) as SentRequestView;

const redaction = (patch: Partial<SavedExampleView["redaction"]> = {}): SavedExampleView["redaction"] => ({
  droppedHeaders: [],
  maskedFields: [],
  bodyScanned: true,
  ...patch,
});

function mount(options: {
  examples?: ExampleView[];
  sent?: SentRequestView | null;
  endpointId?: string | null;
  canEdit?: boolean;
  saved?: SavedExampleView;
}) {
  call.mockReset();
  call.mockImplementation((path: string, init?: { method?: string }) => {
    if (init?.method === "POST")
      return Promise.resolve(options.saved ?? { example: example(), redaction: redaction() });
    if (init?.method === "DELETE") return Promise.resolve(undefined);
    if (path.includes("/examples")) return Promise.resolve({ examples: options.examples ?? [] });
    return Promise.resolve({});
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <ToastProvider>
        <ExamplePanel
          projectId="p"
          endpointId={options.endpointId === undefined ? "en1" : options.endpointId}
          sent={options.sent ?? null}
          canEdit={options.canEdit ?? true}
        />
      </ToastProvider>
    </QueryClientProvider>,
  );
}

describe("la lista", () => {
  test("un endpoint sin guardar lo dice, en vez de una lista que nunca se va a llenar", () => {
    mount({ endpointId: null });
    expect(screen.getByText(/Guarda el endpoint/)).toBeTruthy();
  });

  test("sin ejemplos dice qué hacer, no «0 resultados»", async () => {
    mount({});
    await waitFor(() => expect(screen.getByText(/Envía la petición y guarda la respuesta/)).toBeTruthy());
  });

  test("cada uno sale con su código de estado, que es lo que se busca en la lista", async () => {
    mount({ examples: [example({ name: "404 no encontrado", response: { ...example().response, status: 404 } })] });
    await waitFor(() => expect(screen.getByText("404 no encontrado")).toBeTruthy());
    expect(screen.getByText("404")).toBeTruthy();
  });

  test("uno importado se marca como tal: no lo escribió nadie de este equipo", async () => {
    mount({ examples: [example({ origin: "import" })] });
    await waitFor(() => expect(screen.getByText(/importado/)).toBeTruthy());
  });

  test("abrirlo enseña el cuerpo y la petición que lo produjo", async () => {
    mount({ examples: [example()] });
    await waitFor(() => expect(screen.getByText("200 correcto")).toBeTruthy());
    expect(screen.queryByText(/v1\/sesiones/)).toBeNull();

    fireEvent.click(screen.getByText("200 correcto"));
    // La petición: un 404 suelto no significa nada sin lo que se mandó.
    expect(screen.getByText(/POST https:\/\/api\.ejemplo\.com\/v1\/sesiones/)).toBeTruthy();
    expect(screen.getByText(/"id": 7/)).toBeTruthy();
  });
});

describe("guardar la respuesta que hay en pantalla", () => {
  test("apagado mientras no hay respuesta, y dice por qué", async () => {
    mount({ sent: null });
    await waitFor(() => expect(screen.getByText("Guardar la respuesta")).toBeTruthy());
    const button = screen.getByText("Guardar la respuesta").closest("button");
    expect(button?.disabled).toBe(true);
    expect(button?.title).toMatch(/Envía la petición/);
  });

  test("manda el par entero: la petición y la respuesta", async () => {
    mount({ sent: sent() });
    fireEvent.click(screen.getByText("Guardar la respuesta"));
    await waitFor(() =>
      expect(
        call.mock.calls.some((args: unknown[]) => {
          const options = args[1] as { method?: string; body?: Record<string, unknown> } | undefined;
          if (options?.method !== "POST") return false;
          const body = options.body as { request?: { method?: string }; response?: { status?: number } };
          return body?.request?.method === "POST" && body?.response?.status === 200;
        }),
      ).toBe(true),
    );
  });

  test("lo que se quitó se enseña: una cabecera de credencial que ya no está", async () => {
    mount({
      sent: sent(),
      saved: { example: example(), redaction: redaction({ droppedHeaders: ["Authorization"] }) },
    });
    fireEvent.click(screen.getByText("Guardar la respuesta"));
    await waitFor(() => expect(screen.getByText(/No se guardaron estas cabeceras/)).toBeTruthy());
    expect(screen.getByText(/Authorization/)).toBeTruthy();
  });

  test("y los valores tapados, con su ruta dentro del cuerpo", async () => {
    mount({
      sent: sent(),
      saved: { example: example(), redaction: redaction({ maskedFields: ["access_token", "usuario.password"] }) },
    });
    fireEvent.click(screen.getByText("Guardar la respuesta"));
    await waitFor(() => expect(screen.getByText(/access_token, usuario.password/)).toBeTruthy());
  });

  test("un cuerpo que no es JSON avisa de que no se ha mirado dentro", async () => {
    // Lo honesto: no se puede buscar un secreto en un HTML con una expresión regular, así que no se
    // mira — y decirlo es lo que evita que alguien dé el ejemplo por revisado.
    mount({ sent: sent(), saved: { example: example(), redaction: redaction({ bodyScanned: false }) } });
    fireEvent.click(screen.getByText("Guardar la respuesta"));
    await waitFor(() => expect(screen.getByText(/no se ha mirado dentro/)).toBeTruthy());
  });

  test("sin nada que quitar no sale ningún aviso", async () => {
    mount({ sent: sent() });
    fireEvent.click(screen.getByText("Guardar la respuesta"));
    // Se espera al aviso de éxito y no a la fila: la lista la devuelve otra llamada, y en esta
    // prueba el listado simulado sigue vacío. Lo que se mira es que el hueco ámbar no aparece.
    await waitFor(() => expect(screen.getByText(/Guardado/)).toBeTruthy());
    expect(screen.queryByText(/No se guardaron/)).toBeNull();
    expect(screen.queryByText(/Se taparon/)).toBeNull();
    expect(screen.queryByText(/no se ha mirado dentro/)).toBeNull();
  });
});

describe("permisos y borrado", () => {
  test("quien no puede editar no ve ni guardar ni borrar", async () => {
    mount({ examples: [example()], sent: sent(), canEdit: false });
    await waitFor(() => expect(screen.getByText("200 correcto")).toBeTruthy());
    expect(screen.queryByText("Guardar la respuesta")).toBeNull();
    expect(screen.queryByText("borrar")).toBeNull();
  });

  test("borrar manda el id del ejemplo, no el del endpoint", async () => {
    mount({ examples: [example({ id: "ex-7" })] });
    await waitFor(() => expect(screen.getByText("borrar")).toBeTruthy());
    fireEvent.click(screen.getByText("borrar"));
    await waitFor(() =>
      expect(
        call.mock.calls.some((args: unknown[]) => {
          const options = args[1] as { method?: string } | undefined;
          return options?.method === "DELETE" && String(args[0]).endsWith("/examples/ex-7");
        }),
      ).toBe(true),
    );
  });
});
