/**
 * Los bordes que las otras pruebas no pisan: un HAR legible, formatos que se reconocen a medias, y
 * zips rotos de cada una de las maneras en que un zip puede estar roto sin que el resto se pierda.
 *
 * Los zips rotos se hacen rompiendo a mano uno bueno, byte a byte, en el sitio exacto que dice el
 * formato: así cada prueba nombra qué campo miente y qué hace el lector con esa mentira.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { detectImport, targetsOf } from "../src/index.ts";
import { looksZipped, readZip } from "../src/zip.ts";
import { buildZip, buildZip64 } from "./zip-builders.ts";

const ZIP_MAGIC = `PK${String.fromCharCode(3)}${String.fromCharCode(4)}`;
const tienda = JSON.stringify({ info: { name: "Tienda" }, item: [{ name: "Alta", request: { method: "POST" } }] });
const names = async (zip: Uint8Array) => (await readZip(zip)).map((entry) => entry.name);
const viewOf = (zip: Uint8Array) => new DataView(zip.buffer, zip.byteOffset, zip.byteLength);

/** Dónde empieza cada entrada del índice central de un zip de `buildZip` (sin extras ni comentarios). */
function centralEntries(zip: Uint8Array): number[] {
  const view = viewOf(zip);
  const eocd = zip.length - 22;
  const count = view.getUint16(eocd + 10, true);
  const positions: number[] = [];
  let at = view.getUint32(eocd + 16, true);
  for (let index = 0; index < count; index += 1) {
    positions.push(at);
    at += 46 + view.getUint16(at + 28, true);
  }
  return positions;
}

/** Dónde empieza el índice central de un zip de `buildZip64`, leído del registro de Zip64. */
const zip64Directory = (zip: Uint8Array) => Number(viewOf(zip).getBigUint64(zip.length - 22 - 20 - 56 + 48, true));

describe("un HAR grabado en el navegador", () => {
  const har = (log: Record<string, unknown>) => JSON.stringify({ log: { version: "1.2", ...log } });
  const entries = [
    { request: { method: "GET", url: "http://x/a" } },
    { request: { method: "POST", url: "http://x/b" } },
  ];

  test("se llama como la pestaña que se grabó y cuenta sus peticiones", () => {
    const detected = detectImport(
      "red.har",
      har({ pages: [{ title: "Catálogo" }], creator: { name: "Firefox" }, entries }),
    );
    assert.equal(detected.kind, "har");
    assert.equal(detected.name, "Catálogo");
    assert.equal(detected.pieces[0].name, "red.har");
    assert.equal(detected.pieces[0].detail, "2 peticiones grabadas");
    assert.deepEqual(targetsOf("har"), ["endpoints"]);
  });

  test("sin páginas, por quién lo grabó; sin eso, por el nombre del fichero", () => {
    const creator = detectImport(
      "red.har",
      har({ creator: { name: "Chrome DevTools" }, entries: entries.slice(0, 1) }),
    );
    assert.equal(creator.name, "Chrome DevTools");
    assert.equal(creator.pieces[0].detail, "1 petición grabada");
    assert.equal(detectImport("red.har", har({ pages: [], entries })).name, "red.har");
    assert.equal(detectImport("red.har", har({ pages: "no es lista", entries })).name, "red.har");
  });
});

describe("formatos reconocidos a medias", () => {
  test("un OpenAPI sin rutas se reconoce y no inventa una cuenta", () => {
    assert.equal(
      detectImport("x.json", JSON.stringify({ openapi: "3.1.0", info: { title: "t" } })).pieces[0].detail,
      null,
    );
    const yaml = detectImport("x.yaml", "openapi: 3.0.3\ninfo:\n  title: t\n");
    assert.equal(yaml.kind, "openapi");
    assert.equal(yaml.pieces[0].detail, null);
  });

  test("un JSON que no es de ningún formato se dice así, con el nombre que traiga", () => {
    const named = detectImport("x.json", JSON.stringify({ name: "Algo", foo: 1 }));
    assert.equal(named.kind, "unknown");
    assert.equal(named.name, "Algo");
    assert.match(named.reason ?? "", /no de ningún formato conocido/);
    assert.equal(detectImport("x.json", JSON.stringify({ foo: 1 })).name, "x.json");
    assert.equal(detectImport("  ", "{}").name, "lo pegado", "sin nombre de fichero es lo pegado");
  });

  test("las entradas de una colección que no son objetos no cuentan como peticiones", () => {
    const messy = JSON.stringify({
      info: { name: "Sucia" },
      item: [null, "texto", 3, { name: "sin request" }, { request: {} }],
    });
    assert.equal(detectImport("x.json", messy).pieces[0].detail, "1 petición");
  });

  test("varios curl pegados se cuentan uno por uno", () => {
    const detected = detectImport("", "curl https://x/a\n  curl -X POST https://x/b\n# nota\ncurl\\\n  https://x/c");
    assert.equal(detected.kind, "curl");
    assert.equal(detected.pieces[0].detail, "3 comandos");
  });

  test("un proyecto exportado se nombra por su proyecto si no trae settings, y dice cuando viene vacío", () => {
    const bundle = (extra: Record<string, unknown>) =>
      detectImport("x.json", JSON.stringify({ format: "endpoint-quality/project", ...extra }));
    const full = bundle({ project: { name: "Viejo" }, environments: [{}, {}], roles: [{}] });
    assert.equal(full.name, "Viejo");
    assert.equal(full.pieces[0].detail, "2 entornos · 1 rol");
    const empty = bundle({});
    assert.equal(empty.name, "x.json");
    assert.equal(empty.pieces[0].detail, "nada que importar");
  });
});

