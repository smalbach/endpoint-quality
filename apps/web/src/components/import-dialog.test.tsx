/**
 * La puerta de import: lo que sueltas, nombrado al instante y sin preguntar al servidor.
 *
 * Es la mitad que separaba esto del import de Postman. Antes había que pulsar «Continuar», esperar
 * un viaje de red y luego «Importar», para saber lo que el fichero dice en su primera línea. Lo
 * que estas pruebas fijan:
 *
 * - La lista aparece **sin ninguna llamada**, y dice qué es cada cosa, qué trae dentro y a dónde va.
 * - Lo que no se puede leer se dice con algo que hacer y no bloquea al resto del lote.
 * - Se importa con **un** botón, y lo que se manda es lo que se soltó.
 * - Cmd+O abre desde cualquier parte, que es donde estaba el problema de «no veo dónde importar».
 */
import { describe, expect, test, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { ImportDialog } from "@/components/import-dialog";
import { ImportProvider, useImport } from "@/components/import-provider";

const call = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", async (original) => ({ ...(await original<object>()), api: call }));
vi.mock("@/lib/auth", () => ({ useOrganization: () => ({ id: "o", name: "Org" }), useCan: () => true }));

const collection = JSON.stringify({
  info: { name: "Tienda", schema: "https://schema.getpostman.com/json/collection/v2.1.0/collection.json" },
  item: [
    { name: "Alta", request: { method: "POST", url: "{{baseUrl}}/pedidos" } },
    { name: "Catálogo", item: [{ name: "Listar", request: { method: "GET", url: "{{baseUrl}}/productos" } }] },
  ],
});

// Con router, porque el resumen del import enlaza a los endpoints que acaba de crear.
const dialog = (initial: { name: string; text: string }[], onImported = () => {}, onClose = () => {}) =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter>
        <ImportDialog projectId="p" initial={initial} onClose={onClose} onImported={onImported} />
      </MemoryRouter>
    </QueryClientProvider>,
  );

describe("lo soltado se reconoce aquí mismo", () => {
  test("una colección se nombra, se cuenta y se dice a dónde va, sin llamar a nadie", () => {
    call.mockClear();
    dialog([{ name: "descarga(3).json", text: collection }]);

    // Por contenido y no por el nombre: el fichero se llama «descarga(3)» y la colección «Tienda».
    expect(screen.getByText("Tienda")).toBeTruthy();
    expect(screen.getByText("Colección de Postman")).toBeTruthy();
    expect(screen.getByText("2 peticiones · 1 carpeta")).toBeTruthy();
    expect(screen.getByText("Va a endpoints, una colección.")).toBeTruthy();
    expect(call).not.toHaveBeenCalled();
  });

  test("lo que no se puede leer se dice con algo que hacer, y el resto del lote sigue en pie", () => {
    dialog([
      { name: "vieja.json", text: JSON.stringify({ name: "Vieja", requests: [] }) },
      { name: "tienda.json", text: collection },
    ]);
    expect(screen.getByText(/expórtala como v2\.1/)).toBeTruthy();
    // Y se puede importar igual: el botón mira si hay algo legible, no si todo lo es.
    expect(screen.getByRole("button", { name: "Importar" }).hasAttribute("disabled")).toBe(false);
  });

  test("nada legible deja el botón apagado", () => {
    dialog([{ name: "notas.txt", text: "hola qué tal" }]);
    expect(screen.getByRole("button", { name: "Importar" }).hasAttribute("disabled")).toBe(true);
  });

  test("un entorno pide la URL base, porque la del fichero suele ser un localhost que no se alcanza", () => {
    const environment = JSON.stringify({ name: "local", values: [{ key: "baseUrl", value: "http://localhost:8000" }] });
    dialog([{ name: "local.json", text: environment }]);
    expect(screen.getByText(/URL base de los entornos/)).toBeTruthy();
  });

  test("se importa con un botón, y lo que se manda es lo que se soltó", async () => {
    call.mockClear();
    call.mockResolvedValue({ dryRun: false, items: [] });
    const imported = vi.fn();
    dialog([{ name: "tienda.json", text: collection }], imported);

    fireEvent.click(screen.getByRole("button", { name: "Importar" }));
    await waitFor(() => expect(imported).toHaveBeenCalled());
    expect(call).toHaveBeenCalledTimes(1);
    const [path, init] = call.mock.calls[0];
    expect(path).toBe("/orgs/o/projects/p/import");
    expect(init.body.sources).toEqual([{ name: "tienda.json", text: collection }]);
    // Sin `dryRun`: el plan ya está en pantalla y pedirlo otra vez era el viaje de red de más.
    expect(init.body.dryRun).toBeUndefined();
  });

  test("se puede quitar uno de los ficheros antes de importar", () => {
    dialog([
      { name: "tienda.json", text: collection },
      { name: "notas.txt", text: "hola" },
    ]);
    fireEvent.click(screen.getByLabelText("Quitar notas.txt"));
    expect(screen.queryByText("No reconocido")).toBeNull();
  });
});

