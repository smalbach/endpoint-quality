/**
 * La comparación a tres bandas, caso por caso, sin filas ni proyectos: tres fotos y lo que sale.
 */
import { describe, test } from "node:test";
import { freeRoleName } from "@/modules/projects/application/fork-sync";
import assert from "node:assert/strict";

import {
  canonicalJson,
  diffToken,
  emptySnapshot,
  withAllKinds,
  fieldChanges,
  resolutionProblems,
  threeWayDiff,
  winner,
  type ForkSnapshot,
  type JsonValue,
} from "@/modules/projects/domain/fork-merge";
import {
  channelContent,
  forkKeys,
  linkedDefinition,
  parentKeys,
  snapshotOf,
  environmentContent,
} from "@/modules/projects/domain/fork-snapshot";
import { completeLineage, emptyLineage, type ProjectContents } from "@/modules/projects/domain/fork";
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
  channels: [],
  channelProtos: {},
  environments: [],
  roles: [],
  rolePermissions: [],
  roleRules: [],
  sections: [],
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
  archivedAt: null,
  deletedAt: null,
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

const at = new Date(0);
const suite = (id: string, name: string, workflowIds: string[]) => ({
  id,
  projectId: "p",
  name,
  description: null,
  workflowIds,
  createdAt: at,
  updatedAt: at,
  updatedBy: "u",
  archivedAt: null,
  deletedAt: null,
});
const workflow = (id: string, name: string) => ({
  id,
  projectId: "p",
  name,
  description: null,
  status: "active",
  definition: { steps: [] },
  createdAt: at,
  updatedAt: at,
  updatedBy: "u",
});
const role = (id: string, name: string, position = 0) => ({
  id,
  projectId: "p",
  name,
  description: "",
  color: "#6366f1",
  sameRoleDataIsolation: false,
  position,
  createdAt: at,
  updatedAt: at,
  archivedAt: null,
  deletedAt: null,
});
const endpoint = (id: string, path: string) =>
  ({
    id,
    method: "GET",
    path,
    auth: { type: "inherit", params: {} },
  }) as unknown as ProjectContents["endpoints"][number];
const section = (name: string, data: unknown) =>
  ({ projectId: "p", section: name, data, updatedAt: at, updatedBy: "u" }) as ProjectContents["sections"][number];

/** Las dos fotos de un original y su bifurcación recién nacida, con las claves de cada una. */
function pair(parent: ProjectContents, fork: ProjectContents, lineage = emptyLineage()) {
  const pKeys = parentKeys(parent);
  const { keys } = forkKeys(fork, lineage, parent);
  return { parent: snapshotOf(parent, pKeys), fork: snapshotOf(fork, keys) };
}

describe("suites, roles y secciones", () => {
  test("una suite nombra sus flujos por clave de linaje y en orden: la copia no sale modificada", () => {
    const parent = contents({
      workflows: [workflow("w1", "Pedidos") as never, workflow("w2", "Pagos") as never],
      suites: [suite("s1", "Nocturna", ["w1", "w2"])],
    });
    const fork = contents({
      workflows: [workflow("f1", "Pedidos") as never, workflow("f2", "Pagos") as never],
      suites: [suite("t1", "Nocturna", ["f1", "f2"])],
    });
    const lineage = emptyLineage();
    lineage.workflow.push({ parentId: "w1", forkId: "f1" }, { parentId: "w2", forkId: "f2" });
    lineage.suite.push({ parentId: "s1", forkId: "t1" });
    const same = pair(parent, fork, lineage);
    assert.deepEqual(threeWayDiff(same.parent, same.parent, same.fork), []);

    // El mismo par de flujos en otro orden es otra suite: corre en ese orden.
    const reordered = contents({ ...fork, suites: [suite("t1", "Nocturna", ["f2", "f1"])] });
    const changed = pair(parent, reordered, lineage);
    const entry = one(changed.parent, changed.parent, changed.fork);
    assert.deepEqual(
      [entry.kind, entry.key, entry.status, entry.fields[0]!.path],
      ["suite", "s1", "kept", "workflows"],
    );
  });

  test("un rol compara sus permisos por método y ruta y sus reglas por el otro rol, no por ids ni posición", () => {
    const parent = contents({
      endpoints: [endpoint("e1", "/orders")],
      roles: [role("r1", "admin", 0), role("r2", "buyer", 1)],
      rolePermissions: [{ roleId: "r1", endpointId: "e1", access: "allow", dataScope: "all" }],
      roleRules: [
        { projectId: "p", sourceRoleId: "r1", targetRoleId: "r2", canRead: true, canWrite: false, canDelete: false },
      ],
    });
    const fork = contents({
      endpoints: [endpoint("x1", "/orders")],
      roles: [role("q2", "buyer", 0), role("q1", "admin", 5)],
      rolePermissions: [{ roleId: "q1", endpointId: "x1", access: "allow", dataScope: "all" }],
      roleRules: [
        { projectId: "f", sourceRoleId: "q1", targetRoleId: "q2", canRead: true, canWrite: false, canDelete: false },
      ],
    });
    const lineage = emptyLineage();
    lineage.role.push({ parentId: "r1", forkId: "q1" }, { parentId: "r2", forkId: "q2" });
    const same = pair(parent, fork, lineage);
    assert.deepEqual(threeWayDiff(same.parent, same.parent, same.fork), []);

    const denied = contents({
      ...fork,
      rolePermissions: [{ roleId: "q1", endpointId: "x1", access: "deny", dataScope: "all" }],
    });
    const changed = pair(parent, denied, lineage);
    const entry = one(changed.parent, changed.fork, changed.parent);
    assert.equal(entry.kind, "role");
    assert.equal(entry.status, "incoming");
    assert.deepEqual(entry.fields, [
      { path: "permissions.GET /orders.access", base: "allow", source: "deny", target: "allow" },
    ]);
  });

  test("un rol sin pareja se empareja por nombre, como un flujo", () => {
    const parent = contents({ roles: [role("r1", "admin")] });
    const fork = contents({ roles: [role("q1", "admin")] });
    const { keys, implicit } = forkKeys(fork, emptyLineage(), parent);
    assert.equal(keys.role.get("q1"), "r1");
    assert.deepEqual(implicit.role, [{ parentId: "r1", forkId: "q1" }]);
  });

  test("las secciones se comparan por nombre, sin `implemented` ni `access`", () => {
    const parent = contents({
      sections: [
        section("budgets", { budgets: [] }),
        section("implemented", { implemented: ["a"] }),
        section("access", { access: { roles: ["admin"] } }),
      ],
    });
    const fork = contents({
      sections: [
        section("budgets", { budgets: [{ p95: 300 }] }),
        section("implemented", { implemented: ["b"] }),
        section("access", { access: { roles: [] } }),
      ],
    });
    const snapshots = pair(parent, fork);
    assert.deepEqual(Object.keys(snapshots.parent.section), ["budgets"]);
    const entry = one(snapshots.parent, snapshots.fork, snapshots.parent);
    assert.deepEqual([entry.kind, entry.key, entry.status], ["section", "budgets", "incoming"]);
    // Una sección que solo existe en un lado es añadida o borrada, como cualquier elemento.
    const created = pair(parent, contents({ sections: [...fork.sections, section("labels", { labels: {} })] }));
    assert.ok(
      threeWayDiff(snapshots.parent, created.fork, snapshots.parent).some(
        (row) => row.key === "labels" && row.sourceChange === "added",
      ),
    );
  });

  test("una foto común de antes de estos tipos se completa: lo que coincide sale igual, lo que no, en conflicto", () => {
    const legacy = { endpoint: {}, template: {}, workflow: {}, environment: {} } as unknown as ForkSnapshot;
    assert.deepEqual(Object.keys(withAllKinds(legacy)).sort(), [
      "channel",
      "endpoint",
      "environment",
      "role",
      "section",
      "suite",
      "template",
      "workflow",
    ]);
    const a = snap({ role: { r1: { color: "#000000" } } });
    const b = snap({ role: { r1: { color: "#ffffff" } } });
    assert.equal(one(legacy, a, a).status, "same");
    assert.equal(one(legacy, a, b).status, "conflict");
    assert.deepEqual(completeLineage({ template: [], workflow: [], environment: [] } as never).role, []);
  });
});

