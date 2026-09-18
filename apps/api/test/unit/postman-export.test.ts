/**
 * Un proyecto escrito como lo escribiría Postman.
 *
 * Es **el inverso exacto** del lector, y estas pruebas fijan las traducciones una por una porque
 * la ida y la vuelta completa —que vive en `test/http/postman-import.test.ts`— dice que el círculo
 * cierra, pero no dice que lo que hay dentro del fichero sea lo que un humano escribiría. Lo
 * segundo es lo que importa cuando alguien abre el fichero en Postman y lo lee.
 *
 * Tres cosas que no son de estilo:
 *
 * - **Ningún secreto sale.** Un valor sensible sale como su nombre con el valor vacío; una cabecera
 *   de credencial escrita a mano sale desactivada y sin valor. Un fichero exportado se copia, se
 *   manda por correo y se commitea.
 * - **Lo que Postman no puede expresar no se tira en silencio.** No hay ramas, ni esperas, ni
 *   bucles: esos nodos se cuentan en `skipped`. Un fichero que parece completo y ha perdido la
 *   mitad del grafo es peor que no poder exportar.
 * - **Las dos colecciones son dos ficheros distintos.** Los flujos dan la vuelta sobre sí mismos;
 *   los endpoints no pueden, porque al volver a entrar una colección *es* un flujo. Meterlos
 *   juntos hacía que cada ida y vuelta añadiera un flujo que nadie había escrito.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { toPostmanExport, toPostmanDump } from "@/modules/projects/domain/postman-export";
import type { ProjectBundle } from "@/modules/projects/domain/project-bundle";

const IDS = { collectionId: "col-1", environmentIds: ["env-1"] };

/** Un proyecto mínimo con lo que hace falta para cada caso. */
const bundle = (patch: Partial<ProjectBundle> = {}): ProjectBundle =>
  ({
    format: "endpoint-quality/project",
    version: 1,
    project: { name: "Tienda" },
    settings: { baseUrl: "https://api.tienda.test" },
    ...patch,
  }) as ProjectBundle;

const template = (patch: Record<string, unknown> = {}) => ({
  id: "t1",
  name: "Crear pedido",
  operationId: "createOrder",
  method: "post",
  path: "/pedidos/{id}",
  description: null,
  expectedStatus: 201,
  parameters: { id: "7", incluir: "todo" },
  disabledParameters: {},
  headers: { "X-Tenant": "acme" },
  disabledHeaders: {},
  body: { type: "json", json: { nombre: "silla" } },
  ...patch,
});

const flows = (steps: unknown[], templates: unknown[] = [template()]) => ({
  flows: {
    requestTemplates: templates,
    workflows: [{ id: "w1", name: "Pedidos", description: "El alta", status: "ready", definition: { steps } }],
    datasets: [],
    suites: [],
  },
});

/** La primera petición del primer flujo, que es lo que casi todo caso quiere mirar. */
const firstRequest = (exported: ReturnType<typeof toPostmanExport>) => {
  const folder = exported.collection.item[0] as { item: { name: string; request: Record<string, unknown> }[] };
  return folder.item[0];
};
const testScript = (exported: ReturnType<typeof toPostmanExport>): string => {
  const item = firstRequest(exported) as unknown as {
    event?: { listen: string; script: { exec: string[] } }[];
  };
  return (item.event ?? []).find((entry) => entry.listen === "test")?.script.exec.join("\n") ?? "";
};

