/**
 * Lo que la gente ya tiene, convertido en pruebas reutilizables de este proyecto.
 *
 * Un analizador de texto es un montón de casos límite, y cada uno de ellos es una petición que se
 * importa mal sin que se note: un espacio dentro de unas comillas, un `{{base}}` que no es una URL
 * válida, un `-G` que mueve el cuerpo a la cadena de consulta. Por eso están aquí, sin base de
 * datos delante.
 *
 * La regla que ordena el resto: **sale una plantilla, nunca una operación.** Los endpoints son los
 * del contrato, y un `curl` que se inventara uno rompería la propiedad que hace que la deriva se
 * detecte.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";

import {
  expectedStatusFor,
  matchOperation,
  parseCurl,
  parseCurlDocument,
  pathOf,
  queryOf,
  shellSplit,
  type ParsedRequest,
} from "@/modules/workflows/domain/import-requests";
import type { Operation } from "@eq/runner-core";

const operation = (overrides: Partial<Operation> = {}): Operation => ({
  id: "listWidgets",
  method: "GET",
  path: "/widgets",
  summary: "",
  tag: "Widgets",
  statuses: [200],
  parameters: [],
  ...overrides,
});

const request = (overrides: Partial<ParsedRequest> = {}): ParsedRequest => ({
  name: "GET /widgets",
  method: "GET",
  url: "/widgets",
  headers: {},
  body: { type: "none" },
  ...overrides,
});

describe("cortar un comando como lo haría un shell", () => {
  test("las comillas simples se llevan los espacios de dentro", () => {
    assert.deepEqual(shellSplit(`curl -H 'X-Tenant: acme corp' /x`), ["curl", "-H", "X-Tenant: acme corp", "/x"]);
  });

  test("dentro de comillas dobles se puede escapar una comilla", () => {
    assert.deepEqual(shellSplit(`curl -d "{\\"a\\":1}"`), ["curl", "-d", '{"a":1}']);
  });

  test("una barra invertida antes del salto de línea es una continuación y desaparece", () => {
    // Es la forma en la que viene *todo* comando que alguien copia de un navegador o de una
    // herramienta, así que sin esto casi nada de lo que se pega se puede leer.
    assert.deepEqual(shellSplit("curl /x \\\n  -H 'A: b'"), ["curl", "/x", "-H", "A: b"]);
  });

  test("no se expande nada: un $HOME pegado es texto", () => {
    // Resolverlo significaría leer el entorno de este proceso por encargo de una cadena que
    // alguien pegó.
    assert.deepEqual(shellSplit("curl $HOME/x"), ["curl", "$HOME/x"]);
  });

  test("una cadena vacía entre comillas es un argumento, no la ausencia de uno", () => {
    assert.deepEqual(shellSplit(`curl -d '' /x`), ["curl", "-d", "", "/x"]);
  });
});

describe("un comando curl como petición", () => {
  test("sin -X y sin cuerpo es un GET, que es lo que hace el propio curl", () => {
    const parsed = parseCurl("curl https://api.ejemplo.com/widgets");
    assert.equal(parsed?.method, "GET");
    assert.equal(parsed?.url, "https://api.ejemplo.com/widgets");
  });

  test("sin -X y con cuerpo es un POST, también como el propio curl", () => {
    assert.equal(parseCurl(`curl https://api/x -d '{"a":1}'`)?.method, "POST");
  });

  test("-X gana sobre lo inferido", () => {
    assert.equal(parseCurl(`curl -X PATCH https://api/x -d '{"a":1}'`)?.method, "PATCH");
  });

  test("las cabeceras se parten por el primer dos puntos: el valor suele llevar más", () => {
    const parsed = parseCurl(`curl https://api/x -H 'X-Base: https://otro:8080/v1'`);
    assert.deepEqual(parsed?.headers, { "X-Base": "https://otro:8080/v1" });
  });

  test("un cuerpo JSON entra como JSON", () => {
    assert.deepEqual(parseCurl(`curl https://api/x -d '{"a":1}'`)?.body, { type: "json", json: { a: 1 } });
  });

  test("un JSON que no es un objeto se queda en texto: no hay árbol que enseñar", () => {
    assert.equal(parseCurl(`curl https://api/x -d '[1,2]'`)?.body.type, "raw");
  });

  test("un cuerpo que no parsea se queda en texto con el content-type declarado", () => {
    const parsed = parseCurl(`curl https://api/x -H 'Content-Type: application/xml' -d '<a/>'`);
    assert.deepEqual(parsed?.body, { type: "raw", text: "<a/>", contentType: "application/xml" });
  });

  test("un formulario urlencoded se reconoce por el content-type", () => {
    const parsed = parseCurl(
      `curl https://api/x -H 'Content-Type: application/x-www-form-urlencoded' -d 'a=1&b=dos+tres'`,
    );
    assert.deepEqual(parsed?.body, {
      type: "x-www-form-urlencoded",
      fields: { a: "1", b: "dos tres" },
      disabledFields: {},
    });
  });

  test("-F es un multipart", () => {
    assert.deepEqual(parseCurl("curl https://api/x -F nombre=Ana -F rol=admin")?.body, {
      type: "form-data",
      fields: { nombre: "Ana", rol: "admin" },
      disabledFields: {},
    });
  });

  test("-G mueve el cuerpo a la cadena de consulta, que es como se manda un GET filtrado", () => {
    const parsed = parseCurl("curl -G https://api/x -d estado=activo");
    assert.equal(parsed?.method, "GET");
    assert.equal(parsed?.url, "https://api/x?estado=activo");
    assert.equal(parsed?.body.type, "none");
  });

  test("varios -d se concatenan, como hace curl", () => {
    const parsed = parseCurl("curl -G https://api/x -d a=1 -d b=2");
    assert.equal(parsed?.url, "https://api/x?a=1&b=2");
  });

  test("una credencial en -u se descarta con su valor", () => {
    // Importarla pondría la contraseña de alguien en una columna jsonb, que es exactamente lo que
    // la tabla de credenciales existe para evitar. Y consumir el valor es lo que impide que
    // `user:pass` se lea como la URL.
    const parsed = parseCurl("curl -u ana:secreto https://api/x");
    assert.equal(parsed?.url, "https://api/x");
    assert.ok(!JSON.stringify(parsed).includes("secreto"));
  });

  test("una bandera de transporte que no se conoce no impide leer el comando", () => {
    // `curl` tiene más de doscientas, casi todas sobre el transporte. Rechazar por `--compressed`
    // sería rechazar justo lo que la gente pega: lo que produjo «Copiar como cURL».
    const parsed = parseCurl("curl --compressed -k -s -L https://api/x");
    assert.equal(parsed?.url, "https://api/x");
  });

  test("sin URL no hay petición", () => {
    assert.equal(parseCurl("curl -X POST"), null);
  });
});

describe("un documento lleno de comandos", () => {
  const runbook = `
# Alta de pedido

Primero se lista:

\`\`\`bash
curl https://api/widgets
\`\`\`

Y luego se crea:

\`\`\`
curl -X POST https://api/widgets \\
  -H 'Content-Type: application/json' \\
  -d '{"name":"uno"}'
\`\`\`
`;

  test("lee todos los comandos de un runbook, no solo el primero", () => {
    // Es el caso que justifica la función: lo que un equipo guarda es un markdown con quince
    // comandos, e importarlo de uno en uno es el retecleo que esto viene a quitar.
    const { requests } = parseCurlDocument(runbook);
    assert.equal(requests.length, 2);
    assert.equal(requests[0].method, "GET");
    assert.equal(requests[1].method, "POST");
    assert.deepEqual(requests[1].body, { type: "json", json: { name: "uno" } });
  });

  test("un comando suelto pegado tal cual también vale", () => {
    assert.equal(parseCurlDocument("curl https://api/widgets").requests.length, 1);
  });

  test("un texto sin ningún curl no importa nada y no es un error", () => {
    assert.deepEqual(parseCurlDocument("# Notas\n\nNada que importar."), { requests: [], skipped: [] });
  });
});

describe("la ruta y la consulta de una URL", () => {
  test("de una URL absoluta sale su ruta", () => {
    assert.equal(pathOf("https://api.ejemplo.com/v1/widgets?x=1"), "/v1/widgets");
  });

  test("de una ruta suelta sale ella misma", () => {
    assert.equal(pathOf("/widgets"), "/widgets");
  });

  test("una plantilla como host no es una URL válida y aun así tiene ruta", () => {
    // `new URL` lanza con `{{base}}/pedidos`, que es la forma que usa toda exportación de Postman.
    assert.equal(pathOf("{{base}}/pedidos/7"), "/pedidos/7");
  });

  test("la consulta sale como mapa", () => {
    assert.deepEqual(queryOf("/widgets?estado=activo&pagina=2"), { estado: "activo", pagina: "2" });
  });

  test("sin consulta el mapa está vacío", () => {
    assert.deepEqual(queryOf("/widgets"), {});
  });
});

/**
 * Contra qué operación del contrato cae cada petición.
 *
 * Desde el final de la ruta, porque una colección exportada lleva la URL base que usara su autor y
 * este proyecto declara las rutas relativas a una base que guarda el entorno. Exigir que las dos
 * coincidan rechazaría casi cualquier colección real por un prefijo que nadie escribió.
 */
