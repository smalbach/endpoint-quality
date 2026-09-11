import { test } from "node:test";
import assert from "node:assert/strict";

import { defineProjectConfig } from "../src/config.ts";
import { resolveOperations } from "../src/scenarios.ts";
import { buildQueue, moveOperation, orderOperations, selectedCases } from "../src/execution-plan.ts";
import type { Operation } from "../src/types.ts";

const operations: Operation[] = [
  {
    id: "deleteThing",
    method: "DELETE",
    path: "/things/{id}",
    summary: "",
    tag: "T",
    statuses: [204, 404],
    parameters: ["id"],
  },
  { id: "listThings", method: "GET", path: "/things", summary: "", tag: "T", statuses: [200], parameters: ["q"] },
  { id: "createThing", method: "POST", path: "/things", summary: "", tag: "T", statuses: [201, 422], parameters: [] },
  {
    id: "getThing",
    method: "GET",
    path: "/things/{id}",
    summary: "",
    tag: "T",
    statuses: [200, 404],
    parameters: ["id"],
  },
];

const config = defineProjectConfig({
  parameterSamples: { q: ["a"] },
  bodyTemplates: { createThing: { body: { name: "x" } } },
});
const resolved = resolveOperations(operations, config);
const ids = (list: { id: string }[]) => list.map((item) => item.id);

test("el modo contrato conserva el orden declarado", () => {
  assert.deepEqual(ids(orderOperations(resolved, "contract", [])), [
    "deleteThing",
    "listThings",
    "createThing",
    "getThing",
  ]);
});

test("el modo seguro pone las lecturas primero y los deletes al final", () => {
  // Alphabetically the DELETE comes before the GET of the same path, so a delete would be
  // measured before the read that would have shown the endpoint was already broken — and
  // anything it destroys takes the rest of the matrix with it.
  assert.deepEqual(ids(orderOperations(resolved, "safe", [])), [
    "listThings",
    "getThing",
    "createThing",
    "deleteThing",
  ]);
});

test("dentro del mismo método se conserva el orden del contrato", () => {
  const order = ids(orderOperations(resolved, "safe", []));
  assert.ok(order.indexOf("listThings") < order.indexOf("getThing"));
});

test("el orden personalizado no pierde lo que no menciona", () => {
  // An id the custom order never names keeps the contract order, placed after everything that
  // was ordered by hand — dropping it silently would shrink the run without saying so.
  const order = ids(orderOperations(resolved, "custom", ["getThing", "createThing"]));
  assert.deepEqual(order, ["getThing", "createThing", "deleteThing", "listThings"]);
  assert.equal(order.length, resolved.length);
});

test("mover fuera de rango devuelve el mismo arreglo", () => {
  const order = ["a", "b", "c"];
  assert.equal(moveOperation(order, "a", -1), order);
  assert.equal(moveOperation(order, "c", 1), order);
  assert.equal(moveOperation(order, "ausente", 1), order);
  assert.deepEqual(moveOperation(order, "b", -1), ["b", "a", "c"]);
});

test("una selección vacía de casos vacía el endpoint en vez de correrlo entero", () => {
  const listThings = resolved.find((operation) => operation.id === "listThings")!;
  assert.equal(selectedCases(listThings, config, {}, false).length, 2);
  assert.equal(selectedCases(listThings, config, { listThings: [] }, false).length, 0);
  assert.deepEqual(
    selectedCases(listThings, config, { listThings: ["default"] }, false).map((scenario) => scenario.id),
    ["default"],
  );
});

test("la cola respeta el subconjunto de operaciones pedido", () => {
  const queue = buildQueue(resolved, config, { mode: "safe", operationIds: ["getThing"], authEnabled: false });
  assert.deepEqual(
    queue.map((item) => `${item.operation.id}:${item.scenario.id}`),
    ["getThing:found", "getThing:not-found"],
  );
});

test("sin subconjunto la cola cubre todas las operaciones", () => {
  const queue = buildQueue(resolved, config, { mode: "contract", authEnabled: false });
  assert.equal(new Set(queue.map((item) => item.operation.id)).size, resolved.length);
});

/**
 * Las etiquetas propias del equipo, que son lo que un contrato no puede dar.
 *
 * Un contrato ya trae un `tag` y es el vocabulario de quien lo escribió. Lo que un equipo necesita
 * al lado es el suyo —«crítico», «legacy», «cara al cliente»— y lo que hace que merezca la pena
 * guardarlo en vez de escribirlo en un wiki es poder lanzar una corrida por ahí: «corre lo crítico»
 * desde una tubería, sin enumerar treinta ids que se quedan viejos en cuanto alguien añade uno.
 */
const labelled = defineProjectConfig({
  parameterSamples: { q: ["a"] },
  bodyTemplates: { createThing: { body: { name: "x" } } },
  labels: { listThings: ["critico"], createThing: ["critico", "pagos"], getThing: ["legacy"] },
});
const labelledOperations = resolveOperations(operations, labelled);

test("sin etiquetas pedidas entra todo, como antes de que esto existiera", () => {
  const queue = buildQueue(labelledOperations, labelled, { mode: "contract", authEnabled: false });
  assert.equal(new Set(queue.map((item) => item.operation.id)).size, 4);
});

test("pedir una etiqueta deja solo lo que la lleva", () => {
  const queue = buildQueue(labelledOperations, labelled, {
    mode: "contract",
    labels: ["critico"],
    authEnabled: false,
  });
  assert.deepEqual([...new Set(queue.map((item) => item.operation.id))].sort(), ["createThing", "listThings"]);
});

test("dos etiquetas es «cualquiera de las dos», que es la frase que alguien escribe", () => {
  // Exigirlas todas a la vez haría que añadir una segunda seleccionara casi nada, que es lo
  // contrario de lo que significa escribir una segunda.
  const queue = buildQueue(labelledOperations, labelled, {
    mode: "contract",
    labels: ["critico", "legacy"],
    authEnabled: false,
  });
  assert.equal(new Set(queue.map((item) => item.operation.id)).size, 3);
});

test("una operación sin etiquetar no entra cuando se pide una", () => {
  const queue = buildQueue(labelledOperations, labelled, {
    mode: "contract",
    labels: ["critico"],
    authEnabled: false,
  });
  assert.ok(!queue.some((item) => item.operation.id === "deleteThing"));
});

test("con ids y etiquetas a la vez, los dos estrechan", () => {
  // Cada uno es un filtro, y leerlos como unión haría que añadir un segundo *ampliara* la corrida.
  const queue = buildQueue(labelledOperations, labelled, {
    mode: "contract",
    operationIds: ["createThing", "getThing"],
    labels: ["critico"],
    authEnabled: false,
  });
  assert.deepEqual([...new Set(queue.map((item) => item.operation.id))], ["createThing"]);
});

test("una etiqueta que nadie lleva deja la cola vacía en vez de llena", () => {
  const queue = buildQueue(labelledOperations, labelled, {
    mode: "contract",
    labels: ["no-existe"],
    authEnabled: false,
  });
  assert.equal(queue.length, 0);
});
