/**
 * El resto de la puerta de import: fuera de un proyecto, los ficheros que llegan por el selector o
 * soltados, los `.zip`, el texto pegado, la captura, los errores del servidor y el resumen con sus
 * avisos. Y el arrastre global de `import-provider`, que es la otra mitad de «soltar en cualquier
 * parte».
 */
import { afterEach, describe, expect, test, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { ImportDialog, readDropped } from "@/components/import-dialog";
import { ImportProvider, useImport } from "@/components/import-provider";
import { ApiError } from "@/lib/api";

const call = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", async (original) => ({ ...(await original<object>()), api: call }));
vi.mock("@/lib/auth", () => ({ useOrganization: () => ({ id: "o", name: "Org" }), useCan: () => true }));

// El zip se lee con el lector de `@eq/import-detect`; aquí se decide qué contesta.
const readZip = vi.hoisted(() => vi.fn());
vi.mock("@eq/import-detect", async (original) => ({ ...(await original<object>()), readZip }));

// La captura tiene sus propias pruebas: aquí sólo importa lo que hace el diálogo con su resultado.
vi.mock("@/components/capture-traffic", () => ({
  CaptureTraffic: ({ projectId, onResult }: { projectId: string; onResult: (result: unknown) => void }) => (
    <button
      onClick={() =>
        onResult({
          dryRun: false,
          items: [
            {
              name: "captura",
              kind: "har",
              pieces: [{ kind: "har", name: "captura", detail: null, text: "" }],
              reason: null,
              results: [{ target: "endpoints", name: "captura", summary: "2 nuevos", error: null }],
            },
          ],
        })
      }
    >
      capturar en {projectId}
    </button>
  ),
}));

afterEach(() => {
  call.mockReset();
  readZip.mockReset();
});

const collection = JSON.stringify({
  info: { name: "Tienda", schema: "https://schema.getpostman.com/json/collection/v2.1.0/collection.json" },
  item: [{ name: "Alta", request: { method: "POST", url: "{{baseUrl}}/pedidos" } }],
});
const environment = JSON.stringify({ name: "local", values: [{ key: "baseUrl", value: "http://localhost" }] });

function dialog(props: Partial<Parameters<typeof ImportDialog>[0]> = {}) {
  const handlers = { onClose: vi.fn(), onImported: vi.fn() };
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter>
        <ImportDialog initial={[]} {...handlers} {...props} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return handlers;
}

/**
 * Un fichero como los que da el navegador. El `Blob` de jsdom no tiene `arrayBuffer`, que es con
 * lo que se miran los cuatro primeros bytes para saber si es un zip.
 */
function file(name: string, text: string): File {
  const bytes = new TextEncoder().encode(text);
  return {
    name,
    text: async () => text,
    arrayBuffer: async () => bytes.buffer,
    slice: (start: number, end: number) => ({ arrayBuffer: async () => bytes.slice(start, end).buffer }),
  } as unknown as File;
}

const importButton = () => screen.getByRole("button", { name: "Importar" });

describe("leer lo soltado", () => {
  test("un fichero de texto se lee tal cual", async () => {
    expect(await readDropped([file("notas.txt", "hola")])).toEqual([{ name: "notas.txt", text: "hola" }]);
  });

  test("un .zip se abre y da sus ficheros", async () => {
    readZip.mockResolvedValue([{ name: "dentro.json", text: "{}" }]);
    expect(await readDropped([file("export.zip", "x")])).toEqual([{ name: "dentro.json", text: "{}" }]);
  });

  test("un .zip sin nada de texto dentro lo dice", async () => {
    readZip.mockResolvedValue([]);
    const [entry] = await readDropped([file("vacio.zip", "x")]);
    expect(entry.reason).toMatch(/no trae ningún fichero de texto/);
  });

  test("un .zip roto dice por qué, con detalle o sin él", async () => {
    readZip.mockRejectedValueOnce(new Error("cabecera mala"));
    readZip.mockRejectedValueOnce("raro");
    const [first] = await readDropped([file("roto.zip", "x")]);
    const [second] = await readDropped([file("otro.zip", "x")]);
    expect(first.reason).toBe("no se pudo abrir el .zip: cabecera mala");
    expect(second.reason).toBe("no se pudo abrir el .zip: sin detalle");
  });
});

describe("fuera de un proyecto", () => {
  test("pregunta a cuál, elige el primero y deja cambiarlo", async () => {
    call.mockImplementation(async (path: string) =>
      path === "/orgs/o/projects"
        ? [
            { id: "p1", name: "Uno" },
            { id: "p2", name: "Dos" },
          ]
        : { dryRun: false, items: [] },
    );
    const handlers = dialog({ initial: [{ name: "t.json", text: collection }] });
    const select = screen.getByRole("combobox") as HTMLSelectElement;
    expect(screen.getByRole("option", { name: "…" })).toBeDefined();
    await waitFor(() => expect(select.value).toBe("p1"));
    fireEvent.change(select, { target: { value: "p2" } });
    fireEvent.click(importButton());
    await waitFor(() => expect(handlers.onImported).toHaveBeenCalled());
    expect(call).toHaveBeenLastCalledWith("/orgs/o/projects/p2/import", expect.anything());
  });

  test("sin proyectos no hay a dónde importar, ni se puede capturar", async () => {
    call.mockResolvedValue([]);
    dialog({ initial: [{ name: "t.json", text: collection }] });
    await waitFor(() => expect(screen.getByRole("option", { name: "No hay proyectos" })).toBeDefined());
    expect(importButton().hasAttribute("disabled")).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Capturar tráfico" }));
    expect(screen.queryByText(/capturar en/)).toBeNull();
  });
});

describe("elegir y soltar ficheros", () => {
  test("el selector de ficheros y el de carpeta añaden sin repetir nombres", async () => {
    const clicked = vi.spyOn(HTMLInputElement.prototype, "click").mockImplementation(() => {});
    dialog({ projectId: "p", initial: [{ name: "t.json", text: collection }] });
    fireEvent.click(screen.getByText("Elegir ficheros"));
    fireEvent.click(screen.getByText("Elegir una carpeta"));
    expect(clicked).toHaveBeenCalledTimes(2);
    clicked.mockRestore();

    fireEvent.change(screen.getByLabelText("Ficheros a importar"), {
      target: { files: [file("t.json", collection), file("local.json", environment)] },
    });
    await waitFor(() => expect(screen.getByText("local")).toBeDefined());
    expect(screen.getAllByText("Tienda")).toHaveLength(1);

    fireEvent.change(screen.getByLabelText("Carpeta a importar"), {
      target: { files: [file("c.sh", "curl https://a.b/c")] },
    });
    await waitFor(() => expect(screen.getByText("Comandos cURL")).toBeDefined());
  });

  test("soltar ficheros encima del diálogo los añade y vuelve a la pestaña de ficheros", async () => {
    dialog({ projectId: "p" });
    fireEvent.click(screen.getByRole("button", { name: "Texto sin formato" }));
    const zone = screen.getByRole("button", { name: "Ficheros" }).parentElement!.parentElement!;
    fireEvent.dragOver(zone);
    fireEvent.dragLeave(zone);
    fireEvent.drop(zone, { dataTransfer: { files: [] } });
    expect(screen.getByText(/Arrastra aquí la colección/)).toBeDefined();
    fireEvent.dragOver(zone);
    expect(screen.getByText(/Arrastra aquí/).parentElement!.className).toContain("border-slate-900");
    fireEvent.drop(zone, { dataTransfer: { files: [file("t.json", collection)] } });
    await waitFor(() => expect(screen.getByText("Tienda")).toBeDefined());
  });

  test("un .zip ilegible no se manda, y la URL base de los entornos sí", async () => {
    call.mockResolvedValue({ dryRun: false, items: [] });
    const handlers = dialog({
      projectId: "p",
      initial: [
        { name: "roto.zip", text: "", reason: "no se pudo abrir el .zip: x" },
        { name: "local.json", text: environment },
      ],
    });
    expect(screen.getByText("no se pudo abrir el .zip: x")).toBeDefined();
    fireEvent.change(screen.getByPlaceholderText("http://host.docker.internal:8000"), {
      target: { value: " http://api:8000 " },
    });
    fireEvent.click(importButton());
    await waitFor(() => expect(handlers.onImported).toHaveBeenCalled());
    expect(call.mock.calls[0][1].body).toEqual({
      sources: [{ name: "local.json", text: environment }],
      baseUrl: "http://api:8000",
    });
  });

  test("un volcado de Postman enseña de qué tipo es cada pieza", () => {
    dialog({
      projectId: "p",
      initial: [
        {
          name: "dump.json",
          text: JSON.stringify({ collections: [JSON.parse(collection)], environments: [JSON.parse(environment)] }),
        },
      ],
    });
    expect(screen.getByText("Volcado de Postman")).toBeDefined();
    expect(screen.getByText("Entorno de Postman")).toBeDefined();
    expect(screen.getByText("Colección de Postman")).toBeDefined();
  });
});

describe("texto pegado", () => {
  test("se reconoce sin nombre de fichero ni botón de quitar, y se manda como fuente", async () => {
    let finish: (value: unknown) => void = () => {};
    call.mockReturnValue(new Promise((resolve) => (finish = resolve)));
    const handlers = dialog({ projectId: "p" });
    fireEvent.click(screen.getByRole("button", { name: "Texto sin formato" }));
    expect(importButton().hasAttribute("disabled")).toBe(true);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: collection } });
    expect(screen.getByText("Tienda")).toBeDefined();
    expect(screen.queryByLabelText("Quitar Tienda")).toBeNull();
    fireEvent.click(importButton());
    await waitFor(() => expect(screen.getByRole("button", { name: "Importando…" })).toBeDefined());
    expect(call.mock.calls[0][1].body).toEqual({ sources: [{ name: "", text: collection }] });
    await act(async () => finish({ dryRun: false, items: [] }));
    await waitFor(() => expect(screen.getByText("Cerrar")).toBeDefined());
    expect(handlers.onImported).toHaveBeenCalled();
  });
});

