/**
 * El árbol de una colección, en el navegador.
 *
 * Mover una petición de carpeta, duplicar una rama, reordenar dos hermanas: todo eso pasa antes de
 * guardar nada, así que es lo que hay que poder probar sin un servidor. Lo que se rompe aquí se
 * nota tres pantallas después, con el documento ya escrito.
 */
import { describe, expect, test } from "vitest";

import {
  contains,
  countRequests,
  duplicateItem,
  findItem,
  flatten,
  foldersOf,
  insertItem,
  failureReason,
  moveItem,
  moveWithin,
  newFolder,
  resultFailed,
  runDuration,
  newRequest,
  replaceItem,
  sameJson,
  statusClass,
  trailName,
} from "@/lib/collections";
import type { CollectionRunResultView } from "@/lib/types";
import type { CollectionItemView } from "@/lib/types";

const folder = (id: string, items: CollectionItemView[] = []): CollectionItemView => ({
  ...newFolder(id, id),
  items,
});
const request = (id: string): CollectionItemView => newRequest(id, id);

const tree = () => [folder("f1", [request("a"), folder("f2", [request("b")])]), request("c")];

describe("el árbol", () => {
  test("se recorre en el orden en que se corre y cuenta sus peticiones", () => {
    expect(flatten(tree()).map((entry) => entry.item.id)).toEqual(["f1", "a", "f2", "b", "c"]);
    expect(countRequests(tree())).toBe(3);
  });

  test("un nodo se encuentra con su camino", () => {
    const found = findItem(tree(), "b");
    expect(found?.trail.map((item) => item.id)).toEqual(["f1", "f2"]);
    expect(trailName(found!.trail)).toBe("f1 / f2");
    expect(findItem(tree(), "nada")).toBeNull();
  });

  test("reemplazar cambia o quita; insertar mete donde se diga", () => {
    expect(findItem(replaceItem(tree(), "b", (item) => ({ ...item, name: "x" })), "b")?.item.name).toBe("x");
    expect(findItem(replaceItem(tree(), "f1", () => null), "a")).toBeNull();
    const inside = insertItem(tree(), "f2", request("nuevo"));
    expect(findItem(inside, "nuevo")?.trail.map((item) => item.id)).toEqual(["f1", "f2"]);
    expect(insertItem(tree(), null, request("z")).at(-1)?.id).toBe("z");
  });

  test("mover lleva un nodo a otra carpeta, y a la raíz", () => {
    const moved = moveItem(tree(), "c", "f2");
    expect(findItem(moved, "c")?.trail.map((item) => item.id)).toEqual(["f1", "f2"]);
    expect(moveItem(moved, "c", null).at(-1)?.id).toBe("c");
  });

  test("una carpeta no se puede meter dentro de sí misma ni de lo suyo", () => {
    expect(moveItem(tree(), "f1", "f1")).toEqual(tree());
    expect(moveItem(tree(), "f1", "f2")).toEqual(tree());
    expect(moveItem(tree(), "no-existe", "f1")).toEqual(tree());
    expect(contains(tree(), "f1", "b")).toBe(true);
    expect(contains(tree(), "f2", "c")).toBe(false);
  });

  test("subir y bajar mueve entre hermanos, y en los extremos no pasa nada", () => {
    expect(moveWithin(tree(), "c", -1).map((item) => item.id)).toEqual(["c", "f1"]);
    expect(moveWithin(tree(), "f1", -1).map((item) => item.id)).toEqual(["f1", "c"]);
    expect(moveWithin(tree(), "c", 1).map((item) => item.id)).toEqual(["f1", "c"]);
    // También dentro de una carpeta.
    const inside = moveWithin(tree(), "f2", -1);
    expect(findItem(inside, "f1")!.item.items.map((item) => item.id)).toEqual(["f2", "a"]);
  });

  test("duplicar da ids nuevos de arriba abajo", () => {
    const copy = duplicateItem(findItem(tree(), "f1")!.item);
    expect(copy.name).toBe("f1 (copia)");
    expect(copy.id).not.toBe("f1");
    const ids = flatten([copy]).map((entry) => entry.item.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).not.toContain("a");
  });

  test("las carpetas se listan aparte, para el selector de mover", () => {
    expect(foldersOf(tree()).map((entry) => entry.item.id)).toEqual(["f1", "f2"]);
  });
});

describe("lo demás", () => {
  test("sameJson compara por contenido", () => {
    expect(sameJson({ a: [1] }, { a: [1] })).toBe(true);
    expect(sameJson({ a: [1] }, { a: [2] })).toBe(false);
  });

  test("el color del estado dice de un vistazo cómo fue", () => {
    expect(statusClass(200)).toMatch(/emerald/);
    expect(statusClass(404)).toMatch(/amber/);
    expect(statusClass(500)).toMatch(/rose/);
    expect(statusClass(null)).toMatch(/rose/);
  });

  test("una petición nueva empieza en GET y sin cuerpo", () => {
    const fresh = newRequest("Nueva");
    expect(fresh.request?.method).toBe("GET");
    expect(fresh.request?.body.mode).toBe("none");
    expect(fresh.auth).toBeNull();
    expect(newFolder("f").auth).toEqual({ type: "inherit", params: {} });
  });
});

describe("por qué una petición de la corrida está en rojo", () => {
  const result = (patch: Partial<CollectionRunResultView> = {}): CollectionRunResultView => ({
    iteration: 1,
    itemId: "r1",
    name: "Crear producto",
    folder: "",
    method: "POST",
    url: "https://api/v1/products",
    status: 200,
    durationMs: 4,
    sizeBytes: 8,
    tests: [],
    error: null,
    logs: [],
    sent: null,
    received: null,
    auth: "",
    cookies: { sent: [], stored: [], rejected: [] },
    writes: [],
    scripts: { pre: null, post: null },
    ...patch,
  });

  test("una verde no tiene motivo que contar", () => {
    const green = result({ tests: [{ name: "crea", passed: true, message: null }] });
    expect(resultFailed(green)).toBe(false);
    expect(failureReason(green)).toBeNull();
  });

  test("el error manda sobre todo lo demás", () => {
    const broken = result({ status: null, error: "Variables sin valor: baseUrl" });
    expect(resultFailed(broken)).toBe(true);
    expect(failureReason(broken)).toBe("Variables sin valor: baseUrl");
  });

  test("sin respuesta y sin error, se dice lo que se sabe", () => {
    expect(failureReason(result({ status: null }))).toBe("No hubo respuesta");
  });

  test("el primer test rojo con su mensaje, y los demás contados", () => {
    const one = result({ tests: [{ name: "existe", passed: false, message: "esperaba 200" }] });
    expect(failureReason(one)).toBe("existe — esperaba 200");

    const two = result({
      tests: [
        { name: "existe", passed: false, message: null },
        { name: "trae el id", passed: false, message: "undefined" },
      ],
    });
    expect(failureReason(two)).toBe("existe · y 1 test más en rojo");

    const three = result({
      tests: [
        { name: "existe", passed: false, message: null },
        { name: "trae el id", passed: false, message: null },
        { name: "y el precio", passed: false, message: null },
      ],
    });
    expect(failureReason(three)).toBe("existe · y 2 tests más en rojo");
  });

  test("lo que duró la corrida, cuando ya terminó", () => {
    expect(runDuration("2026-09-20T11:00:00.000Z", "2026-09-20T11:00:30.000Z")).toBe(30_000);
    expect(runDuration("2026-09-20T11:00:00.000Z", null)).toBeNull();
  });
});
