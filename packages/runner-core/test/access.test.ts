/**
 * Quién puede llegar a qué, que es la pregunta que la matriz generada no sabe hacer.
 *
 * Todo lo demás en el generador sale del contrato: una operación que deja de declarar 403 deja de
 * tener el caso, y esa es la diferencia entre una matriz y una copia de una matriz. Pero un
 * contrato declara que `403` es una respuesta posible, nunca **a quién**. «El rol vendedor no debe
 * poder leer un pedido» es conocimiento del negocio, así que se escribe y se lee de un sitio.
 *
 * Lo que hay que asegurar es que el silencio no genera nada. Un rol que no aparece en ninguna de
 * las dos listas es uno sobre el que este proyecto todavía no ha decidido, y generarle un caso
 * sería la herramienta inventándose un requisito — el mismo error que dar por implementado todo lo
 * que el contrato declara.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { defineProjectConfig } from "../src/config.ts";
import { resolveOperations, scenariosFor } from "../src/scenarios.ts";
import { planFlow, type StepRequest } from "../src/flow.ts";
import type { ActualResponse } from "../src/assertions.ts";
import type { Operation, TestScenario } from "../src/types.ts";

const operations: Operation[] = [
  {
    id: "getPedido",
    method: "GET",
    path: "/pedidos/{id}",
    summary: "Un pedido",
    tag: "Pedidos",
    statuses: [200, 403, 404],
    parameters: ["id"],
  },
  {
    id: "crearPedido",
    method: "POST",
    path: "/pedidos",
    summary: "Alta de pedido",
    tag: "Pedidos",
    statuses: [201, 403],
    parameters: [],
  },
  // Aquí para que el caso entre roles tenga con qué recoger lo que creó: sin un DELETE el flujo
  // deja la fila puesta, que es correcto y es lo que se comprueba más abajo.
  {
    id: "borrarPedido",
    method: "DELETE",
    path: "/pedidos/{id}",
    summary: "Baja de pedido",
    tag: "Pedidos",
    statuses: [204, 404],
    parameters: ["id"],
  },
];

const configOf = (access: Partial<ReturnType<typeof defineProjectConfig>["access"]> = {}) =>
  defineProjectConfig({
    access: {
      roles: ["vendedor", "comprador", "admin"],
      deniedStatuses: [403, 404],
      rules: [],
      crossRole: [],
      ...access,
    },
    bodyTemplates: { crearPedido: { body: { total: 10 } } },
  });

const casesFor = (operationId: string, config: ReturnType<typeof defineProjectConfig>): TestScenario[] => {
  const resolved = resolveOperations(operations, config);
  const operation = resolved.find((candidate) => candidate.id === operationId)!;
  return scenariosFor(operation, config).filter((scenario) => scenario.id.startsWith("access-"));
};

/**
 * Una sección guardada a medias sigue dando una configuración completa.
 *
 * Es lo que costó aprender: los campos de esta sección tienen valor por defecto en el esquema, así
 * que una fila guardada puede llegar legítimamente sin `deniedStatuses`, y una fusión superficial
 * sustituía el objeto entero por ese parcial. El tipo seguía diciendo que el campo estaba, el
 * generador lo leía, y la matriz contestaba 500 a todo proyecto que hubiera guardado la sección.
 * Un valor por defecto que solo existe al parsear no es un valor por defecto del que el resto del
 * código pueda fiarse.
 */
describe("una sección access escrita en trozos", () => {
  test("lo que no trae la fila lo pone el valor por defecto, no el vacío", () => {
    const partial = defineProjectConfig({
      access: { roles: ["vendedor"], rules: [{ operationId: "getPedido", allow: [], deny: ["vendedor"] }] } as never,
    });
    assert.deepEqual(partial.access.deniedStatuses, [403, 404]);
    assert.deepEqual(partial.access.crossRole, []);
  });

  test("y con eso la matriz se genera en vez de reventar", () => {
    const partial = defineProjectConfig({
      access: { roles: ["vendedor"], rules: [{ operationId: "getPedido", allow: [], deny: ["vendedor"] }] } as never,
    });
    const operation = resolveOperations(operations, partial).find((candidate) => candidate.id === "getPedido")!;
    const [scenario] = scenariosFor(operation, partial).filter((item) => item.id.startsWith("access-"));
    assert.equal(scenario.expectedStatus, 403);
  });
});