describe("la operación sobre la que cae una petición", () => {
  const operations = [
    operation(),
    operation({ id: "getWidget", path: "/widgets/{id}", parameters: ["id"] }),
    operation({ id: "newWidgetForm", path: "/widgets/new" }),
    operation({ id: "createWidget", method: "POST", path: "/widgets", statuses: [201, 422] }),
  ];

  test("una ruta exacta cae donde debe", () => {
    assert.equal(matchOperation(request(), operations)?.operation.id, "listWidgets");
  });

  test("un prefijo que el contrato no declara no impide encontrarla", () => {
    const match = matchOperation(request({ url: "https://api.ejemplo.com/api/v1/widgets" }), operations);
    assert.equal(match?.operation.id, "listWidgets");
  });

  test("lo que ocupa un hueco de la ruta sale como parámetro", () => {
    const match = matchOperation(request({ url: "https://api/widgets/42" }), operations);
    assert.equal(match?.operation.id, "getWidget");
    assert.deepEqual(match?.parameters, { id: "42" });
  });

  test("un segmento literal gana a uno variable que también encajaría", () => {
    // `/widgets/new` es mejor lectura de `GET /widgets/new` que `/widgets/{id}`, y sin esta regla
    // la petición se importaría contra la operación equivocada sin decir nada.
    assert.equal(
      matchOperation(request({ url: "https://api/widgets/new" }), operations)?.operation.id,
      "newWidgetForm",
    );
  });

  test("el método forma parte de la identidad: el mismo camino con otro verbo es otra operación", () => {
    assert.equal(matchOperation(request({ method: "POST" }), operations)?.operation.id, "createWidget");
  });

  test("una ruta que el contrato no declara no cae en ninguna", () => {
    assert.equal(matchOperation(request({ url: "https://api/facturas" }), operations), null);
  });

  test("un valor de ruta escapado se guarda desescapado: es lo que alguien escribió", () => {
    const match = matchOperation(request({ url: "https://api/widgets/a%20b" }), operations);
    assert.deepEqual(match?.parameters, { id: "a b" });
  });
});

describe("el estado que espera una petición importada", () => {
  test("sale del contrato: el menor código de éxito que la operación declara", () => {
    // Un 200 fijo haría que cada POST importado fallara su primera corrida contra una API que
    // contesta 201 correctamente, y el informe culparía al endpoint.
    assert.equal(expectedStatusFor(operation({ statuses: [201, 422] })), 201);
  });

  test("una operación que no declara ninguno cae en 200", () => {
    assert.equal(expectedStatusFor(operation({ statuses: [404] })), 200);
  });
});
