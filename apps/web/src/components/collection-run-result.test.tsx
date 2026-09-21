/**
 * Una petición del informe, abierta.
 *
 * Lo que se comprueba es lo que hacía falta para leer una corrida sin volver a lanzarla a mano: que
 * la URL que se enseña es la que salió y no la que estaba escrita, que el cuerpo de ida y el de
 * vuelta están, que un recorte se dice, y que cuando no hubo petición o no hubo respuesta la
 * pestaña lo explica en vez de quedarse en blanco.
 */
import { describe, expect, test, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

import { CollectionResultDetail } from "@/components/collection-run-result";
import type { CollectionRunResultView } from "@/lib/types";

const result = (patch: Partial<CollectionRunResultView> = {}): CollectionRunResultView => ({
  iteration: 1,
  itemId: "r1",
  name: "Crear producto",
  folder: "01 · Productos",
  method: "POST",
  url: "{{baseUrl}}/v1/products",
  status: 201,
  durationMs: 42,
  sizeBytes: 120,
  tests: [{ name: "crea", passed: true, message: null }],
  error: null,
  logs: [],
  sent: {
    method: "POST",
    url: "https://api.ejemplo.com/v1/products",
    headers: { Authorization: "Bearer ••••" },
    body: '{"sku":"A1"}',
    bodyTruncated: false,
  },
  received: {
    status: 201,
    headers: { "x-request-id": "abc" },
    body: '{"id":7}',
    bodyTruncated: false,
    sizeBytes: 120,
    durationMs: 42,
    timing: { dnsMs: 1, ttfbMs: 40, downloadMs: 1 },
  },
  auth: "Bearer del entorno «local»",
  cookies: { sent: ["sid=api/"], stored: ["sid"], rejected: [{ line: "a=b; Domain=otro", why: "otro dominio" }] },
  writes: [{ key: "product_id", value: "7" }],
  scripts: { pre: { error: null, durationMs: 3 }, post: { error: null, durationMs: 5 } },
  ...patch,
});

const tab = (name: string) => fireEvent.click(screen.getByRole("button", { name }));

describe("una petición de la corrida, abierta", () => {
  test("el resumen cuenta con qué credencial fue, qué cookies hubo y qué dejó escrito", () => {
    render(<CollectionResultDetail result={result()} />);

    expect(screen.getByText("Bearer del entorno «local»")).toBeTruthy();
    expect(screen.getByText("nombre 1 ms · espera 40 ms · descarga 1 ms")).toBeTruthy();
    expect(screen.getByText("corrió en 3 ms")).toBeTruthy();
    expect(screen.getByText("corrió en 5 ms")).toBeTruthy();
    expect(screen.getByText("sid=api/")).toBeTruthy();
    expect(screen.getByText("a=b; Domain=otro — otro dominio")).toBeTruthy();
    expect(screen.getByText("product_id = 7")).toBeTruthy();
    expect(screen.getByText("1/1")).toBeTruthy();
  });

  test("la petición enseña la URL que salió, y dice cuál estaba escrita", () => {
    render(<CollectionResultDetail result={result()} />);
    tab("Petición");

    expect(screen.getByText("POST https://api.ejemplo.com/v1/products")).toBeTruthy();
    expect(screen.getByText("Authorization: Bearer ••••")).toBeTruthy();
    expect(screen.getByText('{"sku":"A1"}')).toBeTruthy();
    expect(screen.getByText("Escrita en la colección: {{baseUrl}}/v1/products")).toBeTruthy();
  });

  test("la respuesta trae su estado, sus cabeceras y su cuerpo", () => {
    render(<CollectionResultDetail result={result()} />);
    tab("Respuesta");

    expect(screen.getByText("x-request-id: abc")).toBeTruthy();
    expect(screen.getByText('{"id":7}')).toBeTruthy();
  });

  test("un cuerpo recortado lo dice, y uno que no se guardó dice por qué", () => {
    const { unmount } = render(
      <CollectionResultDetail result={result({ received: { ...result().received!, bodyTruncated: true } })} />,
    );
    tab("Respuesta");
    expect(screen.getByText("recortado")).toBeTruthy();
    unmount();

    render(
      <CollectionResultDetail result={result({ received: { ...result().received!, body: "", bodyTruncated: true } })} />,
    );
    tab("Respuesta");
    expect(screen.getByText("no se guardó: la corrida pasó del tope")).toBeTruthy();
    expect(screen.getByText("La respuesta llegó sin cuerpo.")).toBeTruthy();
  });

  test("sin petición y sin respuesta, cada pestaña dice qué pasó", () => {
    render(
      <CollectionResultDetail
        result={result({
          sent: null,
          received: null,
          status: null,
          tests: [],
          error: "El entorno «local» no permite escrituras",
        })}
      />,
    );

    // El motivo va arriba, en cualquier pestaña: es lo que se busca al abrirla.
    expect(screen.getAllByText("El entorno «local» no permite escrituras").length).toBe(1);
    tab("Petición");
    expect(screen.getByText(/No salió ninguna petición/)).toBeTruthy();
    tab("Respuesta");
    expect(screen.getByText(/No hubo respuesta/)).toBeTruthy();
    tab("Tests");
    expect(screen.getByText("Esta petición no trae tests.")).toBeTruthy();
    tab("Consola");
    expect(screen.getByText("La consola quedó vacía.")).toBeTruthy();
  });

  test("cuando el fallo no tiene mensaje, se dice lo que se sabe", () => {
    render(<CollectionResultDetail result={result({ sent: null, received: null, status: null, error: null })} />);
    tab("Petición");
    expect(screen.getByText(/el envío se rechazó antes de mandarla/)).toBeTruthy();
    tab("Respuesta");
    expect(screen.getByText(/el destino no contestó/)).toBeTruthy();
  });

  test("una petición sin nada que contar no inventa filas en el resumen", () => {
    render(
      <CollectionResultDetail
        result={result({
          auth: "",
          cookies: { sent: [], stored: [], rejected: [] },
          writes: [],
          scripts: { pre: null, post: null },
          tests: [],
        })}
      />,
    );
    expect(screen.getByText("nada")).toBeTruthy();
    expect(screen.getByText("sin tests")).toBeTruthy();
    expect(screen.queryByText("Cookies presentadas")).toBeNull();
    expect(screen.queryByText("Script previo")).toBeNull();
  });

  test("un script que reventó se nombra con su error", () => {
    render(
      <CollectionResultDetail
        result={result({
          scripts: { pre: { error: "token is not defined", durationMs: 2 }, post: { error: "boom", durationMs: 1 } },
        })}
      />,
    );
    expect(screen.getByText("falló: token is not defined")).toBeTruthy();
    expect(screen.getByText("falló: boom")).toBeTruthy();
  });

  test("los tests y la consola salen con su cuenta en la pestaña", () => {
    render(
      <CollectionResultDetail
        result={result({
          tests: [
            { name: "crea", passed: true, message: null },
            { name: "devuelve el id", passed: false, message: "undefined" },
          ],
          logs: [{ level: "warn", text: "ojo" }],
        })}
      />,
    );
    tab("Tests (2)");
    expect(screen.getByText(/✓ crea/)).toBeTruthy();
    expect(screen.getByText(/✕ devuelve el id — undefined/)).toBeTruthy();
    tab("Consola (1)");
    expect(screen.getByText("[warn] ojo")).toBeTruthy();
  });

  test("la URL y los cuerpos se copian", () => {
    const writeText = vi.fn();
    Object.assign(navigator, { clipboard: { writeText } });
    render(<CollectionResultDetail result={result()} />);

    tab("Copiar la URL");
    expect(writeText).toHaveBeenCalledWith("https://api.ejemplo.com/v1/products");

    tab("Petición");
    fireEvent.click(screen.getAllByRole("button", { name: "Copiar" })[1]);
    expect(writeText).toHaveBeenCalledWith('{"sku":"A1"}');
  });

  test("sin lo que salió, se copia la URL escrita", () => {
    const writeText = vi.fn();
    Object.assign(navigator, { clipboard: { writeText } });
    render(<CollectionResultDetail result={result({ sent: null })} />);
    tab("Copiar la URL");
    expect(writeText).toHaveBeenCalledWith("{{baseUrl}}/v1/products");
  });

  test("un GET sin cuerpo lo dice en vez de enseñar un hueco", () => {
    render(
      <CollectionResultDetail
        result={result({ sent: { method: "GET", url: "{{baseUrl}}/v1/products", headers: {}, body: null, bodyTruncated: false } })}
      />,
    );
    tab("Petición");
    expect(screen.getByText("Esta petición no lleva cuerpo.")).toBeTruthy();
    // La URL que salió es la misma que la escrita: no hace falta repetirla debajo.
    expect(screen.queryByText(/Escrita en la colección/)).toBeNull();
  });
});