describe("reconocer un zip por lo que empieza, sin sufijo", () => {
  test("un texto que empieza por la firma lo es; uno que empieza por «PK» no", () => {
    assert.equal(looksZipped("pegado", `${ZIP_MAGIC}resto`), true);
    assert.equal(looksZipped("pegado", "PKWare"), false);
    assert.equal(looksZipped("pegado", new Uint8Array([0x50, 0x4b])), false, "dos bytes no bastan");
  });
});

describe("un zip roto de cada manera posible", () => {
  test("una entrada del índice sin su firma es un índice corrupto", async () => {
    const zip = buildZip([{ name: "tienda.json", body: tienda }]);
    viewOf(zip).setUint32(centralEntries(zip)[0], 0, true);
    await assert.rejects(() => readZip(zip), /índice corrupto/);
  });

  test("un final que promete más entradas de las que hay es un índice corrupto", async () => {
    const zip = buildZip([{ name: "tienda.json", body: tienda }]);
    viewOf(zip).setUint16(zip.length - 22 + 10, 2, true);
    await assert.rejects(() => readZip(zip), /índice corrupto/);
  });

  test("un final que apunta más allá del fichero no es un zip", async () => {
    const zip = buildZip([{ name: "tienda.json", body: tienda }]);
    viewOf(zip).setUint32(zip.length - 22 + 16, zip.length + 100, true);
    await assert.rejects(() => readZip(zip), /no parece un \.zip/);
  });

  test("un zip con comentario al final se lee: el final se busca hacia atrás", async () => {
    const zip = buildZip([{ name: "tienda.json", body: tienda }]);
    const comment = new TextEncoder().encode("exportado por Postman");
    const withComment = new Uint8Array(zip.length + comment.length);
    withComment.set(zip);
    withComment.set(comment, zip.length);
    viewOf(withComment).setUint16(zip.length - 22 + 20, comment.length, true);
    assert.deepEqual(await names(withComment), ["tienda.json"]);
  });

  test("una entrada cuya cabecera local no está donde dice el índice se salta, y las demás entran", async () => {
    const zip = buildZip([
      { name: "rota.json", body: tienda },
      { name: "tienda.json", body: tienda },
    ]);
    viewOf(zip).setUint32(0, 0, true);
    assert.deepEqual(await names(zip), ["tienda.json"]);
  });

  test("una entrada que dice ocupar más bytes de los que quedan se salta", async () => {
    const zip = buildZip([
      { name: "cortada.json", body: tienda },
      { name: "tienda.json", body: tienda },
    ]);
    viewOf(zip).setUint32(centralEntries(zip)[0] + 20, 0x00ffffff, true);
    assert.deepEqual(await names(zip), ["tienda.json"]);
  });

  test("una entrada que no se puede inflar se salta, sin tirar el zip", async () => {
    // Almacenada con bytes que no son deflate (0x07 es un bloque de tipo reservado) y marcada
    // después como deflate en el índice.
    const zip = buildZip([
      { name: "basura.json", body: "", store: true },
      { name: "tienda.json", body: tienda },
    ]);
    viewOf(zip).setUint16(centralEntries(zip)[0] + 10, 8, true);
    assert.deepEqual(await names(zip), ["tienda.json"]);
  });

  test("un nombre hecho solo de separadores no sale", async () => {
    assert.deepEqual(
      await names(
        buildZip([
          { name: "\\\\", body: "{}" },
          { name: "tienda.json", body: tienda },
        ]),
      ),
      ["tienda.json"],
    );
  });

  test("un tamaño marcado como Zip64 sin extra que lo traiga deja la entrada fuera", async () => {
    const zip = buildZip([
      { name: "marcada.json", body: tienda },
      { name: "tienda.json", body: tienda },
    ]);
    viewOf(zip).setUint32(centralEntries(zip)[0] + 24, 0xffffffff, true);
    assert.deepEqual(await names(zip), ["tienda.json"]);
  });
});

describe("un Zip64 roto", () => {
  /** El zip de dos entradas con la primera tocada por `patch`, que recibe dónde empieza su extra. */
  const broken = async (patch: (view: DataView, extra: number) => void) => {
    const zip = buildZip64([
      { name: "rota.json", body: tienda },
      { name: "tienda.json", body: tienda },
    ]);
    const entry = zip64Directory(zip);
    patch(viewOf(zip), entry + 46 + "rota.json".length);
    return names(zip);
  };

  test("un extra de Zip64 más corto que los campos marcados deja la entrada fuera", async () => {
    // El ajeno ocupa 9 bytes; el de Zip64 declara solo 8 en vez de 24: trae el tamaño sin
    // comprimir y le faltan el comprimido y el desplazamiento.
    assert.deepEqual(await broken((view, extra) => view.setUint16(extra + 9 + 2, 8, true)), ["tienda.json"]);
  });

  test("un campo extra que dice ser más largo que el espacio que tiene no se lee", async () => {
    assert.deepEqual(await broken((view, extra) => view.setUint16(extra + 2, 0xffff, true)), ["tienda.json"]);
  });

  test("marcada como Zip64 y sin campo de Zip64 entre sus extras, se salta", async () => {
    assert.deepEqual(await broken((view, extra) => view.setUint16(extra + 9, 0x0002, true)), ["tienda.json"]);
  });

  test("un registro de Zip64 que pone el índice fuera del fichero es un índice corrupto", async () => {
    const zip = buildZip64([{ name: "tienda.json", body: tienda }]);
    const record = zip.length - 22 - 20 - 56;
    viewOf(zip).setBigUint64(record + 48, BigInt(zip.length + 1), true);
    await assert.rejects(() => readZip(zip), /índice corrupto/);
  });
});
