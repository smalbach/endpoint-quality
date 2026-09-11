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

/**
 * El CSV que sale de una hoja de cálculo.
 *
 * Cuarenta filas no se escriben como objetos: se copian de una hoja, y lo que se copia trae la
 * coma o el punto y coma del idioma del que exportó, comillas en cuanto un valor lleva una coma, y
 * «\r\n» si viene de Windows. Aceptar solo JSON no era una regla, era pedirle a alguien que
 * convirtiera a mano lo que ya tenía delante.
 *
 * Lo que aquí se decide es que nada se adivina en silencio: el separador se cuenta en la cabecera,
 * una columna que no es un nombre de variable se nombra, y una fila descuadrada es un error con su
 * número de línea en lugar de una fila rellenada a la que le falte un dato.
 */
describe("las filas pegadas como CSV", () => {
  test("la primera línea son las columnas y las demás las filas", () => {
    const parsed = parseRows("nombre,precio\nprimera,9\nsegunda,10");
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.rows).toEqual([
        { nombre: "primera", precio: "9" },
        { nombre: "segunda", precio: "10" },
      ]);
    }
  });

  test("un valor entre comillas puede llevar la coma que separa a los demás", () => {
    const parsed = parseRows('nombre,direccion\nprimera,"Calle Mayor, 3"');
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.rows).toEqual([{ nombre: "primera", direccion: "Calle Mayor, 3" }]);
  });

  test("una comilla dentro de un valor se escribe dos veces", () => {
    const parsed = parseRows('nombre,apodo\nprimera,"la ""única"""');
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.rows).toEqual([{ nombre: "primera", apodo: 'la "única"' }]);
  });

  test("un salto de línea entre comillas es parte del valor, no otra fila", () => {
    const parsed = parseRows('nombre,nota\nprimera,"dos\nlíneas"\nsegunda,una');
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.rows).toEqual([
        { nombre: "primera", nota: "dos\nlíneas" },
        { nombre: "segunda", nota: "una" },
      ]);
    }
  });

  test("el punto y coma de una hoja en español también separa", () => {
    const parsed = parseRows("nombre;precio\nprimera;9,90");
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.rows).toEqual([{ nombre: "primera", precio: "9,90" }]);
  });

  test("el separador lo decide la cabecera, no las comas que haya en los valores", () => {
    const parsed = parseRows("nombre;direccion\nprimera;Calle Mayor, 3, bajo");
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.rows).toEqual([{ nombre: "primera", direccion: "Calle Mayor, 3, bajo" }]);
  });

  test("los saltos de Windows y las líneas vacías del final no son filas", () => {
    const parsed = parseRows("nombre,precio\r\nprimera,9\r\nsegunda,10\r\n\r\n");
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.rows).toEqual([
        { nombre: "primera", precio: "9" },
        { nombre: "segunda", precio: "10" },
      ]);
    }
  });

  test("los espacios alrededor de un nombre de columna no son parte del nombre", () => {
    const parsed = parseRows(" nombre , precio \nprimera,9");
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.rows).toEqual([{ nombre: "primera", precio: "9" }]);
  });

  test("una columna que no es un nombre de variable se nombra", () => {
    const parsed = parseRows("nombre,precio total\nprimera,9");
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.error).toContain("precio total");
      expect(parsed.error).toContain("Línea 1");
    }
  });

  test("una fila con menos campos de los debidos dice en qué línea está", () => {
    const parsed = parseRows("nombre,precio\nprimera,9\nsegunda");
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error).toContain("Línea 3");
  });

  test("una fila con más campos de los debidos tampoco se recorta", () => {
    const parsed = parseRows("nombre,precio\nprimera,9,de más");
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error).toContain("Línea 2");
  });

  test("una comilla sin cerrar se dice, no se adivina dónde acaba", () => {
    const parsed = parseRows('nombre,nota\nprimera,"sin cerrar');
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error).toContain("Línea 2");
  });

  test("un número sigue siendo texto, porque es lo que se sustituye en la petición", () => {
    const parsed = parseRows("codigo,activo\n007,true");
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.rows).toEqual([{ codigo: "007", activo: "true" }]);
  });

  test("una cabecera sola son cero filas, no un error", () => {
    const parsed = parseRows("nombre,precio");
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.rows).toEqual([]);
  });

  test("una columna repetida se dice antes de que una tape a la otra", () => {
    const parsed = parseRows("nombre,nombre\nprimera,segunda");
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error).toContain("dos veces");
  });
});

/**
 * Qué formato es, decidido por el primer carácter.
 *
 * Nadie elige el formato en un desplegable: se pega lo que se tiene. «[» o «{» solo puede ser
 * JSON, y una cabecera CSV nunca empieza así porque un nombre de columna empieza por letra o «_»,
 * así que la suposición no puede equivocarse y el JSON de siempre sigue leyéndose igual.
 */
describe("el formato se adivina por el primer carácter", () => {
  test("una lista sigue siendo JSON aunque sus valores lleven comas", () => {
    const parsed = parseRows('[{ "direccion": "Calle Mayor, 3" }]');
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.rows).toEqual([{ direccion: "Calle Mayor, 3" }]);
  });

  test("un JSON roto no se reinterpreta como CSV para salvarlo", () => {
    const parsed = parseRows('[{ "nombre": "primera" }');
    expect(parsed.ok).toBe(false);
  });
});
