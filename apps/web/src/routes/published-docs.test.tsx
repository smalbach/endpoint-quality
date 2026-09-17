/**
 * La página publicada, que es la única pantalla del producto fuera de la sesión.
 *
 * Lo que se comprueba:
 *
 * - **Un 401 pide la clave y no manda a `/login`.** Quien abre el enlace no tiene cuenta aquí, y la
 *   petición **no** reintenta refrescar: hacerlo cerraría la sesión de quien además esté dentro de
 *   la aplicación en otra pestaña.
 * - **La clave viaja en `x-api-key` y no en la URL.** Una URL con la clave dentro acaba en el
 *   historial y en el registro de cualquier proxy.
 * - **El código de ejemplo escribe la credencial como marcador**, porque la página no la tiene: si
 *   saliera con los ocho puntos, se pegaría tal cual y daría un 401 inexplicable.
 * - **Lo que el fragmento no puede llevar sale escrito**, encima del código.
 */
import { describe, expect, test, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";

import { ApiError } from "@/lib/api";
import { PublishedDocsPage, bodyWithPlaceholders } from "@/routes/published-docs";
import type { DocEndpointView, DocPageView } from "@/lib/types";

const call = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", async (original) => ({
  ...(await original<object>()),
  api: call,
}));

const endpoint = (patch: Partial<DocEndpointView> = {}): DocEndpointView => ({
  id: "e1",
  method: "GET",
  path: "/v1/pedidos/{id}",
  url: "https://api.ejemplo.com/v1/pedidos/{id}",
  description: "Devuelve un pedido",
  tags: ["Pedidos"],
  requiresAuth: true,
  auth: {
    type: "bearer",
    label: "Bearer",
    detail: "Cabecera Authorization: Bearer con tu token.",
    keyName: "",
    in: "header",
  },
  pathParameters: [{ name: "id", type: "string", required: true, description: "El pedido", example: "42" }],
  query: [],
  headers: [{ name: "Accept", value: "application/json", masked: false }],
  body: null,
  examples: [],
  ...patch,
});

const page = (patch: Partial<DocPageView> = {}): DocPageView => ({
  title: "Pedidos",
  description: "La API de pedidos",
  intro: "",
  baseUrl: "https://api.ejemplo.com",
  groups: [{ tag: "Pedidos", endpoints: [endpoint()] }],
  counts: { endpoints: 1, documented: 1, examples: 0 },
  generatedAt: "2026-03-01T10:00:00.000Z",
  ...patch,
});