describe("un caso por celda de la matriz de permisos", () => {
  test("sin reglas no se genera ningún caso: el silencio no es «no debe pasar»", () => {
    assert.deepEqual(casesFor("getPedido", configOf()), []);
  });

  test("un rol que debe pasar espera el éxito que el contrato declara", () => {
    const [scenario] = casesFor(
      "crearPedido",
      configOf({ rules: [{ operationId: "crearPedido", allow: ["vendedor"], deny: [] }] }),
    );
    assert.equal(scenario.id, "access-allow-vendedor");
    assert.equal(scenario.auth, "role:vendedor");
    // 201, no 200: un 200 fijo haría fallar a todo rol permitido sobre un POST que contesta 201
    // correctamente, y el informe culparía al permiso.
    assert.equal(scenario.expectedStatus, 201);
  });

  test("un rol que no debe pasar acepta los dos códigos de rechazo", () => {
    const [scenario] = casesFor(
      "getPedido",
      configOf({ rules: [{ operationId: "getPedido", allow: [], deny: ["vendedor"] }] }),
    );
    assert.equal(scenario.id, "access-deny-vendedor");
    assert.equal(scenario.expectedStatus, 403);
    // Una API bien hecha esconde la existencia y contesta 404; exigir 403 la pondría en rojo justo
    // por estar mejor construida. El hallazgo es «pudo leerlo», no «el código no fue 403».
    assert.deepEqual(scenario.alsoAccepted, [404]);
  });

  test("un proyecto que sabe que su API siempre contesta 403 puede estrecharlo", () => {
    const [scenario] = casesFor(
      "getPedido",
      configOf({ deniedStatuses: [403], rules: [{ operationId: "getPedido", allow: [], deny: ["vendedor"] }] }),
    );
    assert.equal(scenario.expectedStatus, 403);
    assert.equal(scenario.alsoAccepted, undefined);
  });

  test("una regla de otra operación no genera nada aquí", () => {
    const config = configOf({ rules: [{ operationId: "crearPedido", allow: ["vendedor"], deny: [] }] });
    assert.deepEqual(casesFor("getPedido", config), []);
  });

  test("el cuerpo viaja con la escritura, o el rechazo no prueba nada sobre permisos", () => {
    // Una petición rechazada por tener el cuerpo mal no dice nada de quién la mandaba, que es
    // exactamente lo que este caso viene a averiguar.
    const [scenario] = casesFor(
      "crearPedido",
      configOf({ rules: [{ operationId: "crearPedido", allow: [], deny: ["comprador"] }] }),
    );
    assert.deepEqual(scenario.body, { total: 10 });
  });

  test("una celda por rol, en el orden en que se escribieron", () => {
    const cases = casesFor(
      "getPedido",
      configOf({ rules: [{ operationId: "getPedido", allow: ["admin", "comprador"], deny: ["vendedor"] }] }),
    );
    assert.deepEqual(
      cases.map((scenario) => scenario.id),
      ["access-allow-admin", "access-allow-comprador", "access-deny-vendedor"],
    );
  });

  test("el nombre y la descripción dicen de qué rol hablan", () => {
    const [scenario] = casesFor(
      "getPedido",
      configOf({ rules: [{ operationId: "getPedido", allow: [], deny: ["vendedor"] }] }),
    );
    assert.match(scenario.name, /vendedor/);
    assert.match(scenario.description, /GET \/pedidos\/\{id\}/);
  });
});

/**
 * Crear como un rol y alcanzarlo como otro, que es el caso que una petición suelta no puede hacer.
 *
 * Todo lo demás en `flow.ts` trabaja sobre un recurso cuyo dueño da igual; este va justo de eso, así
 * que el recurso tiene que crearse **durante la corrida**, por el rol que la regla nombra y con un
 * id que nadie adivinó. Ir a por un id semilla no probaría nada: una fixture es de quien digan las
 * fixtures, y la mitad de las veces es del rol que pregunta.
 *
 * Y el paso de preparación no es el caso. Si falla no hay nada que alcanzar, así que el flujo para
 * en vez de anotar un hallazgo de permisos sobre un recurso que nunca existió — «vendedor no pudo
 * leerlo» no significa nada si nadie lo creó.
 */