describe("dónde está la puerta", () => {
  function Screen() {
    const { open } = useImport();
    return <button onClick={() => open()}>abrir a mano</button>;
  }

  const app = () =>
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <MemoryRouter>
          <ImportProvider projectId="p">
            <Screen />
          </ImportProvider>
        </MemoryRouter>
      </QueryClientProvider>,
    );

  test("Cmd+O la abre desde cualquier pantalla, el mismo atajo que Postman", async () => {
    app();
    expect(screen.queryByText("Importar")).toBeNull();
    fireEvent.keyDown(window, { key: "o", metaKey: true });
    await waitFor(() => expect(screen.getByRole("heading", { name: "Importar" })).toBeTruthy());
  });

  test("y cualquier pantalla puede abrirla sin montar su propio diálogo", async () => {
    app();
    fireEvent.click(screen.getByText("abrir a mano"));
    await waitFor(() => expect(screen.getByRole("heading", { name: "Importar" })).toBeTruthy());
  });
});

/**
 * Una URL que no es pública.
 *
 * Un contrato interno o una colección de un repositorio privado están detrás de un gateway, así
 * que «desde una URL» sin credencial servía sólo para lo que ya era público. Lo que se fija aquí
 * es que la credencial **viaja en el cuerpo de esa petición y en ningún otro sitio**: no se guarda
 * en el navegador, no queda en la caché de la consulta, y el diálogo se lleva el estado al cerrarse.
 */