function draw() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={["/docs/AbCdEfGhIjKlMnOpQrStUv"]}>
        <Routes>
          <Route path="/docs/:publicId" element={<PublishedDocsPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const unauthorized = () =>
  new ApiError(401, {
    type: "https://endpoint-quality.dev/problems/doc-site-key-invalid",
    title: "Falta la clave",
    status: 401,
    detail: "Esta documentación es privada: manda la clave en la cabecera «x-api-key».",
  });

describe("la página publicada", () => {
  test("pinta los endpoints con su método, su ruta y sus parámetros", async () => {
    call.mockReset();
    call.mockResolvedValue(page());
    draw();
    await waitFor(() => expect(screen.getAllByText("/v1/pedidos/{id}").length).toBeGreaterThan(0));
    expect(screen.getByText("Devuelve un pedido")).toBeTruthy();
    expect(screen.getByText("Parámetros de ruta")).toBeTruthy();
    expect(screen.getByText(/1 rutas · 1 con descripción/)).toBeTruthy();
  });

  test("una privada pide la clave en vez de mandar a la pantalla de entrar", async () => {
    call.mockReset();
    call.mockRejectedValue(unauthorized());
    draw();
    // Quien abre el enlace no tiene cuenta aquí: mandarlo a `/login` sería un callejón sin salida.
    await waitFor(() => expect(screen.getByText("Esta documentación es privada")).toBeTruthy());
    expect(screen.getByLabelText("Clave")).toBeTruthy();
  });

  test("la clave escrita va en la cabecera x-api-key y no en la URL", async () => {
    call.mockReset();
    call.mockImplementation((path: string, options?: { headers?: Record<string, string> }) => {
      if (options?.headers?.["x-api-key"] === "la-clave") return Promise.resolve(page());
      return Promise.reject(unauthorized());
    });
    draw();

    await waitFor(() => expect(screen.getByLabelText("Clave")).toBeTruthy());
    fireEvent.change(screen.getByLabelText("Clave"), { target: { value: "la-clave" } });
    fireEvent.click(screen.getByRole("button", { name: "Entrar" }));

    await waitFor(() => expect(screen.getByText("La API de pedidos")).toBeTruthy());
    // Ninguna llamada llevó la clave pegada a la dirección.
    for (const [path] of call.mock.calls as [string][]) expect(path).not.toContain("la-clave");
  });

  test("no reintenta refrescar la sesión con un 401: cerraría la de quien esté dentro", async () => {
    call.mockReset();
    call.mockRejectedValue(unauthorized());
    draw();
    await waitFor(() => expect(screen.getByText("Esta documentación es privada")).toBeTruthy());
    for (const [, options] of call.mock.calls as [string, { retryOnUnauthorized?: boolean }][]) {
      expect(options.retryOnUnauthorized).toBe(false);
    }
  });

  test("una que no existe dice lo que dice el servidor, y no un 404 genérico", async () => {
    call.mockReset();
    call.mockRejectedValue(
      new ApiError(404, {
        type: "https://endpoint-quality.dev/problems/doc-site-disabled",
        title: "No publicada",
        status: 404,
        detail: "Esta documentación no está publicada ahora mismo",
      }),
    );
    draw();
    await waitFor(() => expect(screen.getByText("Aquí no hay documentación")).toBeTruthy());
    expect(screen.getByText(/no está publicada ahora mismo/)).toBeTruthy();
  });

  test("el código escribe la credencial como marcador, no con los ocho puntos", async () => {
    call.mockReset();
    call.mockResolvedValue(
      page({
        groups: [
          {
            tag: "Pedidos",
            endpoints: [
              endpoint({
                headers: [
                  { name: "Authorization", value: "••••••••", masked: true },
                  { name: "Accept", value: "application/json", masked: false },
                ],
              }),
            ],
          },
        ],
      }),
    );
    draw();
    await waitFor(() => expect(screen.getByText(/curl/)).toBeTruthy());
    const code = screen.getByText(/curl/).textContent ?? "";
    // Los ocho puntos se pegarían tal cual y darían un 401 que no se explica; el marcador se ve.
    expect(code).toContain("{{authorization}}");
    expect(code).not.toContain("••••••••");
    // Y se dice arriba qué queda por rellenar.
    expect(screen.getByText(/quedan sin sustituir/)).toBeTruthy();
  });

  test("una firma que el fragmento no puede calcular se dice, en vez de salir a medias", async () => {
    call.mockReset();
    call.mockResolvedValue(
      page({
        groups: [
          {
            tag: "Pedidos",
            endpoints: [
              endpoint({
                headers: [],
                auth: { type: "awsv4", label: "AWS Signature v4", detail: "Firma SigV4.", keyName: "", in: "header" },
              }),
            ],
          },
        ],
      }),
    );
    draw();
    // Sale dos veces y así tiene que ser: arriba del código, donde se lee, y comentada dentro del
    // fragmento, donde acaba quien lo pegue en un fichero sin haber leído la página.
    await waitFor(() => expect(screen.getAllByText(/la firma se calcula sobre la petición/).length).toBe(2));
  });

  test("los parámetros de consulta con valor entran en la URL del código", async () => {
    call.mockReset();
    call.mockResolvedValue(
      page({
        groups: [
          {
            tag: "Pedidos",
            endpoints: [
              endpoint({
                query: [{ name: "page", type: "number", required: false, description: "", example: "2" }],
              }),
            ],
          },
        ],
      }),
    );
    draw();
    await waitFor(() => expect(screen.getByText(/curl/)).toBeTruthy());
    expect(screen.getByText(/curl/).textContent).toContain("?page=2");
  });

  test("los cuerpos de ejemplo salen cuando vienen, con su estado", async () => {
    call.mockReset();
    call.mockResolvedValue(
      page({
        groups: [
          {
            tag: "Pedidos",
            endpoints: [
              endpoint({
                examples: [
                  {
                    name: "200 con el pedido",
                    status: 200,
                    contentType: "application/json",
                    body: '{"id":"42"}',
                    headers: [],
                  },
                ],
              }),
            ],
          },
        ],
        counts: { endpoints: 1, documented: 1, examples: 1 },
      }),
    );
    draw();
    await waitFor(() => expect(screen.getByText("Respuestas de ejemplo")).toBeTruthy());
    expect(screen.getByText(/200 con el pedido/)).toBeTruthy();
    expect(screen.getByText('{"id":"42"}')).toBeTruthy();
  });

  test("un campo tapado del cuerpo sale como marcador en el código, no con los ocho puntos", async () => {
    // Los ocho puntos se pegan tal cual y mandan ocho puntos por contraseña.
    expect(bodyWithPlaceholders('{"email":"ana@x.com","password":"••••••••"}', ["password"])).toContain(
      '"{{password}}"',
    );
    // Solo el campo que se tapó: unos puntos que alguien escribió a mano no son una credencial.
    expect(bodyWithPlaceholders('{"nota":"••••••••"}', ["password"])).not.toContain("{{");
    // Y lo que no parsea se deja como está, en vez de destrozarlo con una expresión regular.
    expect(bodyWithPlaceholders("<xml>••••••••</xml>", ["password"])).toBe("<xml>••••••••</xml>");
  });

  test("con una Authorization escrita a mano no se inventa un {{token}} que no sale en el código", async () => {
    call.mockReset();
    call.mockResolvedValue(
      page({
        groups: [
          {
            tag: "Pedidos",
            endpoints: [endpoint({ headers: [{ name: "Authorization", value: "••••••••", masked: true }] })],
          },
        ],
      }),
    );
    draw();
    await waitFor(() => expect(screen.getByText(/quedan sin sustituir/)).toBeTruthy());
    const note = screen.getByText(/quedan sin sustituir/).textContent ?? "";
    // La cabecera escrita gana, como en `authPlan`: el aviso nombra lo que se ve y nada más.
    expect(note).toContain("authorization");
    expect(note).not.toContain("token");
  });

  test("sin URL base lo dice, en vez de dar un código que no se puede pegar", async () => {
    call.mockReset();
    call.mockResolvedValue(page({ baseUrl: "" }));
    draw();
    await waitFor(() => expect(screen.getByText(/Sin URL base/)).toBeTruthy());
  });
});
