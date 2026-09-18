/**
 * La comparación a tres bandas, caso por caso, sin filas ni proyectos: tres fotos y lo que sale.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";

import {
  canonicalJson,
  diffToken,
  emptySnapshot,
  fieldChanges,
  resolutionProblems,
  threeWayDiff,
  winner,
  type ForkSnapshot,
  type JsonValue,
} from "@/modules/projects/domain/fork-merge";
import { forkKeys, parentKeys, snapshotOf, environmentContent } from "@/modules/projects/domain/fork-snapshot";
import { emptyLineage, type ProjectContents } from "@/modules/projects/domain/fork";
import { keepTargetSecrets } from "@/modules/projects/application/fork-sync";

const snap = (entries: Partial<Record<keyof ForkSnapshot, Record<string, JsonValue>>>): ForkSnapshot => {
  const snapshot = emptySnapshot();
  for (const [kind, items] of Object.entries(entries)) {
    for (const [key, content] of Object.entries(items!)) {
      snapshot[kind as keyof ForkSnapshot][key] = { label: key, content };
    }
  }
  return snapshot;
};

const one = (base: ForkSnapshot, source: ForkSnapshot, target: ForkSnapshot) => {
  const entries = threeWayDiff(base, source, target);
  assert.equal(entries.length, 1, JSON.stringify(entries));
  return entries[0]!;
};

describe("threeWayDiff", () => {
  const base = snap({ endpoint: { "GET /a": { description: "uno" } } });

  test("sin cambios en ningún lado no sale nada", () => {
    assert.deepEqual(threeWayDiff(base, base, base), []);
  });

  test("solo el origen modificó: llega", () => {
    const entry = one(base, snap({ endpoint: { "GET /a": { description: "dos" } } }), base);
    assert.equal(entry.status, "incoming");
    assert.equal(entry.sourceChange, "modified");
    assert.equal(entry.targetChange, "none");
    assert.deepEqual(entry.fields, [{ path: "description", base: "uno", source: "dos", target: "uno" }]);
  });

  test("solo el destino modificó: se queda", () => {
    const entry = one(base, base, snap({ endpoint: { "GET /a": { description: "tres" } } }));
    assert.equal(entry.status, "kept");
  });

  test("añadido en el origen llega, y en el destino se queda", () => {
    const added = snap({ endpoint: { "GET /a": { description: "uno" }, "POST /b": { description: "x" } } });
    const incoming = one(base, added, base);
    assert.deepEqual([incoming.key, incoming.sourceChange, incoming.status], ["POST /b", "added", "incoming"]);
    const kept = one(base, base, added);
    assert.deepEqual([kept.targetChange, kept.status], ["added", "kept"]);
  });

  test("borrado en el origen llega como borrado; en el destino se queda", () => {
    const entry = one(base, emptySnapshot(), base);
    assert.deepEqual([entry.sourceChange, entry.status], ["deleted", "incoming"]);
    assert.equal(one(base, base, emptySnapshot()).status, "kept");
  });

  test("los dos modificaron distinto: conflicto", () => {
    const entry = one(
      base,
      snap({ endpoint: { "GET /a": { description: "dos" } } }),
      snap({ endpoint: { "GET /a": { description: "tres" } } }),
    );
    assert.equal(entry.status, "conflict");
    assert.deepEqual(entry.fields, [{ path: "description", base: "uno", source: "dos", target: "tres" }]);
  });

  test("los dos hicieron el mismo cambio, o borraron los dos: nada que decidir", () => {
    const same = snap({ endpoint: { "GET /a": { description: "dos" } } });
    assert.equal(one(base, same, same).status, "same");
    assert.equal(one(base, emptySnapshot(), emptySnapshot()).status, "same");
  });

  test("modificado en un lado y borrado en el otro es conflicto, en los dos sentidos", () => {
    const changed = snap({ endpoint: { "GET /a": { description: "dos" } } });
    const a = one(base, changed, emptySnapshot());
    assert.deepEqual([a.sourceChange, a.targetChange, a.status], ["modified", "deleted", "conflict"]);
    const b = one(base, emptySnapshot(), changed);
    assert.deepEqual([b.sourceChange, b.targetChange, b.status], ["deleted", "modified", "conflict"]);
    assert.deepEqual(b.fields, [{ path: "description", base: "uno", target: "dos" }]);
  });

  test("añadido en los dos con la misma clave y distinto contenido es conflicto", () => {
    const entry = one(
      emptySnapshot(),
      snap({ workflow: { w: { name: "Login", steps: 1 } } }),
      snap({ workflow: { w: { name: "Login", steps: 2 } } }),
    );
    assert.deepEqual([entry.sourceChange, entry.targetChange, entry.status], ["added", "added", "conflict"]);
    assert.deepEqual(entry.fields, [{ path: "steps", source: 1, target: 2 }]);
  });

  test("cambiar la ruta de un endpoint es borrar una clave y crear otra", () => {
    const moved = snap({ endpoint: { "GET /b": { description: "uno" } } });
    const entries = threeWayDiff(base, moved, base);
    assert.deepEqual(
      entries.map((entry) => [entry.key, entry.sourceChange, entry.status]),
      [
        ["GET /a", "deleted", "incoming"],
        ["GET /b", "added", "incoming"],
      ],
    );
  });

  test("el orden de las claves de un objeto no es un cambio", () => {
    assert.equal(canonicalJson({ b: 1, a: { d: 2, c: 3 } }), canonicalJson({ a: { c: 3, d: 2 }, b: 1 }));
    const reordered = snap({ endpoint: { "GET /a": { z: 1, description: "uno" } } });
    const original = snap({ endpoint: { "GET /a": { description: "uno", z: 1 } } });
    assert.deepEqual(threeWayDiff(original, reordered, original), []);
  });

  test("los campos bajan por los objetos y las listas se enseñan enteras", () => {
    const changes = fieldChanges(
      { body: { mode: "json", raw: "{}" }, tags: ["a"] },
      { body: { mode: "json", raw: '{"x":1}' }, tags: ["a", "b"] },
      { body: { mode: "json", raw: "{}" }, tags: ["a"] },
    );
    assert.deepEqual(
      changes.map((change) => change.path),
      ["body.raw", "tags"],
    );
  });
});

describe("decisiones", () => {
  const base = snap({ endpoint: { "GET /a": { v: 1 }, "GET /b": { v: 1 } } });
  const source = snap({ endpoint: { "GET /a": { v: 2 }, "GET /b": { v: 2 } } });
  const target = snap({ endpoint: { "GET /a": { v: 3 }, "GET /b": { v: 1 } } });
  const entries = threeWayDiff(base, source, target);

  test("un conflicto sin decidir es un problema, y una decisión sobre algo que no es conflicto también", () => {
    assert.deepEqual(
      resolutionProblems(entries, {}).map((problem) => problem.field),
      ["resolutions.endpoint:GET /a"],
    );
    assert.deepEqual(
      resolutionProblems(entries, { "endpoint:GET /a": "source", "endpoint:GET /b": "target" }).map((p) => p.field),
      ["resolutions.endpoint:GET /b"],
    );
    assert.deepEqual(resolutionProblems(entries, { "endpoint:GET /a": "target" }), []);
  });

  test("gana el origen en lo que solo él cambió, y lo elegido en el conflicto", () => {
    const [a, b] = entries;
    assert.equal(winner(b!, {}), "source");
    assert.equal(winner(a!, { "endpoint:GET /a": "source" }), "source");
    assert.equal(winner(a!, { "endpoint:GET /a": "target" }), "target");
  });

  test("la huella cambia en cuanto cambia cualquiera de las tres fotos", () => {
    const token = diffToken(base, source, target);
    assert.equal(token, diffToken(base, source, target));
    assert.notEqual(token, diffToken(base, source, base));
  });
});

const contents = (partial: Partial<ProjectContents>): ProjectContents => ({
  endpoints: [],
  templates: [],
  workflows: [],
  datasets: [],
  suites: [],
  environments: [],
  ...partial,
});

const environment = (id: string, name: string, token: string) => ({
  id,
  projectId: "p",
  name,
  baseUrl: "https://x.example.com",
  specUrl: null,
  variables: {
    tenant: { initial: "acme", current: "acme", sensitive: false },
    token: { initial: token, current: token, sensitive: true },
  },
  disabledVariables: {},
  writesAllowed: false,
  authEnforced: false,
  createdAt: new Date(0),
});

describe("fotos y linaje", () => {
  test("un entorno se compara sin el valor de sus secretos", () => {
    assert.equal(
      canonicalJson(environmentContent(environment("a", "staging", "cifrado-1"))),
      canonicalJson(environmentContent(environment("b", "staging", ""))),
    );
    assert.ok(!canonicalJson(environmentContent(environment("a", "s", "cifrado-1"))).includes("cifrado-1"));
  });

  test("la bifurcación se nombra con los ids del original, por pareja o por nombre", () => {
    const parent = contents({ environments: [environment("p1", "staging", ""), environment("p2", "prod", "")] });
    const fork = contents({
      environments: [
        environment("f1", "staging renombrado", ""),
        environment("f2", "prod", ""),
        environment("f3", "qa", ""),
      ],
    });
    const lineage = emptyLineage();
    lineage.environment.push({ parentId: "p1", forkId: "f1" });
    const { keys, implicit } = forkKeys(fork, lineage, parent);
    assert.equal(keys.environment.get("f1"), "p1");
    assert.equal(keys.environment.get("f2"), "p2");
    assert.equal(keys.environment.get("f3"), "fork:f3");
    assert.deepEqual(implicit.environment, [{ parentId: "p2", forkId: "f2" }]);

    // Renombrar en un lado es modificar el mismo elemento, no borrar uno y crear otro.
    const pKeys = parentKeys(parent);
    const entries = threeWayDiff(snapshotOf(parent, pKeys), snapshotOf(parent, pKeys), snapshotOf(fork, keys));
    const renamed = entries.find((entry) => entry.key === "p1")!;
    assert.deepEqual([renamed.targetChange, renamed.fields[0]!.path], ["modified", "name"]);
  });

  test("la autenticación que llega conserva los secretos del destino donde trae un hueco", () => {
    const kept = keepTargetSecrets(
      { type: "bearer", params: { token: "" } },
      { type: "bearer", params: { token: "{{token}}" } },
    );
    assert.equal(kept.params.token, "{{token}}");
    const changed = keepTargetSecrets(
      { type: "basic", params: { password: "" } },
      { type: "bearer", params: { token: "x" } },
    );
    assert.deepEqual(changed.params, { password: "" });
  });
});
