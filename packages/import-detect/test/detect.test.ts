/**
 * Qué es lo que alguien acaba de soltar, decidido mirándolo.
 *
 * Es la pieza que tiene el import de Postman y este producto no tenía: allí sueltas cosas y él te
 * dice qué encontró y a dónde va; aquí había que marcar casillas diciendo qué hacer con el
 * fichero, que es pedirle a alguien que conteste una pregunta que el fichero ya contesta.
 *
 * Tres reglas ordenan el resto, y las tres se prueban aquí. **Por contenido, nunca por el nombre**:
 * lo que baja Postman se llama como le da la gana y `Catalog-API.json` es igual de probable que sea
 * una colección o un entorno. **Un volcado estalla en sus piezas**: «Export data» produce un
 * fichero con todas las colecciones y todos los entornos dentro, que es como se mueve un equipo
 * entero. Y **lo que no se puede leer se dice con algo que hacer**, porque «no se reconoce» no es
 * accionable y «es un .zip, suéltalo como fichero» sí.
 *
 * Vive en un paquete aparte por una razón que también se prueba: el navegador necesita esta misma
 * respuesta antes de mandar nada, y dos copias de la función serían dos copias libres de no estar
 * de acuerdo — y el desacuerdo se vería como un diálogo prometiendo una cosa y un import haciendo
 * otra.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { detectImport, targetsOf, IMPORT_KINDS, type PieceKind } from "../src/index.ts";

const collection = (name = "Tienda") =>
  JSON.stringify({
    info: { name, schema: "https://schema.getpostman.com/json/collection/v2.1.0/collection.json" },
    item: [
      { name: "Alta", request: { method: "POST", url: "{{baseUrl}}/pedidos" } },
      { name: "Catálogo", item: [{ name: "Listar", request: { method: "GET", url: "{{baseUrl}}/productos" } }] },
    ],
  });
const environment = (name = "local") =>
  JSON.stringify({
    name,
    values: [
      { key: "baseUrl", value: "http://x" },
      { key: "token", value: "s3cr3t", type: "secret" },
    ],
    _postman_variable_scope: "environment",
  });

describe("reconocer lo que se suelta", () => {
  test("una colección de Postman, por su `item` y no por su nombre", () => {
    const detected = detectImport("descarga(3).json", collection());
    assert.equal(detected.kind, "postman-collection");
    assert.equal(detected.name, "Tienda");
    assert.deepEqual(
      detected.pieces.map((piece) => piece.kind),
      ["postman-collection"],
    );
  });

  test("un entorno, por sus `values`", () => {
    const detected = detectImport("descarga(4).json", environment());
    assert.equal(detected.kind, "postman-environment");
    assert.equal(detected.name, "local");
  });

  test("un OpenAPI, en JSON y en YAML", () => {
    assert.equal(detectImport("x.json", JSON.stringify({ openapi: "3.1.0", paths: {} })).kind, "openapi");
    assert.equal(detectImport("sin-extension", "openapi: 3.0.3\npaths: {}\n").kind, "openapi");
  });

  test("una exportación de Insomnia y un texto con curls", () => {
    assert.equal(detectImport("x.json", JSON.stringify({ _type: "export", resources: [] })).kind, "insomnia");
    assert.equal(detectImport("runbook.md", "Para probarlo:\n\ncurl https://api/x -H 'A: b'\n").kind, "curl");
  });

  test("un proyecto exportado de aquí, que era el único formato que leía otra puerta", () => {
    const detected = detectImport("probe.json", JSON.stringify({ format: "endpoint-quality/project", version: 1 }));
    assert.equal(detected.kind, "eq-bundle");
    assert.deepEqual(targetsOf("eq-bundle"), ["project"]);
  });

  test("y se mira antes que el volcado, porque también trae un `environments` dentro", () => {
    // El volcado de Postman va primero que todas las demás formas justamente porque las contiene;
    // el proyecto exportado es la excepción, y dice lo que es en un campo suyo.
    const exported = JSON.stringify({
      format: "endpoint-quality/project",
      version: 1,
      project: { name: "Catálogo" },
      environments: [{ name: "local" }],
    });
    const detected = detectImport("proyecto.json", exported);
    assert.equal(detected.kind, "eq-bundle");
    assert.equal(detected.name, "Catálogo");
  });

  test("un volcado estalla en sus piezas: así se mueve un equipo entero de una vez", () => {
    const dump = JSON.stringify({
      collections: [JSON.parse(collection("Pedidos")), JSON.parse(collection("Catálogo"))],
      environments: [JSON.parse(environment("local")), JSON.parse(environment("producción"))],
    });
    const detected = detectImport("postman-data-dump.json", dump);
    assert.equal(detected.kind, "postman-dump");
    assert.deepEqual(
      detected.pieces.map((piece) => [piece.kind, piece.name]),
      [
        ["postman-collection", "Pedidos"],
        ["postman-collection", "Catálogo"],
        ["postman-environment", "local"],
        ["postman-environment", "producción"],
      ],
    );
    // Y cada pieza es indistinguible de un fichero suelto: su propio texto, leíble por su cuenta.
    assert.equal(detectImport("", detected.pieces[0].text).kind, "postman-collection");
  });

  test("el volcado se mira antes que nada: contiene las otras formas dentro", () => {
    // Si se buscara `item` primero, un volcado se leería como su primera colección y el resto se
    // perdería sin que nadie lo notara.
    const dump = JSON.stringify({ item: [], collections: [JSON.parse(collection("Dentro"))] });
    assert.equal(detectImport("x.json", dump).kind, "postman-dump");
  });
});

describe("lo de dentro, contado", () => {
  // El detalle es lo que hace que el plan sirva de algo antes de confirmarlo: «una colección» no
  // dice si trae tres peticiones o sesenta, y esa es justo la pregunta de quien está mirando.
  test("las peticiones y las carpetas de una colección, recursivas", () => {
    assert.equal(detectImport("x.json", collection()).pieces[0].detail, "2 peticiones · 1 carpeta");
  });

  test("las variables de un entorno, y cuántas son secretas", () => {
    assert.equal(detectImport("x.json", environment()).pieces[0].detail, "2 variables · 1 secreta");
  });

  test("las globals de un workspace se dicen por su nombre", () => {
    const globals = JSON.stringify({ values: [{ key: "a", value: "b" }], _postman_variable_scope: "globals" });
    assert.match(detectImport("globals.json", globals).pieces[0].detail ?? "", /globals del workspace/);
  });

  test("las rutas de un OpenAPI, en JSON y contadas en el YAML sin parsearlo", () => {
    const json = JSON.stringify({ openapi: "3.1.0", paths: { "/a": {}, "/b": {} } });
    assert.equal(detectImport("x.json", json).pieces[0].detail, "2 rutas");
    const yaml = "openapi: 3.0.3\npaths:\n  /productos:\n    get: {}\n  /pedidos:\n    post: {}\ncomponents: {}\n";
    assert.equal(detectImport("x.yaml", yaml).pieces[0].detail, "2 rutas");
  });

  test("lo que trae un proyecto exportado", () => {
    const bundle = JSON.stringify({
      format: "endpoint-quality/project",
      version: 1,
      settings: { name: "Catálogo" },
      contract: { raw: "openapi: 3.0.0" },
      endpoints: [{}, {}],
      flows: { workflows: [{}] },
    });
    const detected = detectImport("x.json", bundle);
    assert.equal(detected.name, "Catálogo");
    assert.equal(detected.pieces[0].detail, "contrato · 2 endpoints · 1 flujo");
  });
});

describe("lo que no se puede leer se dice con algo que hacer", () => {
  test("un .zip llegado como texto manda a soltarlo como fichero, que es donde sí se abre", () => {
    // Un `.zip` soltado o elegido no llega hasta aquí: `readZip` lo convierte antes en sus
    // ficheros. Esto es el camino de la URL, donde lo que cruza la red es una cadena.
    const magic = `PK${String.fromCharCode(3)}${String.fromCharCode(4)}`;
    assert.match(detectImport("postman-data.zip", "cualquier cosa").reason ?? "", /suéltalo como fichero/);
    assert.match(detectImport("sin-nombre", `${magic}algo`).reason ?? "", /suéltalo como fichero/);
    // Y «PK» a secas no es un zip: es cualquier texto que empiece por esas dos letras.
    assert.doesNotMatch(detectImport("notas.txt", "PKWare inventó el formato").reason ?? "", /zip/);
  });

  test("una colección v1 se reconoce y se manda a exportarla como v2.1", () => {
    // La misma respuesta que da Postman, y merece repetirse palabra por palabra: la forma se
    // reconoce, de verdad no está soportada, y hay algo que la persona puede hacer.
    const detected = detectImport("vieja.json", JSON.stringify({ id: "1", name: "Vieja", requests: [] }));
    assert.equal(detected.kind, "unknown");
    assert.match(detected.reason ?? "", /v1.*v2\.1/);
  });

  test("un HAR con la forma pero sin peticiones lo dice, que no es lo mismo que no reconocerlo", () => {
    // Esta prueba decía antes «se reconoce y todavía no se lee». Ahora sí se lee, así que lo único
    // que queda aquí es el HAR vacío: la forma está y no hay nada dentro.
    const detected = detectImport("red.har", JSON.stringify({ log: { version: "1.2" } }));
    assert.equal(detected.kind, "unknown");
    assert.match(detected.reason ?? "", /HAR.*no trae ninguna petición/);
  });

  test("un JSON roto no es «no se reconoce», es «empieza como JSON y no lo es»", () => {
    const detected = detectImport("x.json", '{"info": {');
    assert.equal(detected.kind, "unknown");
    assert.match(detected.reason ?? "", /empieza como JSON/);
  });

  test("lo vacío, una lista en la raíz, y lo que no es nada de lo anterior", () => {
    assert.match(detectImport("x.json", "   ").reason ?? "", /vacío/);
    assert.match(detectImport("x.json", "[1, 2]").reason ?? "", /lista/);
    assert.match(detectImport("notas.txt", "hola qué tal").reason ?? "", /ni un OpenAPI|curl/);
  });
});

describe("a dónde va cada cosa", () => {
  test("cada formato legible tiene un destino, y el diálogo lee esta misma tabla", () => {
    // La línea «va a…» del diálogo y el enrutado del servidor son la misma afirmación. La única
    // forma de que no se separen es que sean la misma función.
    for (const kind of IMPORT_KINDS) {
      if (kind === "postman-dump" || kind === "unknown") continue;
      assert.ok(targetsOf(kind as PieceKind).length > 0, `${kind} no va a ninguna parte`);
    }
    // Una colección va a la colección que es, no a flujos: su árbol se guarda tal cual.
    assert.deepEqual(targetsOf("postman-collection"), ["endpoints", "collections"]);
    assert.deepEqual(targetsOf("openapi"), ["contract"]);
  });
});
