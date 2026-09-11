/**
 * El mismo informe, escrito para los dos lectores que no son un programa leyendo JSON.
 *
 * Son funciones puras sobre lo que la consulta ya construye, así que se comprueban aquí y sin
 * contenedor. Lo que hay que asegurar es lo de siempre en un generador de texto: **que el escapado
 * no se olvide en ningún sitio**. Cada cadena que entra vino de la respuesta de un destino o del
 * nombre que alguien le puso a un endpoint, y un `<` sin escapar no produce un informe feo — produce
 * un fichero que el runner de CI rechaza, y el mensaje habla del fichero y no del endpoint.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { escapeHtml, escapeXml, toHtmlReport, toJUnitXml } from "@/modules/runs/presentation/report-formats";
import type { ReportCase, RunReport } from "@/modules/runs/application/queries/get-run";

const runCase = (overrides: Partial<ReportCase> = {}): ReportCase =>
  ({
    id: "c1",
    operationId: "listWidgets",
    scenarioId: "lista-vacia",
    method: "GET",
    path: "/widgets",
    status: "passed",
    failure: null,
    position: 0,
    durationMs: 12,
    startedAt: null,
    finishedAt: null,
    steps: [],
    ...overrides,
  }) as ReportCase;

const report = (overrides: { cases?: ReportCase[]; run?: Partial<RunReport["run"]> } = {}): RunReport =>
  ({
    run: {
      id: "run-1",
      projectId: "p1",
      environmentId: "e1",
      status: "failed",
      totals: { cases: 2, completed: 2, passed: 1, failed: 1, skipped: 0 },
      source: { kind: "matrix", operationIds: ["listWidgets"], labels: [] },
      startedAt: new Date("2026-09-11T10:00:00.000Z"),
      finishedAt: new Date("2026-09-11T10:00:02.500Z"),
      error: null,
      ...overrides.run,
    },
    cases: overrides.cases ?? [runCase()],
  }) as RunReport;

const failing = (overrides: Partial<ReportCase> = {}) =>
  runCase({
    status: "failed",
    failure: "contract",
    steps: [
      {
        index: 0,
        purpose: "act",
        label: "Listar",
        ok: false,
        durationMs: 12,
        assertions: [
          { label: "Status 200", pass: true, detail: "Recibido 200" },
          { label: "Envelope { data }", pass: false, detail: "La respuesta no trae data" },
          { label: "Deriva", pass: false, detail: "campo no declarado", severity: "warning" },
        ],
      },
    ],
    ...overrides,
  });

describe("el escapado", () => {
  test("los cinco caracteres de XML salen escapados", () => {
    assert.equal(escapeXml(`<a href="x">&'`), "&lt;a href=&quot;x&quot;&gt;&amp;&apos;");
  });

  test("un carácter de control se cae, porque XML 1.0 tampoco lo admite escapado", () => {
    // `&#1;` no es XML 1.0 válido, así que escaparlo no arreglaría nada: el fichero seguiría sin
    // poder abrirse, y el error hablaría del fichero.
    assert.equal(escapeXml("a\u0001b"), "ab");
  });

  test("el salto de línea se conserva: un detalle de fallo multilínea es justo donde aparece", () => {
    assert.equal(escapeXml("a\nb\tc"), "a\nb\tc");
  });

  test("el escapado de HTML cubre los cuatro que importan dentro de un atributo", () => {
    assert.equal(escapeHtml(`<b class="x">&`), "&lt;b class=&quot;x&quot;&gt;&amp;");
  });
});

/**
 * JUnit es lo que hace que un CI enseñe los casos rojos en su propia interfaz, con el texto del
 * fallo al lado del test que lo produjo. Sin él, una tubería puede decir «la corrida falló» y nada
 * sobre cuál de 311 casos lo hizo, así que alguien abre el navegador — que es el bucle que un
 * informe de CI existe para quitar.
 */
