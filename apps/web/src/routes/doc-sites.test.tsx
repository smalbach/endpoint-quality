/**
 * La pantalla de documentación publicada.
 *
 * Lo que se comprueba es lo que decide algo:
 *
 * - **No se puede publicar sin elegir quién la lee.** Es la decisión que no se deshace: una URL que
 *   ya circula sigue circulando aunque después se cierre.
 * - **Los ejemplos empiezan apagados.** Publicar la forma de la API es una cosa y publicar sus datos
 *   es otra; si la casilla viniera marcada, se publicarían sin mirarla.
 * - **La URL base del proyecto no se rellena sola.** Hay que pulsar para copiarla, y así el valor
 *   que va a salir publicado se ve antes de salir.
 * - **La URL de la página es del navegador**, no de la API: es la que se le manda a una persona.
 * - **Se dice cuántas rutas tienen descripción antes de publicar**, porque sin ellas la página es
 *   una lista de paths.
 */
import { describe, expect, test, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";

import { DocSitesPage } from "@/routes/doc-sites";
import { ToastProvider } from "@/components/toast";
import type { DocSiteListView, DocSiteView } from "@/lib/types";

const call = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", async (original) => ({
  ...(await original<object>()),
  api: call,
}));
vi.mock("@/lib/auth", () => ({ useOrganization: () => ({ id: "o", name: "Org" }), useCan: () => true }));

const site = (patch: Partial<DocSiteView> = {}): DocSiteView => ({
  id: "d1",
  name: "la pública",
  publicId: "AbCdEfGhIjKlMnOpQrStUv",
  visibility: "public",
  apiKeyPreview: "",
  baseUrl: "https://api.ejemplo.com",
  intro: "",
  includeExamples: false,
  enabled: true,
  createdAt: "2026-03-01T10:00:00.000Z",
  updatedAt: "2026-03-01T10:00:00.000Z",
  createdBy: "u1",
  archivedAt: null,
  deletedAt: null,
  ...patch,
});

const list = (patch: Partial<DocSiteListView> = {}): DocSiteListView => ({
  sites: [site()],
  coverage: { endpoints: 12, described: 3, withExamples: 4 },
  prefix: "/docs",
  ...patch,
});

/** La lista, y el proyecto que la pantalla pide aparte para ofrecer su URL base. */
function answers(patch: Partial<DocSiteListView> = {}, projectBaseUrl = "https://api.proyecto.com") {
  call.mockReset();
  call.mockImplementation((path: string, options?: { method?: string }) => {
    if (options?.method === "POST") return Promise.resolve({ site: site(), apiKey: null });
    if (path.endsWith("/doc-sites")) return Promise.resolve(list(patch));
    return Promise.resolve({ name: "Pedidos", description: "", baseUrl: projectBaseUrl, tags: [] });
  });
}

function draw() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <ToastProvider>
        <MemoryRouter initialEntries={["/p/p1/doc-sites"]}>
          <Routes>
            <Route path="/p/:projectId/doc-sites" element={<DocSitesPage />} />
          </Routes>
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

