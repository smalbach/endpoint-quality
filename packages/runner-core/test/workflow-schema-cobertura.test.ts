/**
 * Lo que el esquema del flujo rechaza al guardar y ningún otro archivo de pruebas pisaba: cada
 * rechazo es un fallo que, si pasa, aparece a mitad de una corrida como si fuera del objetivo.
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  safeParseDatasetRows,
  safeParseRequestBody,
  safeParseRequestTemplate,
  safeParseWorkflowDocument,
  stepCheckSchema,
  workflowCaptureSchema,
} from "../src/workflow-schema.ts";

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const req = (id: string, extra: object = {}) => ({ id, requestTemplateId: uuid(1), ...extra });
const details = (steps: unknown[]) => {
  const result = safeParseWorkflowDocument({ steps });
  return result.ok ? [] : result.issues.map((issue) => `${issue.field}: ${issue.detail}`);
};

describe("capturas y comprobaciones, al guardar", () => {
  test("una captura por regex compila su patrón; las otras rutas no lo miran", () => {
    assert.equal(workflowCaptureSchema.safeParse({ variable: "id", from: "regex", path: "id=(\\d+)" }).success, true);
    const bad = workflowCaptureSchema.safeParse({ variable: "id", from: "regex", path: "id=(" });
    assert.equal(bad.success, false);
    assert.deepEqual(
      bad.error!.issues.map((issue) => [issue.path.join("."), issue.message]),
      [["path", "la expresión regular no es válida"]],
    );
    // En el cuerpo `(` es un camino raro, no un patrón: no se compila.
    assert.equal(workflowCaptureSchema.safeParse({ variable: "id", from: "body", path: "id=(" }).success, true);
  });

  test("una comprobación de cabecera sin nombre no es una comprobación", () => {
    const messages = (check: object) => {
      const result = stepCheckSchema.safeParse(check);
      return result.success ? [] : result.error.issues.map((issue) => issue.message);
    };
    assert.deepEqual(messages({ source: "header", operator: "exists" }), ["una comprobación de cabecera necesita su nombre"]);
    assert.deepEqual(messages({ source: "header", path: "   ", operator: "exists" }), [
      "una comprobación de cabecera necesita su nombre",
    ]);
    assert.deepEqual(messages({ source: "header", path: "x-id", operator: "exists" }), []);
    // Un cuerpo sin camino sí vale: juzga el cuerpo entero.
    assert.deepEqual(messages({ source: "body", operator: "is_not_empty" }), []);
  });

  test("un operador que compara necesita con qué, y «matches» un patrón que compile", () => {
    const messages = (check: object) => {
      const result = stepCheckSchema.safeParse(check);
      return result.success ? [] : result.error.issues.map((issue) => issue.message);
    };
    assert.deepEqual(messages({ source: "status", operator: "equals" }), [
      "el operador equals necesita un valor con el que comparar",
    ]);
    assert.deepEqual(messages({ source: "body", path: "name", operator: "matches", value: "^a(" }), [
      "la expresión regular no es válida",
    ]);
    assert.deepEqual(messages({ source: "body", path: "name", operator: "matches", value: "^a+$" }), []);
  });
});

describe("campos de un nodo que no son de su tipo", () => {
  test("una condición fuera de una bifurcación se rechaza", () => {
    const condition = { from: "a", check: { source: "status", operator: "equals", value: 200 } };
    assert.ok(
      details([req("a"), req("b", { dependsOn: ["a"], condition })]).includes(
        "steps.1.condition: solo un nodo de bifurcación lleva condición",
      ),
    );
  });

  test("un bloque de validación fuera de un nodo de validación se rechaza", () => {
    assert.ok(
      details([req("a"), req("b", { dependsOn: ["a"], validate: { from: "a" } })]).includes(
        "steps.1.validate: solo un nodo de validación lleva su bloque de validación",
      ),
    );
  });

  test("código fuera de un nodo script se rechaza", () => {
    assert.ok(details([req("a", { script: { code: "1" } })]).includes("steps.0.script: solo un nodo script lleva código"));
  });

  test("una lista de bucle fuera de un nodo bucle se rechaza", () => {
    assert.ok(
      details([req("a"), req("b", { dependsOn: ["a"], loop: { from: "a", path: "data", as: "item" } })]).includes(
        "steps.1.loop: solo un nodo bucle lleva su lista",
      ),
    );
  });
});

describe("lecturas de otro paso", () => {
  test("runIf tiene que leer un paso que existe y del que depende", () => {
    const runIf = (from: string) => ({ from, check: { source: "status", operator: "equals", value: 200 } });
    assert.deepEqual(details([req("a"), req("b", { dependsOn: ["a"], runIf: runIf("a") })]), []);
    assert.ok(
      details([req("a"), req("b", { runIf: runIf("a") })]).includes(
        "steps.1.runIf.from: runIf solo puede leer un paso del que este depende",
      ),
    );
    assert.ok(
      details([req("a"), req("b", { runIf: runIf("fantasma") })]).includes(
        "steps.1.runIf.from: runIf apunta a un paso inexistente: fantasma",
      ),
    );
  });

  test("un esquema propio no puede usar «pattern», tampoco dentro de una lista", () => {
    const schema = (json: string) => ({
      id: "e",
      kind: "schema",
      dependsOn: ["a"],
      schema: { from: "a", source: "custom", json },
    });
    assert.deepEqual(details([req("a"), schema('{"anyOf":[{"type":"string"},{"type":"number"}]}')]), []);
    assert.ok(
      details([req("a"), schema('{"anyOf":[{"type":"string","pattern":"^a+$"}]}')]).some((line) =>
        line.endsWith("un esquema propio no puede usar «pattern»"),
      ),
    );
  });
});

describe("un reintento dentro de un bucle", () => {
  test("se rechaza: el bucle ya repite su cuerpo por su cuenta", () => {
    const listar = req("listar");
    const loop = { id: "b", kind: "loop", dependsOn: ["listar"], loop: { from: "listar", path: "data", as: "item" } };
    const leer = req("leer", { dependsOn: ["b"], inLoop: "b" });
    const retry = { id: "r", kind: "retry", dependsOn: ["leer"], rerun: { from: "leer", target: "leer", attempts: 2, delayMs: 0 } };
    assert.ok(details([listar, loop, leer, retry]).includes("steps.3.kind: un reintento no puede ir dentro de un bucle"));
    // Fuera del bucle, el mismo reintento vale.
    assert.deepEqual(details([listar, req("leer", { dependsOn: ["listar"] }), retry]), []);
  });
});

describe("los informes de error nombran el campo, o el documento entero", () => {
  test("un documento que no es un objeto se informa sobre «definition»", () => {
    const result = safeParseWorkflowDocument("no soy un flujo");
    assert.equal(result.ok, false);
    assert.deepEqual(result.ok ? [] : result.issues.map((issue) => issue.field), ["definition"]);
  });

  test("una plantilla de petición se valida con su propio nombre de raíz", () => {
    assert.deepEqual(safeParseRequestTemplate({ name: "Leer", operationId: "getThing", expectedStatus: 200 }), { ok: true });
    const bad = safeParseRequestTemplate(null);
    assert.deepEqual(bad.ok ? [] : bad.issues.map((issue) => issue.field), ["requestTemplate"]);
    const field = safeParseRequestTemplate({ name: "", operationId: "getThing", expectedStatus: 200 });
    assert.deepEqual(field.ok ? [] : field.issues.map((issue) => issue.field), ["name"]);
  });

  test("las filas de un conjunto de datos se validan como filas", () => {
    assert.deepEqual(safeParseDatasetRows([{ usuario: "ana" }]), { ok: true });
    const bad = safeParseDatasetRows({ usuario: "ana" });
    assert.deepEqual(bad.ok ? [] : bad.issues.map((issue) => issue.field), ["rows"]);
    const column = safeParseDatasetRows([{ "mal nombre": "x" }]);
    assert.equal(column.ok, false);
  });

  test("un cuerpo suelto se valida como cuerpo", () => {
    assert.deepEqual(safeParseRequestBody({ type: "none" }), { ok: true });
    const bad = safeParseRequestBody("texto");
    assert.deepEqual(bad.ok ? [] : bad.issues.map((issue) => issue.field), ["body"]);
  });
});
