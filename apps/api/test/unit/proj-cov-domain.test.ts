/**
 * Los rincones del dominio de proyectos: nombres libres, canales sin secretos, la comparación de
 * valores sueltos, las fotos con referencias colgando, las solicitudes de fusión mal escritas, la
 * autenticación de un proyecto sin ajustes y el nombre de un rol que no admite número.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { freeRoleName, keepTargetSecrets } from "@/modules/projects/application/fork-sync";
import { storableChannel, uniqueName, withoutSecrets } from "@/modules/projects/domain/copying";
import { emptyLineage, type ProjectContents } from "@/modules/projects/domain/fork";
import { fieldChanges, resolutionProblems, winner, type DiffEntry } from "@/modules/projects/domain/fork-merge";
import {
  channelContent,
  forkKeys,
  linkedDefinition,
  parentKeys,
  sectionContent,
  suiteContent,
  workflowContent,
} from "@/modules/projects/domain/fork-snapshot";
import { mergeRequestProblems } from "@/modules/projects/domain/merge-request";
import { isArchived, projectSettingsProblems, slugifyProject } from "@/modules/projects/domain/model";
import { NO_AUTH, projectAuthProblems, viewProjectAuth } from "@/modules/projects/domain/project-auth";

const at = new Date(0);
const contents = (partial: Partial<ProjectContents> = {}): ProjectContents => ({
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
const channel = (patch: Record<string, unknown> = {}) =>
  ({
    id: "c1",
    projectId: "p",
    protocol: "ws",
    name: "eco",
    url: "wss://x.example.com",
    subprotocols: [],
    headers: [],
    auth: null,
    limits: {},
    expectations: {},
    messages: [],
    mqtt: null,
    grpc: null,
    socketio: null,
    orderIndex: 0,
    createdAt: at,
    updatedAt: at,
    updatedBy: null,
    deletedAt: null,
    ...patch,
  }) as unknown as ProjectContents["channels"][number];

describe("nombres libres", () => {
  test("un nombre en blanco se llama «Copiado»; uno libre se queda; uno ocupado se numera", () => {
    assert.equal(uniqueName("   ", new Set()), "Copiado");
    assert.equal(uniqueName(" Flujo ", new Set()), "Flujo");
    assert.equal(uniqueName("Flujo", new Set(["Flujo", "Flujo (2)"])), "Flujo (3)");
  });

  test("con los 998 números ocupados, un sufijo aleatorio", () => {
    const taken = new Set(["F", ...Array.from({ length: 998 }, (_, index) => `F (${index + 2})`)]);
    const name = uniqueName("F", taken);
    assert.match(name, /^F [0-9a-f]{8}$/);
    assert.ok(!taken.has(name));
  });

  test("un rol que no admite número con guion no tiene nombre libre", () => {
    // Un nombre de credencial empieza por letra o `_`: ningún `9x-N` lo es.
    assert.equal(freeRoleName("9x", new Set(["9x"])), null);
  });
});

describe("secretos de canales y entornos", () => {
  test("un canal pierde el literal de su autenticación y de su Socket.IO; sin ellos, se quedan nulos", () => {
    const clean = storableChannel(
      channel({
        auth: { type: "bearer", params: { token: "literal" } },
        socketio: {
          version: 4,
          path: "/socket.io",
          namespace: "/",
          auth: '{"token":"literal"}',
          query: [{ name: "token", value: "literal", enabled: true }],
          listenAll: true,
          events: [],
        },
      }),
    );
    assert.ok(!JSON.stringify(clean).includes("literal"), JSON.stringify(clean));
    assert.equal(clean.auth!.type, "bearer");
    const bare = storableChannel(channel());
    assert.equal(bare.auth, null);
    assert.equal(bare.socketio, null);
  });

  test("las variables sensibles se vacían y se nombran", () => {
    const { variables, emptied } = withoutSecrets({
      a: { initial: "1", current: "1", sensitive: false },
      b: { initial: "s", current: "s", sensitive: true },
    });
    assert.deepEqual(variables.b, { initial: "", current: "", sensitive: true });
    assert.deepEqual(variables.a, { initial: "1", current: "1", sensitive: false });
    assert.deepEqual(emptied, ["b"]);
  });

  test("la auth que llega: sin la del destino, tal cual; un hueco que el destino tampoco tiene sigue hueco", () => {
    const incoming = { type: "basic" as const, params: { username: "", password: "" } };
    assert.equal(keepTargetSecrets(incoming, undefined), incoming);
    assert.deepEqual(keepTargetSecrets(incoming, { type: "basic", params: { username: "ana" } }).params, {
      username: "",
      password: "",
    });
  });
});

describe("la comparación de valores sueltos", () => {
  test("dos valores que no son objetos salen como el todo", () => {
    assert.deepEqual(fieldChanges(1, 2, 3), [{ path: "(todo)", base: 1, source: 2, target: 3 }]);
    assert.deepEqual(fieldChanges(undefined, "a", undefined), [{ path: "(todo)", source: "a" }]);
  });

  test("una decisión que no es ni source ni target se dice; lo que no es conflicto gana el destino", () => {
    const entry = { kind: "endpoint", key: "GET /x", status: "conflict" } as unknown as DiffEntry;
    assert.deepEqual(resolutionProblems([entry], { "endpoint:GET /x": "ambos" as never }), [
      { field: "resolutions.endpoint:GET /x", detail: "source o target" },
    ]);
    assert.equal(winner({ ...entry, status: "kept" } as DiffEntry, {}), "target");
    assert.equal(winner(entry, {}), "target");
  });
});

describe("fotos con referencias", () => {
  test("un paso con sub-flujo que no existe se nombra como colgando; uno que existe, por su clave", () => {
    const keys = parentKeys(contents({ workflows: [{ id: "w1" } as never] }));
    const definition = linkedDefinition(
      {
        steps: [
          { id: "a", kind: "subflow", subflow: { workflowId: "w1" } },
          { id: "b", kind: "subflow", subflow: { workflowId: "nada" } },
          { id: "c", requestTemplateId: "nada" },
        ],
      } as never,
      keys,
    );
    assert.equal(definition.steps[0]!.subflow!.workflowId, "w1");
    assert.equal(definition.steps[1]!.subflow!.workflowId, "(no existe)");
    assert.equal(definition.steps[2]!.requestTemplateId, "(no existe)");
  });

  test("una suite con un flujo que ya no existe lo enseña como colgando", () => {
    const keys = parentKeys(contents());
    const content = suiteContent(
      { id: "s", projectId: "p", name: "S", description: null, workflowIds: ["w-fantasma"] } as never,
      keys,
    ) as { workflows: string[] };
    assert.deepEqual(content.workflows, ["(no existe)"]);
  });

  test("los datasets de un flujo van ordenados por nombre, y solo los suyos", () => {
    const flow = { id: "w", name: "F", description: null, status: "ready", definition: { steps: [] } } as never;
    const data = contents({
      datasets: [
        { id: "d2", workflowId: "w", name: "zeta", rows: [] },
        { id: "d1", workflowId: "w", name: "alfa", rows: [] },
        { id: "d3", workflowId: "otro", name: "beta", rows: [] },
      ] as never,
    });
    const content = workflowContent(flow, data, parentKeys(data)) as { datasets: { name: string }[] };
    assert.deepEqual(
      content.datasets.map((row) => row.name),
      ["alfa", "zeta"],
    );
  });

  test("un canal con Socket.IO lo incluye en su huella; un gRPC sin .proto tiene la lista vacía", () => {
    const socket = channel({
      socketio: { version: 4, path: "/io", namespace: "/", auth: "", query: [], listenAll: false, events: [] },
    });
    const withSocket = channelContent(socket, contents({ channels: [socket] })) as Record<string, unknown>;
    assert.equal((withSocket.socketio as { path: string }).path, "/io");
    const grpc = channel({ protocol: "grpc", id: "g" });
    const plain = channelContent(grpc, contents({ channels: [grpc] })) as Record<string, unknown>;
    assert.equal("socketio" in plain, false);
    assert.deepEqual(plain.protos, []);
  });

  test("una sección sin datos es `null`", () => {
    assert.equal(sectionContent({ projectId: "p", section: "budgets", data: undefined } as never), null);
  });

  test("un linaje sin un tipo cuenta como vacío", () => {
    const parent = contents({ environments: [{ id: "p1", name: "a" } as never] });
    const fork = contents({ environments: [{ id: "f1", name: "a" } as never] });
    const lineage = emptyLineage() as Record<string, unknown>;
    delete lineage.environment;
    const { keys, implicit } = forkKeys(fork, lineage as never, parent);
    assert.equal(keys.environment.get("f1"), "p1");
    assert.deepEqual(implicit.environment, [{ parentId: "p1", forkId: "f1" }]);
  });
});

describe("solicitudes de fusión, proyecto y autenticación", () => {
  test("una solicitud sin título, con uno de más de 200 o con una descripción enorme", () => {
    assert.deepEqual(mergeRequestProblems({}), [{ field: "title", detail: "Escribe un título" }]);
    assert.deepEqual(mergeRequestProblems({ title: "x".repeat(201) }), [
      { field: "title", detail: "Como mucho 200 caracteres" },
    ]);
    assert.deepEqual(mergeRequestProblems({ title: "ok", description: "x".repeat(10_001) }), [
      { field: "description", detail: "Como mucho 10 000 caracteres" },
    ]);
    assert.deepEqual(mergeRequestProblems({ title: "ok", description: "bien" }), []);
  });

  test("archivado es tener fecha; una baseUrl que no es http o no es URL; un nombre sin letras", () => {
    assert.equal(isArchived({ archivedAt: null } as never), false);
    assert.equal(isArchived({ archivedAt: at } as never), true);
    assert.deepEqual(projectSettingsProblems({ baseUrl: "ftp://x" }, NO_AUTH), [
      { field: "baseUrl", detail: "Solo http o https" },
    ]);
    assert.deepEqual(projectSettingsProblems({ baseUrl: "no url" }, NO_AUTH), [
      { field: "baseUrl", detail: "No es una URL válida" },
    ]);
    assert.deepEqual(projectSettingsProblems({ baseUrl: "   " }, NO_AUTH), []);
    assert.equal(slugifyProject("¡¡!!"), "proyecto");
    assert.equal(slugifyProject("Mi Proyécto"), "mi-proyecto");
  });

  test("la vista de una auth sin ajustes guardados no enseña máscaras ni valores", () => {
    const view = viewProjectAuth({ type: "bearer", settings: {}, secretCiphertext: null });
    assert.deepEqual(view, {
      type: "bearer",
      loginUrl: "",
      loginMethod: "",
      tokenPath: "",
      username: "",
      headerName: "",
      token: "",
      loginBody: "",
      password: "",
      apiKey: "",
    });
  });

  test("la máscara sin un secreto guardado detrás no cuenta como secreto", () => {
    const problems = projectAuthProblems(
      { type: "bearer", token: "••••••••" },
      { type: "bearer", settings: {}, secretCiphertext: null },
    );
    assert.ok(problems.some((problem) => problem.field === "auth.token"), JSON.stringify(problems));
    assert.ok(projectAuthProblems({ type: "bearer" }, NO_AUTH).some((problem) => problem.field === "auth.token"));
  });
});