describe("la pantalla de documentación", () => {
  test("la URL que se enseña es la de la página, en el origen del navegador", async () => {
    answers();
    draw();
    // La de la API —`/api/shared/docs/...`— la usa una máquina; esta es la que se le manda a alguien.
    await waitFor(() => expect(screen.getByText(`${window.location.origin}/docs/AbCdEfGhIjKlMnOpQrStUv`)).toBeTruthy());
  });

  test("dice cuántas rutas tienen descripción antes de publicar nada", async () => {
    answers();
    draw();
    await waitFor(() => expect(screen.getByText("3")).toBeTruthy());
    expect(screen.getByText(/de 12 rutas activas tienen/)).toBeTruthy();
  });

  test("sin ninguna descripción lo dice claro: la página sería una lista de paths", async () => {
    answers({ coverage: { endpoints: 12, described: 0, withExamples: 0 }, sites: [] });
    draw();
    await waitFor(() => expect(screen.getByText(/una lista de paths/)).toBeTruthy());
  });

  test("una pública avisa de que la URL es lo único que la protege, y del «noindex»", async () => {
    answers();
    draw();
    await waitFor(() => expect(screen.getByText(/Lo único que la protege es que no se adivina/)).toBeTruthy());
    expect(screen.getByText(/noindex/)).toBeTruthy();
  });

  test("una privada enseña el resumen de su clave y no la clave", async () => {
    answers({ sites: [site({ visibility: "private", apiKeyPreview: "AbCdEf…9xYz" })] });
    draw();
    await waitFor(() => expect(screen.getByText(/acaba en AbCdEf…9xYz/)).toBeTruthy());
  });

  test("sin URL base avisa de que el código de la página no se puede pegar", async () => {
    answers({ sites: [site({ baseUrl: "" })] });
    draw();
    await waitFor(() => expect(screen.getByText(/no se puede pegar tal cual/)).toBeTruthy());
  });

  test("no se puede publicar sin elegir quién la lee", async () => {
    answers({ sites: [] });
    draw();
    await waitFor(() => expect(screen.getByText("Publicar")).toBeTruthy());
    fireEvent.click(screen.getByText("Publicar"));
    // A partir de aquí hay dos «Publicar»: el de la cabecera y el del formulario. Las consultas van
    // dentro del diálogo, que es donde está la decisión.
    const dialog = within(await screen.findByRole("dialog"));

    fireEvent.change(dialog.getByLabelText(/Nombre/), { target: { value: "la mía" } });
    const publish = dialog.getByRole("button", { name: "Publicar" });
    // Con el nombre puesto y sin elegir: sigue apagado. Si esto se enciende, se publica sin decidir.
    expect(publish.hasAttribute("disabled")).toBe(true);

    fireEvent.click(dialog.getByRole("radio", { name: "Privada" }));
    expect(publish.hasAttribute("disabled")).toBe(false);
  });

  test("los ejemplos empiezan apagados, y dicen qué se publica si se encienden", async () => {
    answers({ sites: [] });
    draw();
    await waitFor(() => expect(screen.getByText("Publicar")).toBeTruthy());
    fireEvent.click(screen.getByText("Publicar"));
    // A partir de aquí hay dos «Publicar»: el de la cabecera y el del formulario. Las consultas van
    // dentro del diálogo, que es donde está la decisión.
    const dialog = within(await screen.findByRole("dialog"));

    const examples = dialog.getByLabelText("Incluir los cuerpos de ejemplo");
    expect((examples as HTMLInputElement).checked).toBe(false);
    expect(screen.getByText(/son datos reales/)).toBeTruthy();
  });

  test("una URL base con una variable no deja publicar", async () => {
    answers({ sites: [] });
    draw();
    await waitFor(() => expect(screen.getByText("Publicar")).toBeTruthy());
    fireEvent.click(screen.getByText("Publicar"));
    // A partir de aquí hay dos «Publicar»: el de la cabecera y el del formulario. Las consultas van
    // dentro del diálogo, que es donde está la decisión.
    const dialog = within(await screen.findByRole("dialog"));

    fireEvent.change(dialog.getByLabelText(/Nombre/), { target: { value: "con variable" } });
    fireEvent.click(dialog.getByRole("radio", { name: "Pública" }));
    fireEvent.change(dialog.getByLabelText(/URL base/), { target: { value: "{{baseUrl}}" } });

    expect(dialog.getByRole("button", { name: "Publicar" }).hasAttribute("disabled")).toBe(true);
    expect(screen.getByText(/empiece por http/)).toBeTruthy();
  });

  test("la URL base del proyecto no se rellena sola: hay que pulsar, y se ve el valor", async () => {
    answers({ sites: [] });
    draw();
    await waitFor(() => expect(screen.getByText("Publicar")).toBeTruthy());
    fireEvent.click(screen.getByText("Publicar"));
    // A partir de aquí hay dos «Publicar»: el de la cabecera y el del formulario. Las consultas van
    // dentro del diálogo, que es donde está la decisión.
    const dialog = within(await screen.findByRole("dialog"));

    const field = dialog.getByLabelText(/URL base/) as HTMLInputElement;
    expect(field.value).toBe("");
    // El botón dice cuál es antes de ponerla: así el valor que va a salir publicado se lee primero.
    const copy = dialog.getByText(/Usar la del proyecto: https:\/\/api\.proyecto\.com/);
    fireEvent.click(copy);
    expect(field.value).toBe("https://api.proyecto.com");
  });

  test("publicar una privada enseña la clave en un aviso que hay que cerrar a mano", async () => {
    call.mockReset();
    call.mockImplementation((path: string, options?: { method?: string }) => {
      if (options?.method === "POST")
        return Promise.resolve({ site: site({ visibility: "private" }), apiKey: "la-clave-en-claro" });
      if (path.endsWith("/doc-sites")) return Promise.resolve(list({ sites: [] }));
      return Promise.resolve({ name: "Pedidos", description: "", baseUrl: "", tags: [] });
    });
    draw();
    await waitFor(() => expect(screen.getByText("Publicar")).toBeTruthy());
    fireEvent.click(screen.getByText("Publicar"));
    // A partir de aquí hay dos «Publicar»: el de la cabecera y el del formulario. Las consultas van
    // dentro del diálogo, que es donde está la decisión.
    const dialog = within(await screen.findByRole("dialog"));
    fireEvent.change(dialog.getByLabelText(/Nombre/), { target: { value: "privada" } });
    fireEvent.click(dialog.getByRole("radio", { name: "Privada" }));
    fireEvent.click(dialog.getByRole("button", { name: "Publicar" }));

    await waitFor(() => expect(screen.getByText("la-clave-en-claro")).toBeTruthy());
    expect(screen.getByRole("button", { name: "Ya la he guardado" })).toBeTruthy();
  });

  test("eliminar dice que lo que ya se leyó sigue leído", async () => {
    answers();
    draw();
    await waitFor(() => expect(screen.getByText("Eliminar")).toBeTruthy());
    fireEvent.click(screen.getByText("Eliminar"));
    await waitFor(() => expect(screen.getByText(/deja de contestar en el mismo momento/)).toBeTruthy());
    expect(screen.getByText(/no se puede retirar de donde esté pegada/)).toBeTruthy();
  });
});