describe("el caso entre roles", () => {
  const config = configOf({
    crossRole: [
      {
        source: "comprador",
        target: "vendedor",
        createOperationId: "crearPedido",
        operationId: "getPedido",
        allowed: false,
      },
    ],
  });
  const resolved = resolveOperations(operations, config);
  const operation = resolved.find((candidate) => candidate.id === "getPedido")!;
  const scenario = scenariosFor(operation, config).find((item) => item.flow === "cross-role")!;

  /** Walks the generator, answering every step with a created resource so the flow proceeds. */
  const walk = (outcome: (step: StepRequest) => { ok: boolean; body?: unknown }): StepRequest[] => {
    const flow = planFlow({ operation, scenario, config, operations: resolved, samples: 1 });
    const steps: StepRequest[] = [];
    let cursor = flow.next();
    while (!cursor.done) {
      steps.push(cursor.value);
      const answered = outcome(cursor.value);
      const actual: ActualResponse = {
        status: 201,
        statusText: "",
        contentType: "application/json",
        headers: {},
        body: answered.body ?? { data: { id: "pedido-de-comprador" } },
        raw: "",
      };
      cursor = flow.next({ request: cursor.value, actual, ok: answered.ok, assertions: [] });
    }
    return steps;
  };

  test("el caso existe y espera un rechazo", () => {
    assert.equal(scenario.expectedStatus, 403);
    assert.deepEqual(scenario.alsoAccepted, [404]);
    assert.equal(scenario.auth, "role:vendedor");
  });

  test("primero crea como el dueño, y solo después pregunta como el otro", () => {
    const steps = walk(() => ({ ok: true }));
    assert.deepEqual(
      steps.map((step) => [step.purpose, step.auth]),
      [
        ["prepare", "role:comprador"],
        ["act", "role:vendedor"],
        ["cleanup", "role:comprador"],
      ],
    );
  });

  test("el paso que pregunta va contra el id que se acaba de crear, no contra una semilla", () => {
    // Es la diferencia entre probar que un rol no ve lo ajeno y probar que no ve la fila 1, que
    // puede ser suya.
    const act = walk(() => ({ ok: true })).find((step) => step.purpose === "act")!;
    assert.match(act.requestPath, /pedido-de-comprador/);
  });

  test("si la creación falla no se pregunta nada", () => {
    // Sin recurso no hay caso: anotar «vendedor no pudo leerlo» sobre algo que nunca existió sería
    // un verde que no prueba nada.
    const steps = walk((step) => ({ ok: step.purpose !== "prepare" }));
    assert.deepEqual(
      steps.map((step) => step.purpose),
      ["prepare"],
    );
  });

  test("si la respuesta de la creación no trae id tampoco", () => {
    const steps = walk((step) => (step.purpose === "prepare" ? { ok: true, body: { data: {} } } : { ok: true }));
    assert.deepEqual(
      steps.map((step) => step.purpose),
      ["prepare"],
    );
  });

  test("la limpieza va como el dueño, que es el único rol seguro para borrarlo", () => {
    // Borrar como el rol del caso sería una segunda aserción de permisos escondida en una limpieza,
    // y un rojo ahí contaría un fallo de recogida como si el caso hubiera encontrado algo.
    const cleanup = walk(() => ({ ok: true })).find((step) => step.purpose === "cleanup")!;
    assert.equal(cleanup.auth, "role:comprador");
  });

  test("una regla permitida espera el éxito que el contrato declara", () => {
    const allowed = configOf({
      crossRole: [
        {
          source: "comprador",
          target: "admin",
          createOperationId: "crearPedido",
          operationId: "getPedido",
          allowed: true,
        },
      ],
    });
    const built = scenariosFor(
      resolveOperations(operations, allowed).find((candidate) => candidate.id === "getPedido")!,
      allowed,
    ).find((item) => item.flow === "cross-role")!;
    assert.equal(built.expectedStatus, 200);
    assert.equal(built.alsoAccepted, undefined);
  });

  test("dos reglas sobre el mismo par no colisionan de id", () => {
    // Un proyecto puede escribir «leer sí, borrar no» sobre los mismos dos roles, y dos casos con
    // el mismo id se pisarían el veredicto en la corrida.
    const twice = configOf({
      crossRole: [
        {
          source: "comprador",
          target: "vendedor",
          createOperationId: "crearPedido",
          operationId: "getPedido",
          allowed: false,
        },
        {
          source: "comprador",
          target: "vendedor",
          createOperationId: "crearPedido",
          operationId: "getPedido",
          allowed: true,
        },
      ],
    });
    const ids = scenariosFor(
      resolveOperations(operations, twice).find((candidate) => candidate.id === "getPedido")!,
      twice,
    )
      .filter((item) => item.flow === "cross-role")
      .map((item) => item.id);
    assert.equal(new Set(ids).size, 2);
  });
});
