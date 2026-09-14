import { describe, expect, test } from "vitest";

import {
  changesBetween,
  cellsFrom,
  groupAccess,
  groupScope,
  ruleOf,
  setCells,
  toggleRule,
  type Cells,
} from "@/lib/role-permissions";

describe("los permisos de un rol", () => {
  const saved: Cells = cellsFrom([
    { endpointId: "a", access: "allow", dataScope: "own" },
    { endpointId: "b", access: "deny", dataScope: "all" },
  ]);

  test("una carpeta con algo sin decidir es mixta, no permitida", () => {
    expect(groupAccess(["a"], saved)).toBe("allow");
    expect(groupAccess(["a", "c"], saved)).toBe("mixed");
    expect(groupAccess(["c", "d"], saved)).toBe("undecided");
    expect(groupAccess([], saved)).toBeNull();
    expect(groupScope(["a", "b"], saved)).toBe("own");
    expect(groupScope(["b"], saved)).toBeNull();
  });

  test("aplicar a la carpeta y devolver solo lo que cambió", () => {
    const draft = setCells(saved, ["a", "b", "c"], { access: "allow" });
    expect(groupAccess(["a", "b", "c"], draft)).toBe("allow");
    expect(changesBetween(saved, draft)).toEqual([
      { endpointId: "b", access: "allow", dataScope: "all" },
      { endpointId: "c", access: "allow", dataScope: "all" },
    ]);
    const erased = setCells(saved, ["a"], { access: "undecided" });
    expect(changesBetween(saved, erased)).toEqual([{ endpointId: "a", access: "undecided", dataScope: "all" }]);
    expect(changesBetween(saved, saved)).toEqual([]);
  });
});

describe("la matriz R/W/D", () => {
  test("una celda sin nada encendido no se guarda", () => {
    const once = toggleRule([], "s", "t", "canRead");
    expect(ruleOf(once, "s", "t")).toMatchObject({ canRead: true, canWrite: false });
    expect(toggleRule(once, "s", "t", "canRead")).toEqual([]);
    expect(ruleOf([], "x", "y").canDelete).toBe(false);
  });
});