describe("una URL con credencial", () => {
  const urlTab = () => fireEvent.click(screen.getByRole("button", { name: "Desde una URL" }));

  test("un bearer se manda con la URL, y hasta que lo hay no se puede importar", async () => {
    call.mockClear();
    call.mockResolvedValue({ dryRun: false, items: [] });
    dialog([]);
    urlTab();
    fireEvent.change(screen.getByPlaceholderText("https://api.ejemplo.com/openapi.json"), {
      target: { value: "https://privado.ejemplo.com/tienda.json" },
    });
    fireEvent.change(screen.getByLabelText("Autenticación de la URL"), { target: { value: "bearer" } });
    // Con la autenticación elegida y sin token, importar mandaría un «Bearer » vacío.
    expect(screen.getByRole("button", { name: "Importar" }).hasAttribute("disabled")).toBe(true);

    fireEvent.change(screen.getByLabelText("Token bearer"), { target: { value: "sk-secreto" } });
    fireEvent.click(screen.getByRole("button", { name: "Importar" }));
    await waitFor(() => expect(call).toHaveBeenCalled());
    expect(call.mock.calls[0][1].body).toEqual({
      url: "https://privado.ejemplo.com/tienda.json",
      urlAuth: { kind: "bearer", token: "sk-secreto" },
    });
  });

  test("una cabecera necesita sus dos partes, y se manda tal cual", async () => {
    call.mockClear();
    call.mockResolvedValue({ dryRun: false, items: [] });
    dialog([]);
    urlTab();
    fireEvent.change(screen.getByPlaceholderText("https://api.ejemplo.com/openapi.json"), {
      target: { value: "https://privado.ejemplo.com/openapi.json" },
    });
    fireEvent.change(screen.getByLabelText("Autenticación de la URL"), { target: { value: "header" } });
    fireEvent.change(screen.getByLabelText("Nombre de la cabecera"), { target: { value: "X-API-Key" } });
    expect(screen.getByRole("button", { name: "Importar" }).hasAttribute("disabled")).toBe(true);

    fireEvent.change(screen.getByLabelText("Valor de la cabecera"), { target: { value: "k-9" } });
    fireEvent.click(screen.getByRole("button", { name: "Importar" }));
    await waitFor(() => expect(call).toHaveBeenCalled());
    expect(call.mock.calls[0][1].body.urlAuth).toEqual({ kind: "header", name: "X-API-Key", value: "k-9" });
  });

  test("sin autenticación no se manda el campo, que es el caso normal", async () => {
    call.mockClear();
    call.mockResolvedValue({ dryRun: false, items: [] });
    dialog([]);
    urlTab();
    fireEvent.change(screen.getByPlaceholderText("https://api.ejemplo.com/openapi.json"), {
      target: { value: "https://api.ejemplo.com/openapi.json" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Importar" }));
    await waitFor(() => expect(call).toHaveBeenCalled());
    expect(call.mock.calls[0][1].body.urlAuth).toBeUndefined();
  });
});

/**
 * Y del resumen a lo importado.
 *
 * El final del camino que faltaba: «12 nuevos» y ahí se acababa, así que para ver uno había que
 * cerrar el diálogo e ir a buscarlo a la lista entre los que ya estaban.
 */
describe("el resumen lleva al endpoint que se acaba de crear", () => {
  const result = (endpoints: { id: string; method: string; path: string }[]) => ({
    dryRun: false,
    items: [
      {
        name: "Tienda",
        kind: "postman-collection",
        pieces: [],
        reason: null,
        results: [
          { target: "endpoints", name: "Tienda", summary: `${endpoints.length} nuevos`, error: null, endpoints },
        ],
      },
    ],
  });

  test("cada uno es un enlace a su editor, y al pulsarlo el diálogo se quita de en medio", async () => {
    call.mockClear();
    const closed = vi.fn();
    call.mockResolvedValue(result([{ id: "e1", method: "GET", path: "/things" }]));
    dialog([{ name: "tienda.json", text: collection }], () => {}, closed);

    fireEvent.click(screen.getByRole("button", { name: "Importar" }));
    const link = await waitFor(() => screen.getByRole("link", { name: "GET /things" }));
    expect(link.getAttribute("href")).toBe("/p/p/endpoints/e1");
    fireEvent.click(link);
    expect(closed).toHaveBeenCalled();
  });

  test("con muchos se enlazan los primeros y el resto va a la lista, que tiene buscador", async () => {
    call.mockClear();
    call.mockResolvedValue(
      result(Array.from({ length: 8 }, (_, index) => ({ id: `e${index}`, method: "GET", path: `/r${index}` }))),
    );
    dialog([{ name: "tienda.json", text: collection }]);

    fireEvent.click(screen.getByRole("button", { name: "Importar" }));
    await waitFor(() => expect(screen.getByRole("link", { name: "GET /r0" })).toBeTruthy());
    // Ocho enlaces uno debajo de otro son una pared que hay que leer para no encontrar nada.
    expect(screen.queryByRole("link", { name: "GET /r5" })).toBeNull();
    expect(screen.getByRole("link", { name: /y 3 más/ }).getAttribute("href")).toBe("/p/p");
  });
});
