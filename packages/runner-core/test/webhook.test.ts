import assert from "node:assert/strict";
import test, { describe } from "node:test";
import { CONTROL_KINDS } from "../src/workflows.ts";
import { safeParseWorkflowDocument } from "../src/workflow-schema.ts";

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const parse = (steps: unknown[]) => safeParseWorkflowDocument({ steps }).ok;
const hook = (
  block: Record<string, unknown> | undefined = { timeoutMs: 60_000 },
  extra: Record<string, unknown> = {},
) => ({
  id: "pago",
  kind: "webhook",
  ...(block ? { webhook: block } : {}),
  ...extra,
});

describe("nodo webhook", () => {
  test("es un nodo de control: no envía petición", () => {
    assert.ok(CONTROL_KINDS.includes("webhook"));
  });

  test("espera entre 1 s y 10 min, por POST o PUT", () => {
    assert.equal(parse([hook()]), true);
    assert.equal(parse([hook({ timeoutMs: 1_000, method: "PUT" })]), true);
    assert.equal(parse([hook({ timeoutMs: 600_000, method: "POST" })]), true);
    assert.equal(parse([hook({ timeoutMs: 999 })]), false);
    assert.equal(parse([hook({ timeoutMs: 600_001 })]), false);
    assert.equal(parse([hook({ timeoutMs: 1_500.5 })]), false);
    assert.equal(parse([hook({ timeoutMs: 5_000, method: "GET" })]), false);
  });

  test("lleva su bloque y solo él; puede capturar y comprobar lo que llega", () => {
    assert.equal(parse([{ id: "pago", kind: "webhook" }]), false);
    assert.equal(
      parse([{ id: "crear", requestTemplateId: uuid(1), webhook: { timeoutMs: 5_000 } }]),
      false,
      "un paso de petición no lleva bloque webhook",
    );
    assert.equal(parse([hook({ timeoutMs: 5_000 }, { requestTemplateId: uuid(1) })]), false);
    assert.equal(
      parse([hook({ timeoutMs: 5_000 }, { retry: { attempts: 2, delayMs: 100 } })]),
      false,
      "espera una sola llamada",
    );
    assert.equal(
      parse([
        hook(
          { timeoutMs: 5_000 },
          {
            captures: [{ variable: "orderId", from: "body", path: "order.id" }],
            checks: [{ source: "body", path: "status", operator: "equals", value: "paid" }],
          },
        ),
        {
          id: "leer",
          kind: "validate",
          dependsOn: ["pago"],
          validate: { from: "pago" },
          checks: [{ source: "status", operator: "equals", value: "200" }],
        },
      ]),
      true,
    );
  });

  test("no puede esperar dentro del cuerpo de un bucle, pero sí antes o después", () => {
    const listar = { id: "listar", requestTemplateId: uuid(1) };
    const loop = { id: "b", kind: "loop", dependsOn: ["listar"], loop: { from: "listar", path: "data", as: "item" } };
    assert.equal(parse([listar, loop, hook({ timeoutMs: 5_000 }, { dependsOn: ["b"], inLoop: "b" })]), false);
    // Aguas abajo de un nodo del cuerpo también es cuerpo.
    assert.equal(
      parse([
        listar,
        loop,
        { id: "leer", requestTemplateId: uuid(2), dependsOn: ["b"], inLoop: "b" },
        hook({ timeoutMs: 5_000 }, { dependsOn: ["leer"] }),
      ]),
      false,
    );
    // En el lado «fin» es un paso más.
    assert.equal(parse([listar, loop, hook({ timeoutMs: 5_000 }, { dependsOn: ["b"] })]), true);
    assert.equal(parse([hook({ timeoutMs: 5_000 }), { ...listar, dependsOn: ["pago"] }]), true);
  });
});
