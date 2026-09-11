import { describe, expect, test } from "vitest";
import { applySuggestion, openTokenAt, suggestionsFor } from "@/lib/variable-suggestions";

/**
 * Dónde empieza el `{{` que se está escribiendo.
 *
 * Hacia atrás desde el cursor, que es lo único que funciona: un valor lleva más de un token muy a
 * menudo —`/{{tenant}}/pedidos/{{pedidoId}}`— y buscar hacia delante encuentra el primero en vez
 * del que se está escribiendo. El precio de equivocarse no es una lista fea: es completar sobre el
 * token de al lado y dejar la ruta rota sin que se vea.
 */
describe("el token que hay bajo el cursor", () => {
  test("un {{ recién abierto es un token sin nada escrito todavía", () => {
    expect(openTokenAt("{{", 2)).toEqual({ start: 0, query: "" });
  });

  test("lo escrito después del {{ es lo que hay que buscar", () => {
    expect(openTokenAt("/pedidos/{{ped", 14)).toEqual({ start: 9, query: "ped" });
  });

  test("con dos tokens, el que cuenta es el que tiene el cursor dentro", () => {
    const text = "/{{tenant}}/pedidos/{{ped";
    expect(openTokenAt(text, text.length)).toEqual({ start: 20, query: "ped" });
  });

  test("un token ya cerrado no se está escribiendo", () => {
    const text = "/{{tenant}}/pedidos";
    expect(openTokenAt(text, text.length)).toBeNull();
  });

  test("el cursor dentro de un token cerrado sí lo está: es lo que pasa al corregir un nombre", () => {
    expect(openTokenAt("{{tenant}}", 8)).toEqual({ start: 0, query: "tenant" });
  });

  test("un espacio o una llave dentro dicen que eso no es un nombre", () => {
    expect(openTokenAt("{{ no es", 8)).toBeNull();
    expect(openTokenAt("{{a{b", 5)).toBeNull();
  });

  test("sin ningún {{ no hay nada que sugerir", () => {
    expect(openTokenAt("/pedidos", 8)).toBeNull();
  });
});

/**
 * Qué nombres se ofrecen, y en qué orden.
 *
 * El prefijo va antes que la coincidencia por el medio porque el prefijo es lo que significa
 * escribir: después de `us`, `userId` tiene que salir antes que `previousUser`. Lo demás es
 * alfabético para que la lista no se reordene entre dos teclas que casan con el mismo conjunto.
 */
describe("los nombres que se ofrecen", () => {
  const names = ["previousUser", "userId", "userName", "tenant"];

  test("sin nada escrito se ofrecen todos", () => {
    expect(suggestionsFor(names, "")).toHaveLength(4);
  });

  test("el que empieza por lo escrito va antes que el que solo lo contiene", () => {
    expect(suggestionsFor(names, "us")).toEqual(["userId", "userName", "previousUser"]);
  });

  test("da igual cómo se escriban las mayúsculas: nadie las recuerda al buscar", () => {
    expect(suggestionsFor(names, "USERI")).toEqual(["userId"]);
  });

  test("la lista se corta, porque se dibuja encima del formulario", () => {
    expect(suggestionsFor(["a1", "a2", "a3", "a4"], "a", 2)).toHaveLength(2);
  });
});

/**
 * Lo que queda escrito al aceptar.
 *
 * El `}}` se añade solo si no estaba: quien vuelve sobre `{{userld}}` a corregir el nombre
 * acabaría si no con `{{userId}}}}`, que no interpola nada y parece un error suyo.
 */
describe("aceptar una sugerencia", () => {
  test("cierra el token y deja el cursor detrás", () => {
    expect(applySuggestion("/pedidos/{{ped", { start: 9, query: "ped" }, 14, "pedidoId")).toEqual({
      text: "/pedidos/{{pedidoId}}",
      caret: 21,
    });
  });

  test("no duplica el cierre cuando ya estaba", () => {
    expect(applySuggestion("{{userld}}", { start: 0, query: "userld" }, 8, "userId")).toEqual({
      text: "{{userId}}",
      caret: 10,
    });
  });

  test("lo que hay después del token se conserva", () => {
    expect(applySuggestion("{{ped/detalle", { start: 0, query: "ped" }, 5, "pedidoId").text).toBe(
      "{{pedidoId}}/detalle",
    );
  });
});
