/**
 * Las filas que alguien pega, leídas antes de que salga la petición.
 *
 * No en lugar de la comprobación del servidor —esa es la regla— sino para que el error señale la
 * fila en la que está. Una columna que no es un nombre de variable no es un detalle de formato:
 * `{{dataset.precio total}}` no es un token que el motor vaya a sustituir nunca, así que aceptarla
 * solo movería el descubrimiento a mitad de corrida, donde parece culpa del destino.
 */
import { describe, expect, test } from "vitest";
import { parseRows } from "@/components/datasets-panel";

describe("las filas de un conjunto de datos", () => {
  test("una lista de objetos de texto es lo que se espera", () => {
    const parsed = parseRows('[{ "nombre": "primera" }, { "nombre": "segunda" }]');
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.rows).toEqual([{ nombre: "primera" }, { nombre: "segunda" }]);
  });

  test("vacío es ninguna fila, no un error", () => {
    const parsed = parseRows("   ");
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.rows).toEqual([]);
  });

  test("un objeto suelto no es una tabla", () => {
    const parsed = parseRows('{ "nombre": "primera" }');
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error).toContain("lista de filas");
  });

  test("una columna que no es un nombre de variable se señala con su fila", () => {
    const parsed = parseRows('[{ "nombre": "a" }, { "precio total": "9" }]');
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error).toContain("Fila 2");
  });

  test("un valor que no es texto se rechaza aquí y no como un 422", () => {
    const parsed = parseRows('[{ "size": 7 }]');
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error).toContain("no es texto");
  });

  test("un JSON roto dice qué le pasa", () => {
    expect(parseRows("[{").ok).toBe(false);
  });
});
