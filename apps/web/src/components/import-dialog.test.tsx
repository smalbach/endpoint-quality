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

const dialog = (initial: { name: string; text: string }[], onImported = () => {}) =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <ImportDialog projectId="p" initial={initial} onClose={() => {}} onImported={onImported} />
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
    expect(screen.getByText("Va a endpoints, flujos.")).toBeTruthy();
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
        <ImportProvider projectId="p">
          <Screen />
        </ImportProvider>
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