describe("un flujo como carpeta, y sus nodos como peticiones", () => {
  test("el fichero se declara v2.1 y nombra el proyecto", () => {
    const exported = toPostmanExport(bundle(flows([{ id: "s1", requestTemplateId: "t1" }]) as never), IDS);
    assert.equal(exported.collection.info.name, "Tienda");
    assert.match(exported.collection.info.schema, /v2\.1\.0/);
    // `baseUrl` como variable de la colección, que es lo que hace que el fichero sirva contra
    // local y contra producción sin reescribir ninguna URL.
    assert.deepEqual(exported.collection.variable, [{ key: "baseUrl", value: "https://api.tienda.test" }]);
  });

  test("los parámetros de ruta van dentro de la ruta y los demás como `query`", () => {
    const exported = toPostmanExport(bundle(flows([{ id: "s1", requestTemplateId: "t1" }]) as never), IDS);
    const request = firstRequest(exported).request as { method: string; url: { raw: string; query?: unknown } };
    assert.equal(request.method, "POST");
    assert.equal(request.url.raw, "{{baseUrl}}/pedidos/7");
    assert.deepEqual(request.url.query, [{ key: "incluir", value: "todo" }]);
  });

  test("un cuerpo JSON sale como `raw` con su lenguaje, que es como lo escribe Postman", () => {
    const exported = toPostmanExport(bundle(flows([{ id: "s1", requestTemplateId: "t1" }]) as never), IDS);
    const request = firstRequest(exported).request as { body?: { mode: string; raw: string; options: unknown } };
    assert.equal(request.body?.mode, "raw");
    assert.deepEqual(JSON.parse(request.body!.raw), { nombre: "silla" });
    assert.deepEqual(request.body?.options, { raw: { language: "json" } });
  });

  test("un nodo `fetch` lleva su URL entera, que es la que trae escrita", () => {
    const exported = toPostmanExport(
      bundle(
        flows([
          {
            id: "s1",
            kind: "fetch",
            fetch: { method: "POST", url: "https://hooks.test/aviso?a=1", body: '{"ok":true}' },
          },
        ]) as never,
      ),
      IDS,
    );
    const request = firstRequest(exported).request as { url: { raw: string; query?: unknown } };
    assert.equal(request.url.raw, "https://hooks.test/aviso?a=1");
    assert.deepEqual(request.url.query, [{ key: "a", value: "1" }]);
  });

  test("una operación que no está en el contrato se dice, no se escribe a medias", () => {
    const exported = toPostmanExport(
      bundle(
        flows([{ id: "s1", requestTemplateId: "t1" }], [template({ method: undefined, path: undefined })]) as never,
      ),
      IDS,
    );
    assert.deepEqual(exported.collection.item, []);
    assert.match(exported.skipped[0].detail, /no está en el contrato/);
  });
});