describe("cuando el servidor dice que no", () => {
  test("un error del API se cuenta con sus campos", async () => {
    call.mockRejectedValue(
      new ApiError(422, {
        type: "about:blank",
        title: "No válido",
        status: 422,
        detail: "El fichero no vale",
        errors: [{ field: "sources", detail: "falta el nombre" }],
      }),
    );
    dialog({ projectId: "p", initial: [{ name: "t.json", text: collection }] });
    fireEvent.click(importButton());
    await waitFor(() => expect(screen.getByText("El fichero no vale")).toBeDefined());
    expect(screen.getByText("falta el nombre")).toBeDefined();
  });

  test("cualquier otro fallo dice que no se pudo", async () => {
    call.mockRejectedValue(new Error("red caída"));
    dialog({ projectId: "p", initial: [{ name: "t.json", text: collection }] });
    fireEvent.click(importButton());
    await waitFor(() => expect(screen.getByText("No se pudo importar")).toBeDefined());
  });
});

describe("el resumen", () => {
  test("marca lo ilegible, los errores por destino y las notas", async () => {
    call.mockResolvedValue({
      dryRun: false,
      items: [
        { name: "raro.txt", kind: "unknown", pieces: [], reason: "no sé qué es", results: [] },
        {
          name: "Tienda",
          kind: "postman-collection",
          pieces: [],
          reason: null,
          results: [
            { target: "flows", name: "Tienda", summary: "", error: "no cabe", notes: [] },
            {
              target: "endpoints",
              name: "Tienda",
              summary: "1 nuevo",
              error: null,
              notes: ["se ignoró un script"],
              endpoints: [],
            },
          ],
        },
      ],
    });
    dialog({ projectId: "p", initial: [{ name: "t.json", text: collection }] });
    fireEvent.click(importButton());
    await waitFor(() => expect(screen.getByText("Esto es lo que se hizo:")).toBeDefined());
    expect(screen.getByText("no sé qué es")).toBeDefined();
    expect(screen.getByText("No reconocido").className).toContain("amber");
    expect(screen.getByText(/no cabe/).className).toContain("rose");
    expect(screen.getByText("se ignoró un script")).toBeDefined();
  });

  /**
   * Una colección importada se abre desde el propio resumen, que es el paso que el import venía a
   * quitar: contar «entró una colección» y dejar a la persona buscándola no vale de nada.
   */
  test("una colección importada se abre desde el resumen, y el enlace cierra el diálogo", async () => {
    call.mockResolvedValue({
      dryRun: false,
      items: [
        {
          name: "Tienda",
          kind: "postman-collection",
          pieces: [],
          reason: null,
          results: [
            { target: "collections", name: "Tienda", summary: "12 peticiones", error: null, collectionId: "c1" },
          ],
        },
      ],
    });
    const handlers = dialog({ projectId: "p", initial: [{ name: "t.json", text: collection }] });
    fireEvent.click(importButton());
    const link = await screen.findByRole("link", { name: "Abrir la colección" });
    expect(link.getAttribute("href")).toBe("/p/p/collections/c1");
    fireEvent.click(link);
    expect(handlers.onClose).toHaveBeenCalled();
  });
});

