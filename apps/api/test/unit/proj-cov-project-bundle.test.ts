/**
 * El fichero de proyecto por dentro: lo que el lector rechaza y dónde lo dice, cómo se mueven las
 * referencias de un grafo, qué sub-flujos arrastra un flujo, y cada validador por el que pasa cada
 * parte antes de escribir nada.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";

import {
  bundleProblems,
  channelInputOf,
  missingOperations,
  parseProjectBundle,
  partsIn,
  remapDefinition,
  withSubflows,
  type BundleChannel,
  type ProjectBundle,
} from "@/modules/projects/domain/project-bundle";
import type { ProjectBundlePart } from "@eq/contracts";

const CEILINGS = {
  maxMessages: 200,
  maxBytes: 1024 * 1024,
  maxMessageBytes: 64 * 1024,
  maxDurationMs: 30_000,
  idleMs: 10_000,
  maxOpen: 5,
};

const parse = (data: unknown): ProjectBundle => {
  const parsed = parseProjectBundle(data);
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.issues));
  return parsed.bundle;
};
const base = { format: "endpoint-quality/project", version: 1 };
const noIds = () => ({ templates: new Map<string, string>(), workflows: new Map<string, string>(), channels: new Map<string, string>() });
const problemsOf = (bundle: ProjectBundle, parts: ProjectBundlePart[], ids = noIds()) =>
  bundleProblems(bundle, new Set(parts), ids, CEILINGS);
const fields = (problems: { field: string }[]) => problems.map((problem) => problem.field);

describe("leer el fichero", () => {
  test("algo que no es un objeto se rechaza en `bundle`, no en un campo inventado", () => {
    const parsed = parseProjectBundle(null);
    assert.equal(parsed.ok, false);
    assert.equal(!parsed.ok && parsed.issues[0]!.field, "bundle");
  });

  test("una versión más nueva dice que hay que actualizar, en su campo", () => {
    const parsed = parseProjectBundle({ ...base, version: 99 });
    assert.equal(parsed.ok, false);
    assert.deepEqual(!parsed.ok && parsed.issues.map((issue) => issue.field), ["version"]);
    assert.match(!parsed.ok ? parsed.issues[0]!.detail : "", /versión más nueva/);
  });

  test("las partes que trae: un contrato en blanco y unos flujos vacíos no cuentan", () => {
    assert.deepEqual(partsIn(parse({ ...base, contract: { raw: "   " }, flows: {} })), []);
    assert.deepEqual(
      partsIn(parse({ ...base, settings: {}, roleRules: [{ source: "a", target: "b" }], environments: [] })),
      ["settings", "roles"],
    );
    assert.deepEqual(
      partsIn(
        parse({
          ...base,
          flows: { requestTemplates: [{ id: "t", name: "T", operationId: "op", expectedStatus: 200 }] },
          performance: [{ name: "p", definition: {} }],
        }),
      ),
      ["flows", "performance"],
    );
  });
});

describe("el canal tal como lo recibiría su editor", () => {
  const channel = (patch: Record<string, unknown> = {}) =>
    parse({ ...base, flows: { channels: [{ id: "c", name: "C", url: "wss://x.test", ...patch }] } }).flows!.channels[0]!;

  test("lo que no trae no aparece; lo que trae, sí", () => {
    assert.deepEqual(channelInputOf(channel()), { protocol: "ws", name: "C", url: "wss://x.test" });
    const full = channelInputOf(
      channel({
        subprotocols: ["v1"],
        headers: [{ name: "X", value: "1" }],
        auth: { type: "none" },
        limits: { maxMessages: 3 },
        expectations: [],
        messages: [],
        mqtt: { topic: "a" },
        grpc: { service: "s" },
        socketio: { path: "/io" },
      }) as BundleChannel,
    );
    assert.deepEqual(Object.keys(full).sort(), [
      "auth",
      "expectations",
      "grpc",
      "headers",
      "limits",
      "messages",
      "mqtt",
      "name",
      "protocol",
      "socketio",
      "subprotocols",
      "url",
    ]);
    assert.deepEqual(full.headers, [{ name: "X", value: "1", enabled: true }]);
  });
});

describe("las referencias del grafo", () => {
  test("un sub-flujo y un canal conocidos se mueven; los desconocidos se dicen", () => {
    const definition = {
      steps: [
        { id: "a", kind: "subflow", subflow: { workflowId: "w-old" } },
        { id: "b", kind: "channel", channel: { channelId: "c-old", mode: "x" } },
        { id: "c", kind: "subflow", subflow: { workflowId: "w-nada" } },
        { id: "d", kind: "channel", channel: { channelId: "c-nada" } },
        { id: "e", kind: "subflow", subflow: {} },
      ],
    };
    const { definition: moved, missing } = remapDefinition(
      definition,
      new Map(),
      new Map([["w-old", "w-new"]]),
      new Map([["c-old", "c-new"]]),
    );
    assert.deepEqual(moved.steps[0], { id: "a", kind: "subflow", subflow: { workflowId: "w-new" } });
    assert.deepEqual(moved.steps[1], { id: "b", kind: "channel", channel: { channelId: "c-new", mode: "x" } });
    assert.deepEqual(moved.steps[4], { id: "e", kind: "subflow", subflow: {} });
    assert.deepEqual(fields(missing), ["steps.2.subflow.workflowId", "steps.3.channel.channelId"]);
  });

  test("sin mapa de canales, cualquier canal falta", () => {
    const { missing } = remapDefinition(
      { steps: [{ id: "b", channel: { channelId: "c" } }] },
      new Map(),
      new Map(),
    );
    assert.deepEqual(fields(missing), ["steps.0.channel.channelId"]);
  });

  test("los sub-flujos se arrastran de forma transitiva, sin repetir ni colgarse en un ciclo", () => {
    const flow = (id: string, runs: string[]) => ({
      id,
      definition: { steps: runs.map((target) => ({ id: `s-${target}`, kind: "subflow", subflow: { workflowId: target } })) },
    });
    const all = [flow("a", ["b"]), flow("b", ["c", "a", "fantasma"]), flow("c", []), flow("d", [])];
    all[2]!.definition.steps.push({ id: "x", kind: "request" } as never, { id: "y", kind: "subflow" } as never);
    assert.deepEqual(
      withSubflows(all, ["a"]).map((flow) => flow.id),
      ["a", "b", "c"],
    );
    assert.deepEqual(withSubflows(all, ["no-existe"]), []);
  });

  test("las peticiones cuya operación no está en el contrato se nombran con su operación", () => {
    assert.deepEqual(
      missingOperations(
        [
          { name: "Uno", operationId: "a" },
          { name: "Dos", operationId: "b" },
        ],
        new Set(["a"]),
      ),
      ["Dos (b)"],
    );
  });
});

describe("cada parte por su validador", () => {
  test("ajustes: una baseUrl inválida sale con el prefijo `settings`; sin baseUrl no se mira", () => {
    const bad = problemsOf(parse({ ...base, settings: { baseUrl: "no es url" } }), ["settings"]);
    assert.ok(bad.length > 0);
    assert.ok(bad.every((problem) => problem.field.startsWith("settings.")));
    assert.deepEqual(problemsOf(parse({ ...base, settings: {} }), ["settings"]), []);
    // Parte no elegida: no se valida aunque esté mal.
    assert.deepEqual(problemsOf(parse({ ...base, settings: { baseUrl: "no es url" } }), ["contract"]), []);
  });

  test("contrato: un texto que no es YAML ni JSON se dice como ilegible", () => {
    const problems = problemsOf(parse({ ...base, contract: { raw: "{ [ :" } }), ["contract"]);
    assert.ok(problems.length > 0);
    assert.ok(problems.every((problem) => problem.field === "contract" || problem.field.startsWith("contract.")));

    // Un documento legible con errores los dice en su puntero; los avisos no cuentan.
    const swagger = problemsOf(parse({ ...base, contract: { raw: '{"swagger":"2.0","paths":{}}' } }), ["contract"]);
    assert.deepEqual(fields(swagger), ["contract.#/swagger"]);
    assert.match(swagger[0]!.detail, /Swagger 2\.0 no está soportado/);
  });

  test("configuración: una sección que no existe y una sección con datos rotos", () => {
    const problems = problemsOf(
      parse({
        ...base,
        config: [
          { section: "inventada", data: {} },
          { section: "implemented", data: { implemented: 5 } },
          { section: "implemented", data: { implemented: null } },
        ],
      }),
      ["config"],
    );
    assert.equal(problems[0]!.field, "config.0.section");
    assert.match(problems[0]!.detail, /no existe la sección inventada/);
    assert.ok(problems.slice(1).every((problem) => problem.field.startsWith("config.1")));
    assert.ok(problems.length >= 2);
  });

  test("roles: el mismo nombre dos veces, sin mirar mayúsculas", () => {
    const problems = problemsOf(
      parse({
        ...base,
        roles: [
          { name: "Admin", color: "#112233" },
          { name: "admin" },
        ],
      }),
      ["roles"],
    );
    assert.deepEqual(
      problems.filter((problem) => /dos veces/.test(problem.detail)).map((problem) => problem.field),
      ["roles.1.name"],
    );
  });

  test("endpoints: pasan por el validador del editor de endpoints", () => {
    const problems = problemsOf(parse({ ...base, endpoints: [{ method: "GET", path: "sin-barra" }] }), ["endpoints"]);
    assert.ok(problems.some((problem) => problem.field.startsWith("endpoints.0.")));
  });

  test("flujos: ids repetidos, referencias que faltan, grafos y filas inválidas, suites a nada", () => {
    const bundle = parse({
      ...base,
      flows: {
        requestTemplates: [
          {
            id: "t1",
            name: "Uno",
            operationId: "a",
            expectedStatus: 200,
            description: "con descripción",
            body: { type: "json", json: {} },
            auth: "none",
          },
          { id: "t1", name: "Dos", operationId: "b", expectedStatus: 200, headers: { "": "x" } },
        ],
        workflows: [
          { id: "w1", name: "Uno", definition: { steps: [{ id: "s", requestTemplateId: "fantasma" }] } },
          { id: "w1", name: "Dos", definition: { steps: [{ id: "s", kind: "inventado" }] } },
        ],
        datasets: [{ workflowId: "otro", name: "D", rows: "no son filas" }],
        suites: [{ name: "S", workflowIds: ["w1", "nada"] }],
        channels: [
          { id: "c1", name: "C", url: "wss://x.test", protos: [{ path: "/abs.proto", content: "x" }] },
          { id: "c1", name: "C2", url: "wss://y.test" },
        ],
      },
    });
    const ids = {
      templates: new Map([["t1", "T1"]]),
      workflows: new Map([["w1", "W1"]]),
      channels: new Map([["c1", "C1"]]),
    };
    const problems = problemsOf(bundle, ["flows"], ids);
    const found = fields(problems);
    for (const expected of [
      "flows.channels",
      "flows.channels.0.protos.files.0.path",
      "flows.requestTemplates",
      "flows.workflows",
      "flows.workflows.0.definition.steps.0.requestTemplateId",
      "flows.datasets.0.workflowId",
      "flows.suites.0.workflowIds.1",
    ])
      assert.ok(found.includes(expected), `falta ${expected} en ${found.join(", ")}`);
    assert.ok(found.some((field) => field.startsWith("flows.workflows.1.")), "el grafo inválido se dice");
    assert.ok(found.some((field) => field.startsWith("flows.datasets.0.") && field !== "flows.datasets.0.workflowId"));
    assert.ok(found.some((field) => field.startsWith("flows.requestTemplates.1.")), "la petición inválida se dice");
    assert.ok(!found.some((field) => field.startsWith("flows.requestTemplates.0.")), "la válida no");
    assert.ok(!found.includes("flows.suites.0.workflowIds.0"));
  });

  test("entornos: una URL que no es http y una que no es absoluta, cada una con su frase", () => {
    const problems = problemsOf(
      parse({
        ...base,
        environments: [
          { name: "a", baseUrl: "ftp://x.test" },
          { name: "b", baseUrl: "relativa" },
          { name: "c", baseUrl: "https://ok.test" },
        ],
      }),
      ["environments"],
    );
    assert.deepEqual(problems, [
      { field: "environments.0.baseUrl", detail: "Solo http o https" },
      { field: "environments.1.baseUrl", detail: "Debe ser una URL absoluta" },
    ]);
  });

  test("rendimiento: un plan inválido sale con su índice", () => {
    const problems = problemsOf(parse({ ...base, performance: [{ name: "p", definition: { nada: true } }] }), [
      "performance",
    ]);
    assert.ok(problems.length > 0);
    assert.ok(problems.every((problem) => problem.field.startsWith("performance.0.")));
  });
});