describe("el informe en JUnit XML", () => {
  test("agrupa por operación, que es por donde una interfaz de CI pliega la lista", () => {
    const xml = toJUnitXml(
      report({ cases: [runCase(), runCase({ id: "c2", operationId: "createWidget", method: "POST" })] }),
    );
    assert.ok(xml.includes('<testsuite name="listWidgets"'), xml);
    assert.ok(xml.includes('<testsuite name="createWidget"'), xml);
  });

  test("un caso que falló lleva su tipo de fallo y el texto de lo que no se cumplió", () => {
    const xml = toJUnitXml(report({ cases: [failing()] }));
    assert.ok(xml.includes('<failure type="contract" message="Envelope { data }"'), xml);
    assert.ok(xml.includes("Envelope { data }: La respuesta no trae data"), xml);
  });

  test("un aviso no es un fallo, así que no entra en el mensaje", () => {
    // Un campo que la API devolvió y su propio documento no declara merece contarse y no poner el
    // caso en rojo; meterlo aquí lo convertiría en rojo en la interfaz del CI.
    assert.ok(!toJUnitXml(report({ cases: [failing()] })).includes("campo no declarado"));
  });

  test("un caso saltado es <skipped/> y no un fallo", () => {
    const xml = toJUnitXml(report({ cases: [runCase({ status: "skipped" })] }));
    assert.ok(xml.includes("<skipped/>"), xml);
    assert.ok(!xml.includes("<failure"), xml);
  });

  test("un caso que pasó no lleva cuerpo ninguno", () => {
    assert.ok(toJUnitXml(report()).includes('time="0.012"></testcase>'));
  });

  test("los totales del encabezado son los de la corrida, no los de la suma de suites", () => {
    // La corrida sabe cuántos casos encoló; sumar las suites contaría solo los que llegaron a
    // escribirse, y una corrida cancelada saldría verde.
    assert.ok(toJUnitXml(report()).includes('tests="2" failures="1" skipped="0"'));
  });

  test("un nombre de operación con caracteres de XML no rompe el documento", () => {
    const xml = toJUnitXml(report({ cases: [runCase({ operationId: 'a<b&c"d' })] }));
    assert.ok(xml.includes('<testsuite name="a&lt;b&amp;c&quot;d"'), xml);
  });

  test("el título dice por qué se seleccionó, y no se contradice", () => {
    // «pagos · todas las operaciones» serían dos afirmaciones y una estaría mal.
    const byLabel = report({ run: { source: { kind: "matrix", operationIds: [], labels: ["pagos"] } } });
    assert.ok(toJUnitXml(byLabel).includes('name="Matriz · pagos"'), toJUnitXml(byLabel).slice(0, 200));
    const whole = report({ run: { source: { kind: "matrix", operationIds: [], labels: [] } } });
    assert.ok(toJUnitXml(whole).includes("Matriz · todas las operaciones"));
  });

  test("el tiempo es el del reloj de pared, no la suma de los casos", () => {
    // Los casos pueden correr varios a la vez, así que sumarlos daría más tiempo del que pasó.
    assert.ok(toJUnitXml(report()).includes('time="2.500"'));
  });
});

/**
 * El HTML es para quien recibe un enlace: se abre. Un JSON hay que pasarlo antes por `jq`.
 *
 * Sin plantillas y sin nada que pedir por la red, porque acaba de artefacto en un CI, de adjunto
 * en un ticket, o abierto desde el disco seis meses después — y una página que descarga algo se ve
 * distinta, o no se ve, en cada uno de esos sitios.
 */
describe("el informe en HTML", () => {
  test("los casos que fallaron van primero y el resto detrás de un desplegable", () => {
    const html = toHtmlReport(report({ cases: [runCase(), failing({ id: "c2" })] }));
    assert.ok(html.indexOf("Fallaron (1)") < html.indexOf("El resto (1)"), html.slice(0, 400));
  });

  test("no pide nada por la red: ni hoja de estilos, ni script, ni imagen", () => {
    const html = toHtmlReport(report({ cases: [failing()] }));
    assert.ok(!/<script|<link|src=|@import/i.test(html), "la página carga algo de fuera");
  });

  test("lo que devolvió el destino va escapado: es texto ajeno dentro de la página", () => {
    const html = toHtmlReport(
      report({
        cases: [
          failing({
            steps: [
              {
                index: 0,
                purpose: "act",
                label: "<script>alert(1)</script>",
                ok: false,
                durationMs: 1,
                assertions: [{ label: "<img onerror=x>", pass: false, detail: "<b>malo</b>" }],
              },
            ],
          }),
        ],
      }),
    );
    assert.ok(!html.includes("<img onerror"), html);
    assert.ok(html.includes("&lt;img onerror=x&gt;"), html);
    assert.ok(html.includes("&lt;b&gt;malo&lt;/b&gt;"), html);
  });

  test("una corrida sin rojos lo dice en vez de enseñar una tabla vacía", () => {
    assert.ok(toHtmlReport(report()).includes("No falló ningún caso"));
  });

  test("dice de dónde salió la corrida, porque un informe sin eso no es evidencia de nada", () => {
    const html = toHtmlReport(
      report({
        run: {
          source: {
            kind: "workflow",
            workflowId: "w1",
            name: "Alta de pedido",
            datasetId: null,
            datasetName: null,
            rows: 1,
          },
        },
      }),
    );
    assert.ok(html.includes("Flujo Alta de pedido"), html);
  });
});
