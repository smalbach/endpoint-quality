import { describe, expect, test } from "vitest";

import { bundleFileName, describeImport, missingOperations, readBundle } from "@/lib/project-bundle";
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
      describeImport({ ...empty, settings: true, contract: "imported", workflows: 2, requestTemplates: 1, sections: ["budgets"] }),
    ).toBe("ajustes, contrato, 1 sección de configuración, 1 petición, 2 flujos");
  });
});
