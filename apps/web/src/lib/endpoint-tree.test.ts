import { describe, expect, test } from "vitest";

import { buildEndpointTree, endpointIdsOf, folderTrail, selectionState, toggleGroup } from "./endpoint-tree";

const row = (id: string, method: string, path: string) => ({ id, method, path });

describe("carpetas de endpoints", () => {
  test("una carpeta por primer segmento; con versión delante, módulo y versión", () => {
    expect(folderTrail("/users/{id}/posts")).toEqual(["users"]);
    expect(folderTrail("/v1/users/{id}")).toEqual(["users", "v1"]);
    expect(folderTrail("/V2/users")).toEqual(["users", "v2"]);
    // `api` is not a version, so it is the folder.
    expect(folderTrail("/api/v1/users")).toEqual(["api"]);
    expect(folderTrail("/")).toEqual(["(raíz)"]);
    expect(folderTrail("/v1")).toEqual(["v1"]);
  });

  test("ordena carpetas por nombre y endpoints por ruta y método; las versiones van dentro del módulo", () => {
    const tree = buildEndpointTree([
      row("a", "POST", "/users"),
      row("b", "GET", "/users"),
      row("c", "GET", "/v1/users"),
      row("d", "GET", "/v2/users"),
      row("e", "GET", "/health"),
    ]);
    expect(tree.map((folder) => folder.label)).toEqual(["health", "users"]);
    const users = tree[1];
    expect(users.endpoints.map((endpoint) => endpoint.id)).toEqual(["b", "a"]);
    expect(users.folders.map((folder) => [folder.label, folder.isVersion, folder.id])).toEqual([
      ["v1", true, "users/v1"],
      ["v2", true, "users/v2"],
    ]);
    expect(endpointIdsOf(users).sort()).toEqual(["a", "b", "c", "d"]);
  });
});

describe("selección por grupo", () => {
  test("ninguno, parcial o todos; el checkbox de grupo selecciona todo salvo si ya estaba todo", () => {
    const ids = ["a", "b"];
    expect(selectionState(ids, new Set())).toBe("none");
    expect(selectionState(ids, new Set(["a"]))).toBe("partial");
    expect(selectionState(ids, new Set(["a", "b", "z"]))).toBe("all");
    expect([...toggleGroup(ids, new Set(["a", "z"]))].sort()).toEqual(["a", "b", "z"]);
    expect([...toggleGroup(ids, new Set(["a", "b", "z"]))]).toEqual(["z"]);
    expect(selectionState([], new Set(["a"]))).toBe("none");
  });
});
