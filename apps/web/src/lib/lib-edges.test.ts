/**
 * Los bordes de las funciones pequeñas de `src/lib`: lo que falta, lo que viene mal formado y el
 * almacenamiento que se niega.
 */
import { afterEach, describe, expect, test, vi } from "vitest";

import { stopText } from "@/lib/channel-view";
import { buildEndpointTree, pathSegments } from "@/lib/endpoint-tree";
import { mockBodyProblem, mockContentType, mockProblems, mockSampleBody } from "@/lib/mock-draft";
import { fieldProblems } from "@/lib/request-fields";
import { previewBodyFor } from "@/lib/request-preview";
import { groupAccess, groupScope } from "@/lib/role-permissions";
import { DEFAULT_RUN_SETTINGS, loadRunSettings, saveRunSettings } from "@/lib/run-settings";
import { notifyProblems } from "@/lib/workflow-notify";
import type { RequestTemplateView, WorkflowStepView } from "@/lib/types";

afterEach(() => vi.restoreAllMocks());

describe("stopText", () => {
  test("el tope de mensajes sin límites conocidos, y un motivo desconocido tal cual", () => {
    expect(stopText("message-cap", null)).toBe("se cortó: tope de mensajes");
    expect(stopText("message-cap", { maxMessages: 5 })).toBe("se cortó: tope de 5 mensajes");
    expect(stopText("motivo-nuevo")).toBe("motivo-nuevo");
  });
});

describe("pathSegments", () => {
  test("un segmento mal codificado se queda como está en vez de romper el árbol", () => {
    expect(pathSegments("/files/%E0%A4%A/a%20b")).toEqual(["files", "%E0%A4%A", "a b"]);
  });
});

describe("buildEndpointTree", () => {
  test("en la misma ruta, un método que no es de los conocidos va detrás de los conocidos", () => {
    const [folder] = buildEndpointTree([
      { id: "x", method: "LINK", path: "/orders" },
      { id: "g", method: "GET", path: "/orders" },
      { id: "y", method: "UNLINK", path: "/orders" },
    ]);
    expect(folder!.endpoints.map((endpoint) => endpoint.id)).toEqual(["g", "x", "y"]);
  });
});

describe("mock-draft sin mock", () => {
  test("un nodo mock sin respuesta lo dice", () => {
    expect(mockProblems({ id: "m1", kind: "mock" } as unknown as WorkflowStepView)).toEqual([
      "El mock «m1» no tiene respuesta.",
    ]);
  });

  test("sin mock no hay content-type, ni body, ni problema", () => {
    expect(mockContentType(undefined)).toBeUndefined();
    expect(mockSampleBody(undefined)).toBeUndefined();
    expect(mockBodyProblem(undefined)).toBeNull();
    expect(mockBodyProblem({ status: 200, headers: { "Content-Type": "application/json" } } as never)).toBeNull();
  });
});

describe("fieldProblems", () => {
  test("un parámetro repetido se dice como parámetro, en la segunda aparición", () => {
    const rows = [
      { name: "page", value: "1", enabled: true },
      { name: " page ", value: "2", enabled: false },
    ];
    expect(fieldProblems(rows, "parameter")).toEqual([{ index: 1, detail: "Ya hay un parámetro con ese nombre" }]);
    expect(fieldProblems(rows, "header")).toEqual([{ index: 1, detail: "Ya hay una cabecera con ese nombre" }]);
  });
});

describe("previewBodyFor", () => {
  test("sin parámetros ni cabeceras manda mapas vacíos", () => {
    const template = {
      name: "Listar",
      operationId: "list",
      expectedStatus: 200,
      body: null,
      auth: null,
    } as unknown as RequestTemplateView;
    expect(previewBodyFor(template, "e1")).toEqual(
      expect.objectContaining({ environmentId: "e1", parameters: {}, headers: {} }),
    );
  });
});

describe("role-permissions", () => {
  test("un grupo vacío no tiene acceso ni alcance que decir", () => {
    expect(groupAccess([], {})).toBeNull();
    expect(groupScope([], {})).toBeNull();
  });

  test("el alcance de un grupo con endpoints permitidos de alcance distinto es «mixto»", () => {
    const cells = {
      a: { access: "allow" as const, dataScope: "all" as const },
      b: { access: "allow" as const, dataScope: "own" as const },
      c: { access: "deny" as const, dataScope: "own" as const },
    };
    expect(groupScope(["a", "b", "c"], cells)).toBe("mixed");
    expect(groupScope(["a", "c"], cells)).toBe("all");
  });
});

describe("run-settings con el almacenamiento negado", () => {
  test("leer devuelve los de siempre y guardar no rompe", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new DOMException("denied", "SecurityError");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("denied", "SecurityError");
    });
    expect(loadRunSettings("w1")).toEqual(DEFAULT_RUN_SETTINGS);
    expect(() => saveRunSettings("w1", DEFAULT_RUN_SETTINGS)).not.toThrow();
  });
});

describe("notifyProblems", () => {
  test("un nodo sin configuración de notificación pide la variable y el mensaje", () => {
    const step = { id: "n1", kind: "notify" } as unknown as WorkflowStepView;
    expect(notifyProblems(step).map((problem) => problem.message)).toEqual([
      "La notificación «n1» no dice qué variable del entorno tiene la URL del webhook.",
      "La notificación «n1» no tiene mensaje.",
    ]);
  });
});
