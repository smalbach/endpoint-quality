/**
 * La pantalla de mocks.
 *
 * Lo que se comprueba es lo que decide algo y no lo que se pinta:
 *
 * - **No se puede crear sin elegir público o privado.** Es la única decisión de esta pantalla que no
 *   se deshace: una URL pública que ya circula sigue circulando aunque después se cambie. Si el
 *   botón se enciende con el nombre a secas, se publica sin decidirlo.
 * - **La URL lleva el prefijo de la API**, que en el despliegue normal es `/api` reescrito por
 *   nginx. Componerla con el origen de la pestaña a secas daría una URL que no contesta, y el fallo
 *   aparecería en el programa de otro.
 * - **La clave se enseña una vez y hay que cerrarla a mano.** Un toast se iría antes de copiarla, y
 *   no hay ningún sitio donde volver a mirarla.
 * - **La cobertura se dice antes**, porque un mock de un proyecto sin ejemplos contesta 501 a todo.
 * - **Las llamadas se piden al abrir el panel**, no al entrar en la pantalla, y cada fila dice el
 *   ejemplo que casó o **por qué no casó** — que es toda la razón de que esta pantalla exista.
 */
import { describe, expect, test, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";

import { MocksPage } from "@/routes/mocks";
import { ToastProvider } from "@/components/toast";
import type { MockCallListView, MockCallView, MockListView, MockServerView } from "@/lib/types";

const call = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", async (original) => ({
  ...(await original<object>()),
  api: call,
  // El origen de la pestaña no es el de la API: el prefijo se resuelve aquí en el programa real, y
  // la prueba comprueba que la pantalla lo usa en vez de componer la URL por su cuenta.
  absoluteApiUrl: (path: string) => `https://eq.test/api${path}`,
}));
vi.mock("@/lib/auth", () => ({ useOrganization: () => ({ id: "o", name: "Org" }), useCan: () => true }));

const mock = (patch: Partial<MockServerView> = {}): MockServerView => ({
  id: "m1",
  name: "el del front",
  publicId: "AbCdEfGhIjKlMnOpQrStUv",
  visibility: "public",
  apiKeyPreview: "",
  delay: { kind: "none" },
  enabled: true,
  createdAt: "2026-03-01T10:00:00.000Z",
  updatedAt: "2026-03-01T10:00:00.000Z",
  createdBy: "u1",
  archivedAt: null,
  deletedAt: null,
  ...patch,
});

const list = (patch: Partial<MockListView> = {}): MockListView => ({
  mocks: [mock()],
  coverage: { withExamples: 4, endpoints: 12 },
  prefix: "/mock",
  ...patch,
});

const served = (patch: Partial<MockCallView> = {}): MockCallView => ({
  id: "c1",
  at: "2026-03-01T10:00:00.000Z",
  method: "GET",
  path: "/v1/pedidos/42",
  status: 200,
  exampleId: "e1",
  exampleName: "el bueno",
  missCode: "",
  durationMs: 3,
  ...patch,
});

/** Contesta la lista de mocks o la bitácora según la ruta, que es lo que hace el programa real. */
function answering(rows: MockCallView[], listed: MockListView = list()) {
  call.mockReset();
  const log: MockCallListView = { calls: rows, keep: 200 };
  call.mockImplementation((path: string) => Promise.resolve(path.endsWith("/calls") ? log : listed));
}

function draw() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <ToastProvider>
        <MemoryRouter initialEntries={["/p/p1/mocks"]}>
          {/* Dentro de su ruta: `useParams` lee del `Route` que encaja, no de la URL, y sin él la
              consulta se queda apagada por falta de `projectId`. */}
          <Routes>
            <Route path="/p/:projectId/mocks" element={<MocksPage />} />
          </Routes>
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