const channelRow = (id: string, name: string, protocol: "ws" | "mqtt" | "grpc", token: string) =>
  ({
    id,
    projectId: "p",
    protocol,
    name,
    url: "wss://x.example.com",
    subprotocols: [],
    headers: [{ name: "Authorization", value: token ? `Bearer ${token}` : "", enabled: true }],
    auth: { type: "bearer", params: { token } },
    limits: {},
    expectations: {},
    messages: [],
    mqtt: null,
    grpc: null,
    orderIndex: 0,
    createdAt: at,
    updatedAt: at,
    updatedBy: null,
    deletedAt: null,
  }) as unknown as ProjectContents["channels"][number];

describe("canales", () => {
  test("un canal se compara sin sus secretos: un literal y el hueco de la copia son el mismo canal", () => {
    const withSecret = contents({ channels: [channelRow("c1", "eco", "ws", "literal")] });
    const emptied = contents({ channels: [channelRow("c2", "eco", "ws", "")] });
    const a = canonicalJson(channelContent(withSecret.channels[0]!, withSecret));
    assert.equal(a, canonicalJson(channelContent(emptied.channels[0]!, emptied)));
    assert.ok(!a.includes("literal"));
  });

  test("los .proto van en el canal, ordenados por ruta", () => {
    const grpc = contents({
      channels: [channelRow("g1", "tienda", "grpc", "")],
      channelProtos: {
        g1: [
          { path: "b.proto", content: "b" },
          { path: "a.proto", content: "a" },
        ],
      },
    });
    const content = channelContent(grpc.channels[0]!, grpc) as { protos: { path: string }[] };
    assert.deepEqual(
      content.protos.map((file) => file.path),
      ["a.proto", "b.proto"],
    );
  });

  test("se emparejan por protocolo y nombre, y el nodo canal de un flujo se nombra por la clave", () => {
    const parent = contents({ channels: [channelRow("c1", "eco", "ws", ""), channelRow("m1", "eco", "mqtt", "")] });
    const fork = contents({ channels: [channelRow("f1", "eco", "mqtt", "")] });
    const { keys } = forkKeys(fork, emptyLineage(), parent);
    assert.equal(keys.channel.get("f1"), "m1");
    const definition = linkedDefinition(
      { steps: [{ id: "s", kind: "channel", channel: { channelId: "f1" } }] } as never,
      keys,
    );
    assert.equal(definition.steps[0]!.channel!.channelId, "m1");
    const dangling = linkedDefinition(
      { steps: [{ id: "s", kind: "channel", channel: { channelId: "otro" } }] } as never,
      keys,
    );
    assert.equal(dangling.steps[0]!.channel!.channelId, "(no existe)");
  });
});

describe("el nombre libre de un rol que choca", () => {
  test("se numera con guion, cabe en los 20 caracteres de una credencial y salta lo ocupado", () => {
    assert.equal(freeRoleName("admin", new Set(["admin"])), "admin-2");
    assert.equal(freeRoleName("admin", new Set(["admin", "admin-2"])), "admin-3");
    assert.equal(freeRoleName("abcdefghijklmnopqrst", new Set()), "abcdefghijklmnopqr-2");
  });
});
