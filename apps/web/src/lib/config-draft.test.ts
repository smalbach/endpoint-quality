/**
 * Order is data in this configuration: budget and envelope rules match first-hit, so moving a row
 * changes which rule wins. That is the part of these editors worth asserting.
 */
import { describe, expect, test } from "vitest";

import { compact, move, removeAt, replaceAt, slugId, unchanged } from "./config-draft";

describe("mover una regla", () => {
  test("cambia el orden, que es el que decide cuál gana", () => {
    expect(move(["a", "b", "c"], 2, -1)).toEqual(["a", "c", "b"]);
    expect(move(["a", "b", "c"], 0, 1)).toEqual(["b", "a", "c"]);
  });

  test("y en los extremos no hace nada, en vez de perder la fila", () => {
    const rules = ["a", "b"];
    expect(move(rules, 0, -1)).toBe(rules);
    expect(move(rules, 1, 1)).toBe(rules);
  });

  test("no muta el original", () => {
    const rules = ["a", "b"];
    move(rules, 0, 1);
    expect(rules).toEqual(["a", "b"]);
  });
});

describe("editar la lista", () => {
  test("reemplazar y quitar dejan el resto intacto", () => {
    expect(replaceAt([1, 2, 3], 1, 9)).toEqual([1, 9, 3]);
    expect(removeAt([1, 2, 3], 1)).toEqual([1, 3]);
  });
});

describe("el id de una regla nueva", () => {
  test("sale de lo que escribió la persona, porque es lo que se lee en un caso fallido", () => {
    expect(slugId("Listado de tiendas", [])).toBe("listado-de-tiendas");
    expect(slugId("Búsqueda rápida", [])).toBe("busqueda-rapida");
  });

  test("no se repite", () => {
    expect(slugId("listado", ["listado"])).toBe("listado-2");
    expect(slugId("listado", ["listado", "listado-2"])).toBe("listado-3");
  });

  test("y siempre hay uno, aunque la etiqueta no dé ninguno", () => {
    expect(slugId("¿?", [])).toBe("regla");
  });
});

describe("compactar una regla antes de guardarla", () => {
  test("un opcional en blanco desaparece", () => {
    // `{ pathSuffix: "" }` no es la misma regla que una sin `pathSuffix`: la primera casa con
    // cualquier ruta que acabe en nada, que son todas, y el schema la acepta.
    expect(compact({ id: "x", thresholdMs: 300, pathSuffix: "", methods: [] })).toEqual({ id: "x", thresholdMs: 300 });
  });

  test("y un cero o un false sí se guardan", () => {
    expect(compact({ sendBody: false, count: 0 })).toEqual({ sendBody: false, count: 0 });
  });
});

describe("saber si hay algo que guardar", () => {
  test("compara el contenido y no la referencia", () => {
    expect(unchanged({ a: [1, 2] }, { a: [1, 2] })).toBe(true);
    expect(unchanged({ a: [1, 2] }, { a: [2, 1] })).toBe(false);
  });
});
