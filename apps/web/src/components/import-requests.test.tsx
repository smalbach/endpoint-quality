import { describe, expect, test, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { ImportRequests } from "@/components/import-requests";
import { ApiError } from "@/lib/api";

const send = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", async (original) => ({ ...(await original<object>()), api: send }));

type Outcome = {
  imported: { id: string; name: string; operationId: string }[];
  skipped: { name: string; method: string; url: string; reason: string }[];
};

/**
 * El panel abierto y con la llamada sustituida, porque lo que se prueba no es la importación.
 *
 * El analizador ya tiene sus pruebas al otro lado, sin base de datos delante. Lo que esta pantalla
 * tiene que hacer bien es lo de después: enseñar el resultado de forma que se pueda actuar sobre
 * él, y no tocar lo pegado cuando todavía hace falta.
 */
async function open(outcome: Outcome | Error, settled: RegExp | string = /importad|sin importar/) {
  send.mockReset();
  if (outcome instanceof Error) send.mockRejectedValue(outcome);
  else send.mockResolvedValue(outcome);
  const imported = vi.fn();

  const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <ImportRequests base="/projects/uno" onImported={imported} />
    </QueryClientProvider>,
  );
  fireEvent.click(screen.getByText("Importar peticiones"));
  const box = screen.getByLabelText<HTMLTextAreaElement>("Lo que se importa");
  fireEvent.change(box, { target: { value: "curl https://api/widgets" } });
  fireEvent.click(screen.getByRole("button", { name: "Importar" }));
  // La respuesta llega por una mutación, así que hay un renderizado de por medio: sin esperar a
  // que el panel la haya dibujado, todo lo de debajo mira el estado anterior.
  await screen.findByText(settled);
  return { box, imported };
}

const done = (overrides: Partial<Outcome> = {}): Outcome => ({ imported: [], skipped: [], ...overrides });
const entry = (name: string) => ({ id: name, name, operationId: "listWidgets" });
const missed = (name: string, reason: string) => ({ name, method: "GET", url: "/x", reason });

/**
 * El resultado es una lista y no un número.
 *
 * «12 importadas, 4 no» no se puede accionar. Lo que hace útiles a las cuatro es su nombre y su
 * motivo: una colección con cuatro peticiones que el contrato no declara está vieja o es una lista
 * de endpoints sin documentar, y las dos cosas valen la pena antes de correr nada.
 */
describe("lo que el panel dice de una importación", () => {
  test("cada petición que entró se nombra con la operación sobre la que cayó", async () => {
    await open(done({ imported: [entry("Alta de pedido")] }));
    expect(screen.getByText("Alta de pedido")).toBeDefined();
    expect(screen.getByText("listWidgets")).toBeDefined();
  });

  test("cada una que no entró se nombra con su motivo, no se cuenta y ya", async () => {
    await open(done({ skipped: [missed("Cobro", "el contrato activo no declara POST /cobros")] }));
    expect(screen.getByText("Cobro")).toBeDefined();
    expect(screen.getByText(/no declara POST \/cobros/)).toBeDefined();
  });

  test("una sin nombre se dice igual: lo que no se puede es callarla", async () => {
    await open(done({ skipped: [missed("", "no se pudo leer")] }));
    expect(screen.getByText("Sin nombre")).toBeDefined();
  });

  test("una sola es «1 importada», en singular", async () => {
    await open(done({ imported: [entry("Alta")] }));
    expect(screen.getByText(/^1 importada/)).toBeDefined();
  });

  test("varias son «2 importadas»", async () => {
    await open(done({ imported: [entry("Alta"), entry("Baja")] }));
    expect(screen.getByText(/^2 importadas/)).toBeDefined();
  });
});

/**
 * Qué pasa con lo pegado después de darle a importar.
 *
 * Es la diferencia entre poder corregir y tener que volver a pegar. Lo que no encajó suele fallar
 * por una base que sobra en la URL, y esa corrección se hace sobre el mismo texto.
 */
describe("el texto pegado, después de importar", () => {
  test("se vacía cuando algo entró: ese texto ya está guardado como plantillas", async () => {
    const panel = await open(done({ imported: [entry("Alta")] }));
    expect(panel.box.value).toBe("");
    expect(panel.imported).toHaveBeenCalled();
  });

  test("se queda cuando no entró nada: es lo que hay que corregir", async () => {
    const panel = await open(done({ skipped: [missed("Cobro", "el contrato activo no declara POST /cobros")] }));
    expect(panel.box.value).toBe("curl https://api/widgets");
  });

  test("un error del servidor se dice con sus palabras y no se pierde lo pegado", async () => {
    // El caso real es «el proyecto todavía no tiene contrato importado», que no es un fallo de la
    // colección: sustituirlo por un «No se pudo importar» genérico mandaría a mirar donde no es.
    const detail = "El proyecto todavía no tiene contrato importado";
    const panel = await open(
      new ApiError(409, { type: "about:blank", title: "Conflict", status: 409, detail }),
      detail,
    );
    expect(screen.getByText(detail)).toBeDefined();
    expect(panel.box.value).toBe("curl https://api/widgets");
  });
});