describe("las comprobaciones vuelven a ser `pm.test`", () => {
  const withChecks = (checks: unknown[]) =>
    toPostmanExport(bundle(flows([{ id: "s1", requestTemplateId: "t1", checks }]) as never), IDS);

  test("el estado usa `pm.response.to.have.status`, que es la forma que escribe un humano", () => {
    const script = testScript(withChecks([{ source: "status", operator: "equals", value: 201 }]));
    assert.match(script, /pm\.response\.to\.have\.status\(201\)/);
  });

  test("un camino del cuerpo sale con su acceso, y con corchetes cuando el nombre no es un identificador", () => {
    assert.match(
      testScript(withChecks([{ source: "body", path: "data.id", operator: "exists" }])),
      /pm\.expect\(pm\.response\.json\(\)\.data\.id\)\.to\.exist/,
    );
    assert.match(
      testScript(withChecks([{ source: "body", path: "data.total-neto", operator: "exists" }])),
      /pm\.response\.json\(\)\.data\["total-neto"\]/,
    );
  });

  test("cada operador dice su `chai`", () => {
    const of = (operator: string, value?: unknown) =>
      testScript(withChecks([{ source: "body", path: "x", operator, ...(value === undefined ? {} : { value }) }]));
    assert.match(of("equals", 3), /\.to\.eql\(3\)/);
    assert.match(of("not_equals", 3), /\.to\.not\.eql\(3\)/);
    assert.match(of("contains", "ab"), /\.to\.include\("ab"\)/);
    assert.match(of("greater_than", 2), /\.to\.be\.above\(2\)/);
    assert.match(of("less_than", 2), /\.to\.be\.below\(2\)/);
    assert.match(of("not_exists"), /\.to\.not\.exist/);
    assert.match(of("matches", "^a"), /\.to\.match\(new RegExp\("\^a"\)\)/);
    assert.match(of("is_array"), /\.to\.be\.an\("array"\)/);
    assert.match(of("is_not_empty"), /\.to\.not\.be\.empty/);
    assert.match(of("has_length", 4), /\.to\.have\.lengthOf\(4\)/);
  });

  test("una cabecera y la duración leen lo que Postman llama a esas dos cosas", () => {
    assert.match(
      testScript(withChecks([{ source: "header", path: "X-Total", operator: "exists" }])),
      /pm\.response\.headers\.get\("X-Total"\)/,
    );
    assert.match(
      testScript(withChecks([{ source: "durationMs", operator: "less_than", value: 300 }])),
      /pm\.expect\(pm\.response\.responseTime\)\.to\.be\.below\(300\)/,
    );
  });

  test("una comprobación sin etiqueta recibe un nombre, porque `pm.test` exige uno", () => {
    const script = testScript(withChecks([{ source: "status", operator: "equals", value: 200 }]));
    assert.match(script, /^pm\.test\("[^"]+", function \(\) \{/);
  });
});

describe("las capturas vuelven a ser `pm.collectionVariables.set`", () => {
  // `collectionVariables` y no `environment`: es la misma decisión que el import, y por el mismo
  // motivo — `pm.environment.set` escribe en el entorno guardado y sobrevive a la corrida, que no
  // es lo que hace una captura aquí.
  const withCaptures = (captures: unknown[]) =>
    testScript(toPostmanExport(bundle(flows([{ id: "s1", requestTemplateId: "t1", captures }]) as never), IDS));

  test("del cuerpo, de una cabecera, de una cookie y de una expresión", () => {
    assert.match(
      withCaptures([{ variable: "pedidoId", from: "body", path: "data.id" }]),
      /pm\.collectionVariables\.set\("pedidoId", pm\.response\.json\(\)\.data\.id\);/,
    );
    assert.match(
      withCaptures([{ variable: "t", from: "header", path: "X-Total" }]),
      /pm\.response\.headers\.get\("X-Total"\)/,
    );
    assert.match(withCaptures([{ variable: "s", from: "cookie", path: "sid" }]), /pm\.cookies\.get\("sid"\)/);
    assert.match(withCaptures([{ variable: "v", from: "regex", path: "id=(\\d+)" }]), /pm\.response\.text\(\)\.match/);
  });
});

describe("un nodo script vuelve al sitio del que salió", () => {
  test("con `from` puesto, al `test` de esa petición; sin él, al `prerequest` de la siguiente", () => {
    const exported = toPostmanExport(
      bundle(
        flows([
          { id: "pre", kind: "script", script: { code: 'pm.variables.set("x", 1);' } },
          { id: "s1", requestTemplateId: "t1", dependsOn: ["pre"] },
          { id: "post", kind: "script", script: { code: "console.log(1);", from: "s1" }, dependsOn: ["s1"] },
        ]) as never,
      ),
      IDS,
    );
    const item = firstRequest(exported) as unknown as { event: { listen: string; script: { exec: string[] } }[] };
    const listens = item.event.map((entry) => entry.listen);
    assert.deepEqual(listens.sort(), ["prerequest", "test"]);
    assert.match(item.event.find((e) => e.listen === "prerequest")!.script.exec.join("\n"), /pm\.variables\.set/);
    assert.match(item.event.find((e) => e.listen === "test")!.script.exec.join("\n"), /console\.log/);
  });

  test("un script sin petición detrás se dice: en Postman no tiene dónde ir", () => {
    const exported = toPostmanExport(
      bundle(
        flows([
          { id: "s1", requestTemplateId: "t1" },
          { id: "suelto", kind: "script", script: { code: "1;" }, dependsOn: ["s1"] },
        ]) as never,
      ),
      IDS,
    );
    assert.ok(exported.skipped.some((entry) => /no tiene dónde ir/.test(entry.detail)));
  });
});

describe("lo que Postman no puede expresar se cuenta, no se tira", () => {
  test("una rama, una espera y un bucle salen por su nombre en `skipped`", () => {
    const exported = toPostmanExport(
      bundle(
        flows([
          { id: "s1", requestTemplateId: "t1" },
          { id: "r", kind: "branch", condition: { from: "s1", check: {} }, dependsOn: ["s1"] },
          { id: "e", kind: "wait", waitMs: 1000, dependsOn: ["s1"] },
          { id: "b", kind: "loop", loop: { from: "s1", path: "data" }, dependsOn: ["s1"] },
        ]) as never,
      ),
      IDS,
    );
    const details = exported.skipped.map((entry) => entry.detail).join(" | ");
    for (const kind of ["branch", "wait", "loop"]) assert.match(details, new RegExp(`«${kind}»`));
    // Y la petición que sí se puede escribir sigue en el fichero: un nodo raro no hunde la carpeta.
    assert.equal(firstRequest(exported).name, "Crear pedido");
  });

  test("un nodo canal sale en `skipped` diciendo por qué: una colección solo lleva HTTP", () => {
    const exported = toPostmanExport(
      bundle(
        flows([
          { id: "s1", requestTemplateId: "t1" },
          { id: "socket", kind: "channel", channel: { channelId: "c1" }, dependsOn: ["s1"] },
        ]) as never,
      ),
      IDS,
    );
    const entry = exported.skipped.find((skipped) => skipped.what.includes("socket"));
    assert.match(entry!.detail, /es un canal \(WebSocket, MQTT o gRPC\)/);
    const folder = exported.collection.item[0] as { item: unknown[] };
    assert.equal(folder.item.length, 1);
  });
});

describe("ningún secreto sale", () => {
  test("una cabecera de credencial escrita a mano sale vacía y desactivada", () => {
    const exported = toPostmanExport(
      bundle(
        flows(
          [{ id: "s1", requestTemplateId: "t1" }],
          [template({ headers: { Authorization: "Bearer un-token-de-verdad" } })],
        ) as never,
      ),
      IDS,
    );
    const request = firstRequest(exported).request as { header: { key: string; value: string; disabled?: boolean }[] };
    assert.deepEqual(request.header, [{ key: "Authorization", value: "", disabled: true }]);
    assert.doesNotMatch(JSON.stringify(exported.collection), /un-token-de-verdad/);
    assert.ok(exported.skipped.some((entry) => /escrito a mano/.test(entry.detail)));
  });

  test("pero una que es solo variables sale tal cual: no contiene el secreto, contiene su nombre", () => {
    const exported = toPostmanExport(
      bundle(
        flows(
          [{ id: "s1", requestTemplateId: "t1" }],
          [template({ headers: { Authorization: "Bearer {{token}}" } })],
        ) as never,
      ),
      IDS,
    );
    const request = firstRequest(exported).request as { header: { key: string; value: string }[] };
    assert.deepEqual(request.header, [{ key: "Authorization", value: "Bearer {{token}}" }]);
  });

  test("una variable sensible sale con su nombre, sin valor y marcada `secret`", () => {
    const exported = toPostmanExport(
      bundle({
        environments: [
          {
            name: "local",
            baseUrl: "http://localhost:8000",
            specUrl: null,
            variables: {
              api_key: { initial: "clave-que-no-debe-salir", sensitive: true },
              region: { initial: "eu", sensitive: false },
            },
            disabledVariables: { viejo: { initial: "x", sensitive: false } },
          },
        ],
      } as never),
      IDS,
      { environments: true },
    );
    const [environment] = exported.environments;
    assert.equal(environment.name, "local");
    assert.equal(environment._postman_variable_scope, "environment");
    assert.deepEqual(environment.values, [
      { key: "baseUrl", value: "http://localhost:8000", type: "default", enabled: true },
      { key: "api_key", value: "", type: "secret", enabled: true },
      { key: "region", value: "eu", type: "default", enabled: true },
      { key: "viejo", value: "x", type: "default", enabled: false },
    ]);
    assert.doesNotMatch(JSON.stringify(exported), /clave-que-no-debe-salir/);
  });
});

describe("dos colecciones, porque son dos preguntas distintas", () => {
  const withEndpoints = {
    endpoints: [
      {
        method: "GET",
        path: "/pedidos/{id}",
        description: "Uno",
        pathParameters: [{ name: "id", type: "string", description: "", value: "7" }],
        query: [
          { name: "incluir", type: "string", required: false, description: "", value: "todo", enabled: true },
          { name: "viejo", type: "string", required: false, description: "", value: "", enabled: false },
        ],
        headers: [],
        body: { mode: "none", text: "", contentType: "text/plain", fields: [] },
        requiresAuth: false,
        tags: [],
        status: "active",
        operationId: null,
        preRequestScript: "",
        postResponseScript: "",
      },
    ],
  };

  test("los endpoints salen en su propio fichero, y no dentro del de los flujos", () => {
    // Estaban juntos, y cada ida y vuelta añadía un flujo llamado «Endpoints» que nadie escribió.
    const onlyFlows = toPostmanExport(
      bundle({ ...withEndpoints, ...flows([{ id: "s1", requestTemplateId: "t1" }]) } as never),
      IDS,
    );
    assert.deepEqual(
      onlyFlows.collection.item.map((item) => item.name),
      ["Pedidos"],
    );

    const onlyEndpoints = toPostmanExport(bundle(withEndpoints as never), IDS, { contents: "endpoints" });
    assert.equal(onlyEndpoints.collection.info.name, "Tienda · endpoints");
    const [item] = onlyEndpoints.collection.item as {
      name: string;
      request: { url: { raw: string; query: unknown } };
    }[];
    assert.equal(item.name, "GET /pedidos/{id}");
    assert.equal(item.request.url.raw, "{{baseUrl}}/pedidos/7");
    assert.deepEqual(item.request.url.query, [
      { key: "incluir", value: "todo" },
      { key: "viejo", value: "", disabled: true },
    ]);
  });

  test("el volcado es la forma que lee «Export data»: colecciones y entornos en un fichero", () => {
    const withBoth = bundle({
      ...flows([{ id: "s1", requestTemplateId: "t1" }]),
      environments: [{ name: "local", baseUrl: "http://x", specUrl: null, variables: {}, disabledVariables: {} }],
    } as never);
    const dump = toPostmanDump(toPostmanExport(withBoth, IDS, { environments: true }));
    assert.equal(dump.collections.length, 1);
    assert.deepEqual(
      dump.environments.map((environment) => environment.name),
      ["local"],
    );
  });

  test("un fichero que no lleva variables no avisa de variables: el aviso sería sobre nada", () => {
    // Traducir los entornos siempre llenaba una colección —que no lleva ninguna variable— de
    // «la variable X es sensible y sale sin valor», que es avisar de algo que no está pasando.
    const withSecret = bundle({
      ...flows([{ id: "s1", requestTemplateId: "t1" }]),
      environments: [
        {
          name: "local",
          baseUrl: "http://x",
          specUrl: null,
          variables: { api_key: { initial: "x", sensitive: true } },
          disabledVariables: {},
        },
      ],
    } as never);
    assert.deepEqual(toPostmanExport(withSecret, IDS).skipped, []);
    assert.ok(toPostmanExport(withSecret, IDS, { environments: true }).skipped.length > 0);
  });
});
