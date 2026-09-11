import { describe, expect, test } from "vitest";
import { maskedHeaders, shellQuote, toCurl } from "@/lib/curl";

const request = (overrides: Partial<Parameters<typeof toCurl>[0]> = {}) => ({
  method: "GET",
  url: "http://localhost:9000/widgets",
  headers: { Accept: "application/json" },
  body: null,
  ...overrides,
});

/**
 * Lo que se pega en un terminal tiene que ejecutarse allí.
 *
 * El entrecomillado es la mitad del formato y la que se rompe en silencio: una URL con `&` que el
 * shell parte deja el comando corriendo en segundo plano y devolviendo otra cosa, y quien lo pegó
 * concluye que la API está mal. Por eso se citan siempre con comillas simples —dentro no se
 * interpreta nada— y la comilla simple se escapa cerrando y reabriendo, que es lo único que un
 * shell POSIX permite.
 */
describe("el entrecomillado", () => {
  test("una comilla simple se escapa cerrando y reabriendo", () => {
    // `'it'\''s'`: la cadena se cierra, se emite una comilla escapada y se vuelve a abrir.
    expect(shellQuote("it's")).toBe(`'it'\\''s'`);
  });

  test("dentro de comillas simples no hay nada que escapar", () => {
    expect(shellQuote("a&b $HOME `pwd`")).toBe("'a&b $HOME `pwd`'");
  });
});

/**
 * El comando entero.
 *
 * Multilínea porque acaba en un ticket y lo lee una persona: una cabecera por línea se puede
 * comparar y una línea de cuatrocientos caracteres no. Y ordenado, para que la misma petición
 * exportada dos veces sea el mismo texto.
 */
describe("la petición como cURL", () => {
  test("un GET no lleva --request: es lo que curl hace igualmente", () => {
    expect(toCurl(request())).toBe("curl 'http://localhost:9000/widgets' \\\n  --header 'Accept: application/json'");
  });

  test("cualquier otro método sí lo lleva", () => {
    expect(toCurl(request({ method: "DELETE" }))).toContain("curl --request DELETE ");
  });

  test("las cabeceras salen ordenadas, para que dos exportaciones se puedan comparar", () => {
    const built = toCurl(request({ headers: { "X-Tenant": "acme", Accept: "application/json" } }));
    expect(built.indexOf("Accept")).toBeLessThan(built.indexOf("X-Tenant"));
  });

  test("un cuerpo JSON se vuelve a serializar compacto: la sangría es del visor, no de lo enviado", () => {
    expect(toCurl(request({ method: "POST", body: { name: "a b" } }))).toContain(`--data '{"name":"a b"}'`);
  });

  test("un cuerpo de texto sale tal cual: es lo que cruzó el cable", () => {
    expect(toCurl(request({ method: "POST", body: "nombre=Ana+Ruiz" }))).toContain("--data 'nombre=Ana+Ruiz'");
  });

  test("sin cuerpo no hay --data, que no es lo mismo que un --data vacío", () => {
    expect(toCurl(request())).not.toContain("--data");
  });

  test("un cuerpo vacío a propósito sí lo lleva", () => {
    expect(toCurl(request({ method: "POST", body: {} }))).toContain("--data '{}'");
  });
});

/**
 * Qué líneas hay que rellenar antes de que el comando sirva.
 *
 * El valor vuelve enmascarado desde la API —la redacción ocurre antes de escribir la fila, y el
 * valor claro no llega al navegador—, así que lo honesto es nombrar las cabeceras afectadas en vez
 * de dejar que el 401 aparezca en el terminal de otro.
 */
describe("las cabeceras que vuelven enmascaradas", () => {
  test("se reconocen por el nombre, no por el valor", () => {
    // `••••••••` es un valor de cabecera perfectamente legal, así que mirarlo no sirve para
    // distinguir «esto venía censurado» de «esto es lo que alguien escribió».
    expect(maskedHeaders({ Authorization: "x", "X-Api-Key": "y", Accept: "application/json" })).toEqual([
      "Authorization",
      "X-Api-Key",
    ]);
  });

  test("una petición sin credencial no tiene ninguna", () => {
    expect(maskedHeaders({ Accept: "application/json" })).toEqual([]);
  });
});
