/**
 * «Enviar» en el editor de un paso, y lo que contestó.
 *
 * Lo que se comprueba: que sin entorno no se puede enviar y se dice por qué, que lo que se manda
 * es el formulario sin las filas a medio escribir, que el veredicto va aparte del código (un 200
 * verde con un aspa al lado), que las comprobaciones están siempre a la vista y las pestañas
 * enseñan cuerpo, cabeceras y petición, y que «cURL» enseña el comando aunque el portapapeles se
 * niegue, avisando de la credencial que falta.
 */
import { afterEach, describe, expect, test, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { RequestPreviewPanel } from "@/components/request-preview";
import { ApiError } from "@/lib/api";
import type { RequestPreviewView, RequestTemplateView } from "@/lib/types";

const call = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", async (original) => ({ ...(await original<object>()), api: call }));

const BASE = "/orgs/o/projects/p";

const TEMPLATE: RequestTemplateView = {
  id: "t1",
  name: "Crear widget",
  operationId: "createWidget",
  description: null,
  expectedStatus: 404,
  parameters: { id: "7", "": "x", vacio: "" },
  disabledParameters: { off: "1" },
  headers: { "X-Trace": "abc", "X-Empty": "" },
  disabledHeaders: {},
  body: { type: "none" } as RequestTemplateView["body"],
  auth: "primary",
  updatedAt: "",
};

const preview = (patch: Partial<RequestPreviewView> = {}): RequestPreviewView => ({
  ok: false,
  failure: null,
  request: {
    method: "POST",
    url: "https://api.example.com/widgets/7",
    headers: { Authorization: "••••••••", "X-Trace": "abc" },
    body: null,
  },
  expected: { status: 404, shape: "data", operationPath: "/widgets/{id}" },
  response: {
    status: 200,
    contentType: "application/json",
    headers: { "content-type": "application/json" },
    body: { id: 7 },
    sizeBytes: 2048,
  },
  assertions: [{ label: "Código 404", pass: false, detail: "Llegó 200" }],
  latency: { samples: [12], budgetMs: null },
  durationMs: 12,
  ...patch,
});

function mount(props: { environmentId?: string; canSend?: boolean; onResponseBody?: (body: unknown) => void } = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <RequestPreviewPanel
        base={BASE}
        template={TEMPLATE}
        environmentId={props.environmentId ?? "env1"}
        canSend={props.canSend ?? true}
        onResponseBody={props.onResponseBody}
      />
    </QueryClientProvider>,
  );
}

afterEach(() => {
  call.mockReset();
});

describe("enviar una petición de prueba", () => {
  test("sin entorno no se envía y se dice cuál falta", () => {
    mount({ environmentId: "" });
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "Enviar" }).disabled).toBe(true);
    expect(screen.getByText("Elige un entorno para poder enviarla.")).toBeDefined();
  });

  test("sin permiso tampoco", () => {
    mount({ canSend: false });
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "Enviar" }).disabled).toBe(true);
    expect(screen.queryByText("Elige un entorno para poder enviarla.")).toBeNull();
  });

  test("manda el formulario sin las filas a medio escribir y enseña el veredicto aparte del código", async () => {
    call.mockResolvedValue(preview());
    const onResponseBody = vi.fn();
    mount({ onResponseBody });
    fireEvent.click(screen.getByRole("button", { name: "Enviar" }));

    expect(await screen.findByText("200")).toBeDefined();
    expect(call).toHaveBeenCalledWith(`${BASE}/request-preview`, {
      method: "POST",
      body: {
        environmentId: "env1",
        name: "Crear widget",
        operationId: "createWidget",
        expectedStatus: 404,
        parameters: { id: "7" },
        headers: { "X-Trace": "abc" },
        body: { type: "none" },
        auth: "primary",
      },
    });
    // Un 200 que no cumple: el aspa al lado del código.
    expect(screen.getByTitle("No cumple lo que se esperaba").textContent).toBe("✗");
    expect(screen.getByText("Código 404")).toBeDefined();
    expect(screen.getByText("Llegó 200")).toBeDefined();
    expect(screen.getByText(/"id": 7/)).toBeDefined();
    expect(onResponseBody).toHaveBeenCalledWith({ id: 7 });
  });

  test("las pestañas enseñan las cabeceras de la respuesta y la petición tal como salió", async () => {
    call.mockResolvedValue(preview());
    mount();
    fireEvent.click(screen.getByRole("button", { name: "Enviar" }));
    await screen.findByText("200");

    fireEvent.click(screen.getByRole("button", { name: "Cabeceras" }));
    expect(screen.getByText(/"content-type": "application\/json"/)).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Petición" }));
    expect(screen.getByText(/"url": "https:\/\/api.example.com\/widgets\/7"/)).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Cuerpo" }));
    expect(screen.getByText(/"id": 7/)).toBeDefined();
  });

  test("sin respuesta: lo dice, sin tamaño, y las pestañas lo explican", async () => {
    call.mockResolvedValue(preview({ ok: true, response: null, assertions: [] }));
    mount();
    fireEvent.click(screen.getByRole("button", { name: "Enviar" }));
    expect(await screen.findByText("sin respuesta")).toBeDefined();
    expect(screen.getByTitle("Cumple lo que se esperaba").textContent).toBe("✓");
    expect(screen.getByText("Ninguna comprobación llegó a evaluarse.")).toBeDefined();
    expect(screen.getByText("La petición no obtuvo respuesta")).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Cabeceras" }));
    expect(screen.getByText("No hubo cabeceras")).toBeDefined();
  });

  test("un rechazo de la API se dice con su mensaje, y cualquier otro fallo con uno genérico", async () => {
    call.mockRejectedValueOnce(
      new ApiError(409, { type: "about:blank", title: "Conflict", status: 409, detail: "Escrituras no permitidas" }),
    );
    mount();
    fireEvent.click(screen.getByRole("button", { name: "Enviar" }));
    expect(await screen.findByText("Escrituras no permitidas")).toBeDefined();

    call.mockRejectedValueOnce(new TypeError("fetch failed"));
    fireEvent.click(screen.getByRole("button", { name: "Enviar" }));
    expect(await screen.findByText("No se pudo enviar la petición")).toBeDefined();
  });
});

describe("el comando cURL", () => {
  async function sent() {
    call.mockResolvedValue(preview());
    mount();
    fireEvent.click(screen.getByRole("button", { name: "Enviar" }));
    await screen.findByText("200");
  }

  test("se enseña, se copia, y avisa de la credencial que hay que rellenar", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    await sent();
    fireEvent.click(screen.getByRole("button", { name: "cURL" }));

    expect(await screen.findByRole("button", { name: "copiado" })).toBeDefined();
    const command = writeText.mock.calls[0][0] as string;
    expect(command).toContain("https://api.example.com/widgets/7");
    expect(screen.getByText((_text, node) => node?.tagName === "PRE" && node.textContent === command)).toBeDefined();
    expect(screen.getByText(/Rellena Authorization: la credencial no sale de la API/)).toBeDefined();

    // Pulsarlo otra vez lo esconde.
    fireEvent.click(screen.getByRole("button", { name: "copiado" }));
    expect(screen.queryByText(/Rellena Authorization/)).toBeNull();
  });

  test("si el portapapeles se niega, el comando sigue en pantalla", async () => {
    Object.assign(navigator, { clipboard: { writeText: vi.fn().mockRejectedValue(new Error("no")) } });
    await sent();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "cURL" }));
    });
    await waitFor(() => expect(screen.getByText(/Rellena Authorization/)).toBeDefined());
    expect(screen.getByRole("button", { name: "cURL" })).toBeDefined();
  });
});