/**
 * La puerta acotada: la misma, abierta desde una pantalla que manda un solo destino.
 *
 * Lo que se comprueba es la promesa que hace su título: que **sólo entran entornos**. Un volcado
 * entra por sus entornos y deja fuera sus colecciones, un OpenAPI no entra en absoluto, y las dos
 * vías que no se pueden leer aquí —una URL, la captura— ni se ofrecen.
 */
describe("importar acotado a los entornos", () => {
  const dump = JSON.stringify({
    collections: [JSON.parse(collection)],
    environments: [JSON.parse(environment)],
  });

  test("se llama por su destino y no ofrece las vías que este lado no puede leer", () => {
    dialog({ projectId: "p", only: "environment" });
    expect(screen.getByRole("dialog", { name: "Importar entornos" })).toBeDefined();
    expect(screen.queryByRole("button", { name: "Desde una URL" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Capturar tráfico" })).toBeNull();
  });

  test("un volcado entra sólo por sus entornos, y eso es lo único que cruza la red", async () => {
    call.mockResolvedValue({ dryRun: false, items: [] });
    const handlers = dialog({ projectId: "p", only: "environment", initial: [{ name: "dump.json", text: dump }] });
    expect(screen.getByText("Va a un entorno.")).toBeDefined();
    expect(screen.queryByText(/Va a endpoints/)).toBeNull();

    fireEvent.click(importButton());
    await waitFor(() => expect(handlers.onImported).toHaveBeenCalled());
    expect(call).toHaveBeenLastCalledWith("/orgs/o/projects/p/import", {
      method: "POST",
      body: { sources: [{ name: "local", text: JSON.stringify(JSON.parse(environment)) }] },
    });
  });

  test("un entorno pegado entra tal cual por la pestaña de texto", async () => {
    call.mockResolvedValue({ dryRun: false, items: [] });
    const handlers = dialog({ projectId: "p", only: "environment" });
    fireEvent.click(screen.getByRole("button", { name: "Texto sin formato" }));
    expect(screen.getByText("El JSON del entorno, tal como lo exporta Postman.")).toBeDefined();
    fireEvent.change(screen.getByRole("textbox"), { target: { value: environment } });

    fireEvent.click(importButton());
    await waitFor(() => expect(handlers.onImported).toHaveBeenCalled());
    expect(call).toHaveBeenLastCalledWith("/orgs/o/projects/p/import", {
      method: "POST",
      body: { sources: [{ name: "local", text: JSON.stringify(JSON.parse(environment)) }] },
    });
  });

  test("lo que no trae ningún entorno lo dice y no deja importar", () => {
    dialog({ projectId: "p", only: "environment", initial: [{ name: "t.json", text: collection }] });
    expect(screen.getByText("no trae un entorno: aquí sólo entran entornos")).toBeDefined();
    expect(importButton().hasAttribute("disabled")).toBe(true);
  });
});

describe("capturar tráfico", () => {
  test("lo capturado acaba en el mismo resumen y cuenta como importado", () => {
    const handlers = dialog({ projectId: "p" });
    fireEvent.click(screen.getByRole("button", { name: "Capturar tráfico" }));
    expect(screen.queryByRole("button", { name: "Importar" })).toBeNull();
    fireEvent.click(screen.getByText("capturar en p"));
    expect(handlers.onImported).toHaveBeenCalled();
    expect(screen.getByText(/2 nuevos/)).toBeDefined();
    fireEvent.click(screen.getByText("Cerrar"));
    expect(handlers.onClose).toHaveBeenCalled();
  });
});

describe("el proveedor de import", () => {
  function Opener() {
    const { open } = useImport();
    return <button onClick={() => open()}>abrir</button>;
  }

  const app = () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const invalidate = vi.spyOn(client, "invalidateQueries");
    render(
      <QueryClientProvider client={client}>
        <MemoryRouter>
          <ImportProvider projectId="p">
            <Opener />
          </ImportProvider>
        </MemoryRouter>
      </QueryClientProvider>,
    );
    return invalidate;
  };

  const files = (list: File[] = []) => ({ dataTransfer: { types: ["Files"], files: list } });

  test("fuera del proveedor, useImport revienta en vez de no hacer nada", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => render(<Opener />)).toThrow("useImport fuera de <ImportProvider>");
  });

  test("sólo Cmd+O o Ctrl+O sin mayúsculas abre el diálogo, y se cierra", () => {
    app();
    fireEvent.keyDown(window, { key: "p", metaKey: true });
    fireEvent.keyDown(window, { key: "o" });
    fireEvent.keyDown(window, { key: "O", ctrlKey: true, shiftKey: true });
    expect(screen.queryByRole("heading", { name: "Importar" })).toBeNull();
    fireEvent.keyDown(window, { key: "O", ctrlKey: true });
    expect(screen.getByRole("heading", { name: "Importar" })).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Cancelar" }));
    expect(screen.queryByRole("heading", { name: "Importar" })).toBeNull();
  });

  test("arrastrar ficheros por la ventana enseña el aviso, contando entradas y salidas", () => {
    app();
    // Arrastrar algo que no son ficheros (un texto seleccionado) no avisa de nada.
    fireEvent.dragEnter(window, { dataTransfer: { types: ["text/plain"] } });
    fireEvent.dragEnter(window);
    expect(screen.queryByText("Suelta para importar")).toBeNull();

    fireEvent.dragEnter(window, files());
    fireEvent.dragEnter(window, files());
    expect(screen.getByText("Suelta para importar")).toBeDefined();
    fireEvent.dragLeave(window, files());
    expect(screen.getByText("Suelta para importar")).toBeDefined();
    fireEvent.dragLeave(window, { dataTransfer: { types: ["text/plain"] } });
    fireEvent.dragLeave(window, files());
    expect(screen.queryByText("Suelta para importar")).toBeNull();
  });

  test("dragover con ficheros evita que el navegador abra el fichero; sin ficheros no toca nada", () => {
    app();
    expect(fireEvent.dragOver(window, files())).toBe(false);
    expect(fireEvent.dragOver(window, { dataTransfer: { types: [] } })).toBe(true);
  });

  test("soltar ficheros abre el diálogo con ellos; soltar nada o no-ficheros, no", async () => {
    const invalidate = app();
    fireEvent.drop(window, { dataTransfer: { types: ["text/plain"] } });
    fireEvent.dragEnter(window, files());
    fireEvent.drop(window, files());
    expect(screen.queryByText("Suelta para importar")).toBeNull();
    expect(screen.queryByRole("heading", { name: "Importar" })).toBeNull();

    fireEvent.drop(window, { dataTransfer: { types: ["Files"] } });
    expect(screen.queryByRole("heading", { name: "Importar" })).toBeNull();

    fireEvent.drop(window, files([file("t.json", collection)]));
    await waitFor(() => expect(screen.getByText("Tienda")).toBeDefined());

    call.mockResolvedValue({ dryRun: false, items: [] });
    fireEvent.click(importButton());
    await waitFor(() => expect(invalidate).toHaveBeenCalled());
  });
});
