import { describe, expect, test } from "vitest";

import {
  changeSummary,
  directionCopy,
  entryId,
  isPending,
  pendingConflicts,
  showValue,
  writesSomething,
} from "./fork-sync";
import type { ForkDiffEntryView } from "./types";

const entry = (overrides: Partial<ForkDiffEntryView>): ForkDiffEntryView => ({
  kind: "endpoint",
  key: "GET /users",
  label: "GET /users",
  sourceChange: "none",
  targetChange: "none",
  status: "same",
  fields: [],
  ...overrides,
});

describe("traer y fusionar", () => {
  test("el id de una entrada junta su tipo y su clave", () => {
    expect(entryId({ kind: "workflow", key: "alta" })).toBe("workflow:alta");
  });

  test("el resumen dice qué pasó en cada lado que cambió, y nada del que no", () => {
    expect(changeSummary(entry({ sourceChange: "modified", targetChange: "deleted" }), "Original", "Bifurcación")).toBe(
      "modificado en Original · borrado en Bifurcación",
    );
    expect(changeSummary(entry({ sourceChange: "added" }), "Original", "Bifurcación")).toBe("creado en Original");
    expect(changeSummary(entry({ targetChange: "modified" }), "Original", "Bifurcación")).toBe(
      "modificado en Bifurcación",
    );
    expect(changeSummary(entry({}), "Original", "Bifurcación")).toBe("");
  });

  test("cada sentido tiene su título y su verbo", () => {
    expect(directionCopy("pull")).toEqual({
      title: "Traer cambios del original",
      action: "Traer cambios",
      done: "Cambios traídos",
    });
    expect(directionCopy("merge").action).toBe("Fusionar");
  });

  test("los conflictos pendientes son los que todavía no tienen lado", () => {
    const entries = [
      entry({ key: "a", status: "conflict" }),
      entry({ key: "b", status: "conflict" }),
      entry({ key: "c", status: "incoming" }),
    ];
    expect(pendingConflicts(entries, { "endpoint:a": "target" })).toEqual(["endpoint:b"]);
  });

  test("aplicar escribe si algo llega o si un conflicto se resolvió a favor del origen", () => {
    expect(writesSomething([entry({ status: "incoming" })], {})).toBe(true);
    const conflict = [entry({ key: "a", status: "conflict" }), entry({ key: "b", status: "kept" })];
    expect(writesSomething(conflict, { "endpoint:a": "target" })).toBe(false);
    expect(writesSomething(conflict, { "endpoint:a": "source" })).toBe(true);
  });

  test("un valor se lee en una línea; ausente es un guion y vacío se dice", () => {
    expect(showValue(undefined)).toBe("—");
    expect(showValue("")).toBe("(vacío)");
    expect(showValue("hola")).toBe("hola");
    expect(showValue({ a: 1 })).toBe('{"a":1}');
    expect(showValue(null)).toBe("null");
  });

  test("pendiente es la solicitud abierta o aprobada que aún no se fusionó", () => {
    expect(isPending("open")).toBe(true);
    expect(isPending("approved")).toBe(true);
    expect(isPending("merged")).toBe(false);
    expect(isPending("closed")).toBe(false);
  });
});
