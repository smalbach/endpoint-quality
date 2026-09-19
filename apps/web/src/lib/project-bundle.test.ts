import { describe, expect, test, vi } from "vitest";

import { bundleFileName, describeImport, downloadJson, missingOperations, readBundle } from "@/lib/project-bundle";
import type { ProjectBundleImportResultView } from "@/lib/types";

const empty: ProjectBundleImportResultView = {
  parts: [],
  settings: false,
  contract: null,
  sections: [],
  endpoints: 0,
  examples: 0,
  roles: 0,
  permissions: 0,
  requestTemplates: 0,
  workflows: 0,
  datasets: 0,
  suites: 0,
  environments: 0,
  channels: 0,
  performancePlans: 0,
  skipped: [],
};

describe("leer un fichero de proyecto", () => {
  test("cuenta lo que trae y ordena las partes", () => {
    const read = readBundle(
      JSON.stringify({
        format: "endpoint-quality/project",
        version: 1,
        project: { name: "Tienda" },
        exportedAt: "2026-09-15T10:00:00.000Z",
        environments: [{ name: "staging" }],
        flows: { workflows: [{}, {}], requestTemplates: [{ name: "Listar", operationId: "listThings" }, {}] },
        contract: { raw: "openapi: 3.1.0" },
        settings: {},
        endpoints: [],
      }),
    );
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.file.parts).toEqual(["settings", "contract", "flows", "environments"]);
    expect(read.file.templates).toEqual([{ name: "Listar", operationId: "listThings" }]);
    expect(read.file.counts.flows).toBe(2);
    expect(read.file.projectName).toBe("Tienda");
  });

  test("rechaza lo que no es un fichero nuestro", () => {
    expect(readBundle("no es json")).toEqual({ ok: false, error: "El fichero no es JSON." });
    expect(readBundle(JSON.stringify({ info: { name: "Postman" } })).ok).toBe(false);
    expect(readBundle(JSON.stringify({ format: "endpoint-quality/project", version: 9, endpoints: [{}] })).ok).toBe(
      false,
    );
    expect(readBundle(JSON.stringify({ format: "endpoint-quality/project", version: 1 })).ok).toBe(false);
  });
});

describe("nombre y resumen", () => {
  test("el nombre del fichero es legible y lleva la fecha", () => {
    const now = new Date("2026-09-15T12:00:00Z");
    expect(bundleFileName("Mi API Pública", undefined, now)).toBe("mi-api-publica-2026-09-15.eq.json");
    expect(bundleFileName("Mi API", "Login y compra", now)).toBe("mi-api-login-y-compra-2026-09-15.eq.json");
  });

  test("las peticiones cuya operación falta se nombran con ella", () => {
    const templates = [
      { name: "Listar", operationId: "listThings" },
      { name: "Crear", operationId: "createThing" },
    ];
    expect(missingOperations(templates, new Set(["listThings"]))).toEqual(["Crear (createThing)"]);
    expect(missingOperations(templates, new Set())).toHaveLength(2);
  });

  test("el resumen solo nombra lo que se escribió", () => {
    expect(describeImport(empty)).toBe("nada nuevo");
    expect(
      describeImport({
        ...empty,
        settings: true,
        contract: "imported",
        workflows: 2,
        requestTemplates: 1,
        sections: ["budgets"],
      }),
    ).toBe("ajustes, contrato, 1 sección de configuración, 1 petición, 2 flujos");
    expect(describeImport({ ...empty, contract: "unchanged", sections: ["a", "b"], roles: 1 })).toBe(
      "contrato (ya estaba), 2 secciones de configuración, 1 rol",
    );
  });

  test("sin nombre legible el fichero se llama «proyecto», y un sufijo vacío no añade nada", () => {
    const now = new Date("2026-09-15T12:00:00Z");
    expect(bundleFileName("¡¡!!", "---", now)).toBe("proyecto-2026-09-15.eq.json");
  });
});

describe("bordes del fichero", () => {
  test("un JSON que no es un objeto no es un fichero nuestro", () => {
    for (const text of ["null", "[]", "3"])
      expect(readBundle(text)).toEqual({ ok: false, error: "No es un fichero exportado de endpoint-quality." });
  });

  test("sin nombre, fecha ni peticiones legibles, lo cuenta igual", () => {
    const read = readBundle(
      JSON.stringify({
        format: "endpoint-quality/project",
        version: 1,
        project: { name: 7 },
        roleRules: [{}],
        flows: { requestTemplates: "no es una lista", workflows: [] },
        contract: { raw: "   " },
      }),
    );
    expect(read).toMatchObject({
      ok: true,
      file: { projectName: null, exportedAt: null, parts: ["roles"], counts: { roles: 1 }, templates: [] },
    });
  });

  test("las peticiones sueltas cuentan como flujos, y una entrada nula se salta", () => {
    const read = readBundle(
      JSON.stringify({
        format: "endpoint-quality/project",
        version: 1,
        flows: { requestTemplates: [null, { name: "Crear", operationId: "create" }] },
      }),
    );
    expect(read).toMatchObject({
      ok: true,
      file: { counts: { flows: 2 }, templates: [{ name: "Crear", operationId: "create" }] },
    });
  });

  test("una versión que no es un número se rechaza", () => {
    expect(readBundle(JSON.stringify({ format: "endpoint-quality/project", version: "1", endpoints: [{}] }))).toEqual({
      ok: false,
      error: "Lo exportó una versión más nueva; actualiza antes de importarlo.",
    });
  });
});

describe("descargar", () => {
  test("descarga el JSON con su nombre y suelta la URL después", async () => {
    vi.useFakeTimers();
    // jsdom does not implement blob URLs, so the two statics are stood in for the test.
    let blob: Blob | undefined;
    const create = vi.fn((value: Blob) => {
      blob = value;
      return "blob:bundle";
    });
    const revoke = vi.fn();
    Object.assign(URL, { createObjectURL: create, revokeObjectURL: revoke });
    const clicked: { href: string; download: string; attached: boolean }[] = [];
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
      clicked.push({ href: this.href, download: this.download, attached: document.body.contains(this) });
    });
    try {
      downloadJson("mi-api.eq.json", { a: 1 });
      expect(clicked).toEqual([{ href: "blob:bundle", download: "mi-api.eq.json", attached: true }]);
      expect(document.querySelector("a")).toBeNull();
      expect(blob!.type).toBe("application/json");
      expect(revoke).not.toHaveBeenCalled();
      vi.advanceTimersByTime(10_000);
      expect(revoke).toHaveBeenCalledWith("blob:bundle");

      // jsdom's Blob has no `text()`; its FileReader is timer-driven, hence the real timers.
      vi.useRealTimers();
      const text = await new Promise<string>((resolve) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result as string);
        reader.readAsText(blob!);
      });
      expect(text).toBe('{\n  "a": 1\n}');
    } finally {
      click.mockRestore();
      Reflect.deleteProperty(URL, "createObjectURL");
      Reflect.deleteProperty(URL, "revokeObjectURL");
      vi.useRealTimers();
    }
  });
});
