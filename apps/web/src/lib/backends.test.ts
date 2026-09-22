/**
 * La elección de backend, que es lo que decide a quién se le pregunta todo lo demás.
 *
 * Lo que de verdad se afirma aquí es que la elección **sobrevive a la recarga** y que un
 * almacenamiento bloqueado no tumba la aplicación: son las dos formas en que este módulo puede
 * fallar de manera invisible — una deja al usuario hablando con un backend distinto del que cree,
 * y la otra deja la pantalla en blanco en un navegador en modo privado.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import {
  BACKENDS,
  covers,
  DEFAULT_BACKEND,
  fetchDescriptor,
  isBackendId,
  missingModules,
  onBackendChange,
  selectBackend,
  selectedBackend,
  selectedBackendId,
  apiBase,
  type BackendDescriptor,
} from "./backends";

const descriptor = (modules: Record<string, "full" | "partial" | "none">): BackendDescriptor => ({
  id: "python",
  name: "FastAPI",
  runtime: "python 3.11",
  version: "0.1.0",
  reference: false,
  modules,
});

beforeEach(() => {
  window.localStorage.clear();
  selectBackend(DEFAULT_BACKEND);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("qué backend está elegido", () => {
  test("por defecto, el de referencia", () => {
    expect(selectedBackendId()).toBe("node");
    expect(selectedBackend().label).toBe("NestJS");
    expect(apiBase()).toBe("/api");
  });

  test("elegir otro cambia el prefijo por el que salen las peticiones", () => {
    selectBackend("go");

    expect(selectedBackendId()).toBe("go");
    expect(apiBase()).toBe("/api-go");
    expect(window.localStorage.getItem("eq.backend")).toBe("go");
  });

  test("avisa a quien escuche, y deja de hacerlo al darse de baja", () => {
    const seen: string[] = [];
    const unsubscribe = onBackendChange((id) => seen.push(id));

    selectBackend("python");
    unsubscribe();
    selectBackend("go");

    expect(seen).toEqual(["python"]);
  });

  test("con el almacenamiento bloqueado, la elección vale igual para esta pestaña", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("modo privado");
    });

    expect(() => selectBackend("python")).not.toThrow();
    expect(selectedBackendId()).toBe("python");
  });

  test("solo reconoce los tres identificadores que existen", () => {
    expect(isBackendId("node")).toBe(true);
    expect(isBackendId("rust")).toBe(false);
    expect(isBackendId(7)).toBe(false);
  });

  test("los tres salen por prefijos del mismo origen, que es lo que deja viajar la cookie", () => {
    expect(BACKENDS.map((backend) => backend.base)).toEqual(["/api", "/api-py", "/api-go"]);
  });
});

describe("la elección recordada, al abrir la pestaña", () => {
  test("se recupera de localStorage", async () => {
    window.localStorage.setItem("eq.backend", "python");
    vi.resetModules();

    const fresh = await import("./backends");

    expect(fresh.selectedBackendId()).toBe("python");
  });

  test("un valor que ya no existe se ignora en vez de romper", async () => {
    window.localStorage.setItem("eq.backend", "cobol");
    vi.resetModules();

    const fresh = await import("./backends");

    expect(fresh.selectedBackendId()).toBe("node");
  });

  test("y si el almacenamiento ni se puede leer, se arranca con el de referencia", async () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("bloqueado");
    });
    vi.resetModules();

    const fresh = await import("./backends");

    expect(fresh.selectedBackendId()).toBe("node");
  });
});

describe("qué dice un backend de sí mismo", () => {
  test("trae su descriptor", async () => {
    const seen: RequestInit[] = [];
    vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
      seen.push(init);
      return new Response(JSON.stringify(descriptor({ auth: "full" })), { status: 200 });
    });

    const controller = new AbortController();
    const answer = await fetchDescriptor(BACKENDS[1], controller.signal);

    expect(answer?.name).toBe("FastAPI");
    expect(seen[0].signal).toBe(controller.signal);
  });

  test("un backend que contesta mal no trae descriptor, y no lanza", async () => {
    vi.stubGlobal("fetch", async () => new Response("", { status: 500 }));

    await expect(fetchDescriptor(BACKENDS[2])).resolves.toBeNull();
  });

  test("uno que no está levantado tampoco: no contestar es información, no una excepción", async () => {
    vi.stubGlobal("fetch", async () => {
      throw new TypeError("connection refused");
    });

    await expect(fetchDescriptor(BACKENDS[2])).resolves.toBeNull();
  });
});

describe("qué se puede usar con el backend elegido", () => {
  test("los módulos que declara en «none» son los que faltan", () => {
    expect(missingModules(descriptor({ auth: "full", runs: "none", mocks: "none" }))).toEqual(["runs", "mocks"]);
  });

  test("sin descriptor no se enumera nada", () => {
    expect(missingModules(null)).toEqual([]);
  });

  test("una pantalla parcial sigue estando disponible; una que no existe, no", () => {
    const answer = descriptor({ projects: "partial", runs: "none" });

    expect(covers(answer, "projects")).toBe(true);
    expect(covers(answer, "runs")).toBe(false);
  });

  test("mientras no se sabe, no se apaga nada", () => {
    // Una interfaz que se apaga sola mientras sondea parece rota, y el sondeo dura un instante.
    expect(covers(null, "runs")).toBe(true);
  });
});