describe("la pantalla de mocks", () => {
  test("la URL que se enseña lleva el prefijo de la API y no el origen de la pestaña", async () => {
    call.mockReset();
    call.mockResolvedValue(list());
    draw();
    await waitFor(() => expect(screen.getByText("https://eq.test/api/mock/AbCdEfGhIjKlMnOpQrStUv")).toBeTruthy());
  });

  test("dice cuántas rutas tienen ejemplo antes de que alguien apunte un front", async () => {
    call.mockReset();
    call.mockResolvedValue(list());
    draw();
    await waitFor(() => expect(screen.getByText("4")).toBeTruthy());
    expect(screen.getByText(/de 12 rutas tienen al menos/)).toBeTruthy();
  });

  test("sin ningún ejemplo lo dice claro, en vez de dejar crear una URL que contesta 501 a todo", async () => {
    call.mockReset();
    call.mockResolvedValue(list({ coverage: { withExamples: 0, endpoints: 12 }, mocks: [] }));
    draw();
    await waitFor(() => expect(screen.getByText(/contesta 501 a todo/)).toBeTruthy());
  });

  test("un mock público avisa de que la URL es lo único que lo protege", async () => {
    call.mockReset();
    call.mockResolvedValue(list());
    draw();
    await waitFor(() => expect(screen.getByText(/Lo único que la protege es que no se adivina/)).toBeTruthy());
  });

  test("un mock privado enseña el resumen de su clave y no la clave", async () => {
    call.mockReset();
    call.mockResolvedValue(list({ mocks: [mock({ visibility: "private", apiKeyPreview: "AbCdEf…9xYz" })] }));
    draw();
    await waitFor(() => expect(screen.getByText(/acaba en AbCdEf…9xYz/)).toBeTruthy());
  });

  test("no se puede crear sin elegir quién puede llamarlo", async () => {
    call.mockReset();
    call.mockResolvedValue(list({ mocks: [] }));
    draw();
    await waitFor(() => expect(screen.getByText("Crear un mock")).toBeTruthy());
    fireEvent.click(screen.getByText("Crear un mock"));

    const name = await screen.findByLabelText(/Nombre/);
    fireEvent.change(name, { target: { value: "el mío" } });

    const create = screen.getByRole("button", { name: "Crear" });
    // Con el nombre puesto y sin elegir: sigue apagado. Si esto se enciende, se publica sin decidir.
    expect(create.hasAttribute("disabled")).toBe(true);

    fireEvent.click(screen.getByRole("radio", { name: "Privado" }));
    expect(create.hasAttribute("disabled")).toBe(false);
  });

  test("un retardo mayor del máximo no deja crear, y dice el límite", async () => {
    call.mockReset();
    call.mockResolvedValue(list({ mocks: [] }));
    draw();
    await waitFor(() => expect(screen.getByText("Crear un mock")).toBeTruthy());
    fireEvent.click(screen.getByText("Crear un mock"));

    fireEvent.change(await screen.findByLabelText(/Nombre/), { target: { value: "lento" } });
    fireEvent.click(screen.getByRole("radio", { name: "Público" }));
    fireEvent.change(screen.getByLabelText(/Retardo simulado/), { target: { value: "60000" } });

    expect(screen.getByRole("button", { name: "Crear" }).hasAttribute("disabled")).toBe(true);
    expect(screen.getByText(/entre 0 y 5000/)).toBeTruthy();
  });

  test("crear uno privado enseña la clave en un aviso que hay que cerrar a mano", async () => {
    call.mockReset();
    call.mockImplementation((path: string, options?: { method?: string }) => {
      if (options?.method === "POST")
        return Promise.resolve({ mock: mock({ visibility: "private" }), apiKey: "la-clave-en-claro" });
      return Promise.resolve(list({ mocks: [] }));
    });
    draw();
    await waitFor(() => expect(screen.getByText("Crear un mock")).toBeTruthy());
    fireEvent.click(screen.getByText("Crear un mock"));
    fireEvent.change(await screen.findByLabelText(/Nombre/), { target: { value: "privado" } });
    fireEvent.click(screen.getByRole("radio", { name: "Privado" }));
    fireEvent.click(screen.getByRole("button", { name: "Crear" }));

    await waitFor(() => expect(screen.getByText("la-clave-en-claro")).toBeTruthy());
    // Y no se va sola: no hay ningún otro sitio donde volver a verla.
    expect(screen.getByRole("button", { name: "Ya la he guardado" })).toBeTruthy();
  });

  test("las llamadas no se piden hasta que se abre el panel de ese mock", async () => {
    // Un panel cerrado no pide nada: con diez mocks serían diez consultas que casi nadie mira.
    answering([served()]);
    draw();
    await waitFor(() => expect(screen.getByText("Llamadas")).toBeTruthy());
    expect(call.mock.calls.some((args: unknown[]) => String(args[0]).endsWith("/calls"))).toBe(false);

    fireEvent.click(screen.getByText("Llamadas"));
    await waitFor(() =>
      expect(call.mock.calls.some((args: unknown[]) => String(args[0]).endsWith("/calls"))).toBe(true),
    );
  });

  test("cada llamada dice la hora, el método, la ruta, el código y el ejemplo que casó", async () => {
    answering([served()]);
    draw();
    await waitFor(() => expect(screen.getByText("Llamadas")).toBeTruthy());
    fireEvent.click(screen.getByText("Llamadas"));

    await waitFor(() => expect(screen.getByText("/v1/pedidos/42")).toBeTruthy());
    expect(screen.getByText("GET")).toBeTruthy();
    expect(screen.getByText("200")).toBeTruthy();
    expect(screen.getByText(/«el bueno»/)).toBeTruthy();
    expect(screen.getByText("3 ms")).toBeTruthy();
  });

  test("una que no casó dice por qué, que es toda la razón de mirar esta lista", async () => {
    // El servidor guarda el código y la pantalla lo traduce: «404» a secas no distingue una ruta
    // mal escrita de una ruta declarada a la que nadie le ha guardado un ejemplo.
    answering([
      served({ id: "c1", status: 404, exampleId: null, exampleName: "", missCode: "mock-no-route" }),
      served({ id: "c2", status: 501, exampleId: null, exampleName: "", missCode: "mock-no-example" }),
      served({ id: "c3", status: 405, exampleId: null, exampleName: "", missCode: "mock-wrong-method" }),
    ]);
    draw();
    await waitFor(() => expect(screen.getByText("Llamadas")).toBeTruthy());
    fireEvent.click(screen.getByText("Llamadas"));

    await waitFor(() => expect(screen.getByText("esa ruta no la sirve")).toBeTruthy());
    expect(screen.getByText("la ruta no tiene ningún ejemplo guardado")).toBeTruthy();
    expect(screen.getByText("ese método no, en esa ruta")).toBeTruthy();
  });

  test("un motivo que la pantalla no conoce sale tal cual, en vez de desaparecer", async () => {
    answering([served({ status: 418, exampleId: null, exampleName: "", missCode: "mock-motivo-nuevo" })]);
    draw();
    await waitFor(() => expect(screen.getByText("Llamadas")).toBeTruthy());
    fireEvent.click(screen.getByText("Llamadas"));
    await waitFor(() => expect(screen.getByText("mock-motivo-nuevo")).toBeTruthy());
  });

  test("sin ninguna llamada lo dice, y dice qué significa que esté vacío", async () => {
    answering([]);
    draw();
    await waitFor(() => expect(screen.getByText("Llamadas")).toBeTruthy());
    fireEvent.click(screen.getByText("Llamadas"));
    await waitFor(() => expect(screen.getByText(/la petición no está saliendo/)).toBeTruthy());
  });

  test("el panel dice que del cuerpo y las cabeceras de quien llama no se guarda nada", async () => {
    // Quien abre esto esperando ver el cuerpo tiene que enterarse de por qué no está: la petición es
    // de un tercero y ahí van sus tokens.
    answering([served()]);
    draw();
    await waitFor(() => expect(screen.getByText("Llamadas")).toBeTruthy());
    fireEvent.click(screen.getByText("Llamadas"));
    await waitFor(() => expect(screen.getByText(/ni sus cabeceras, ni su cuerpo/)).toBeTruthy());
  });

  test("eliminar pide confirmación y dice que la URL deja de contestar para todo el mundo", async () => {
    call.mockReset();
    call.mockResolvedValue(list());
    draw();
    await waitFor(() => expect(screen.getByText("Eliminar")).toBeTruthy());
    fireEvent.click(screen.getByText("Eliminar"));
    await waitFor(() => expect(screen.getByText(/deja de contestar en el mismo momento/)).toBeTruthy());
    expect(screen.getByText(/Los ejemplos no se tocan/)).toBeTruthy();
  });
});
