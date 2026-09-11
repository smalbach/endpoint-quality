import { describe, expect, test } from "vitest";
import { fieldMapsFrom, fieldProblems, fieldRowsFrom, type FieldRow } from "@/lib/request-fields";

const row = (overrides: Partial<FieldRow> = {}): FieldRow => ({ name: "x", value: "1", enabled: true, ...overrides });

/**
 * El viaje de ida y vuelta entre las dos formas: dos mapas en la fila de la base de datos, una
 * lista de filas en el formulario.
 *
 * Es lo que hace que apagar un parámetro no sea borrarlo. Lo que se manda y lo que está guardado
 * y apagado viven en mapas distintos —igual que las variables de un entorno—, así que la
 * conversión es el único sitio donde las dos ideas se tocan: si pierde el `enabled`, una fila
 * apagada vuelve a enviarse sin que nadie la haya tocado.
 */
describe("las filas de una petición y los dos mapas que las guardan", () => {
  test("una fila apagada se guarda aparte y no entre las que se envían", () => {
    const maps = fieldMapsFrom([
      row({ name: "status", value: "activo" }),
      row({ name: "page", value: "2", enabled: false }),
    ]);
    expect(maps.enabled).toEqual({ status: "activo" });
    expect(maps.disabled).toEqual({ page: "2" });
  });

  test("ida y vuelta: lo apagado sigue apagado y con su valor", () => {
    const maps = { enabled: { status: "activo" }, disabled: { page: "2" } };
    const back = fieldMapsFrom(fieldRowsFrom(maps.enabled, maps.disabled));
    expect(back).toEqual(maps);
  });

  test("las filas llegan ordenadas por nombre, porque jsonb no guarda el orden en que se escribieron", () => {
    expect(fieldRowsFrom({ zeta: "1", alfa: "2" }, { medio: "3" }).map((item) => item.name)).toEqual([
      "alfa",
      "medio",
      "zeta",
    ]);
  });

  test("una fila a medio escribir no es todavía un parámetro", () => {
    expect(fieldMapsFrom([row({ name: "  ", value: "1" }), row({ name: "", value: "" })]).enabled).toEqual({});
  });

  test("un nombre con espacios alrededor se guarda sin ellos", () => {
    expect(fieldMapsFrom([row({ name: "  status  ", value: "activo" })]).enabled).toEqual({ status: "activo" });
  });
});

/**
 * Lo que se dice al lado de la fila, antes de que el servidor lo repita.
 *
 * No en lugar de la comprobación del servidor —esa es la regla— sino para que el aviso salga
 * donde está el cursor y no como un 422 sobre una ruta dentro de un documento.
 */
describe("lo que está mal en una fila", () => {
  test("el duplicado se señala en la segunda fila, que es la que sobra", () => {
    const problems = fieldProblems([row({ name: "id" }), row({ name: "id" })], "parameter");
    expect(problems).toEqual([{ index: 1, detail: "Ya hay un parámetro con ese nombre" }]);
  });

  test("una fila apagada cuenta para el duplicado: el mismo nombre en los dos mapas no significa nada", () => {
    expect(fieldProblems([row({ name: "id" }), row({ name: "id", enabled: false })], "parameter")).toHaveLength(1);
  });

  test("un nombre de cabecera con un espacio no es un nombre de cabecera", () => {
    expect(fieldProblems([row({ name: "X Tenant" })], "header")).toHaveLength(1);
    expect(fieldProblems([row({ name: "X-Tenant" })], "header")).toEqual([]);
  });

  test("un salto de línea en el valor de una cabecera se rechaza aquí y en el servidor", () => {
    expect(fieldProblems([row({ name: "X-Tenant", value: "acme\r\nX-Admin: 1" })], "header")).toHaveLength(1);
  });

  test("un parámetro puede llamarse como quiera: es una cadena de consulta, no una cabecera", () => {
    expect(fieldProblems([row({ name: "filtro[precio]" })], "parameter")).toEqual([]);
  });
});
