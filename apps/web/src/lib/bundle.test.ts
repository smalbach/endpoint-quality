/**
 * The acceptance criterion of P5, checked against the artefact rather than against intent.
 *
 * The plan's line is "sin ninguna constante de dominio en el bundle". Reading the source and
 * concluding it looks clean is not a check — the coupled dashboard's constants were spread across
 * five modules and each one looked incidental where it sat. So this builds the app and greps the
 * output for the specific literals that made the old version single-purpose.
 *
 * It fails **loudly rather than skipping** when the build is missing, because a test that passes
 * without an artefact to inspect is the exact hardcoded green tick this whole product replaced.
 *
 *     pnpm --filter @eq/web build && pnpm --filter @eq/web test
 */
import { describe, expect, test } from "vitest";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

const DIST = resolve(__dirname, "../../dist");

/**
 * What must not be in the bundle, and why each one is the tell.
 *
 * These are taken verbatim from the coupled dashboard: the EAN it used as a sample, the store
 * that its fixtures left free, the coordinates of Bogotá, the RFP's latency figures, the
 * parameter names of one company's catalogue, and its base URL. If a project's data has leaked
 * back into the front end, one of these is how it shows up first.
 */
const FORBIDDEN: { needle: string; why: string }[] = [
  { needle: "7702001234567", why: "un EAN de las fixtures de Digital Catalog" },
  { needle: "ean_sap", why: "un parámetro del contrato de un solo cliente" },
  { needle: "code_sap", why: "un parámetro del contrato de un solo cliente" },
  { needle: "vkp0_base_price_sap", why: "un campo de payload de un solo cliente" },
  { needle: "4.6482", why: "las coordenadas de Bogotá del bloque geográfico" },
  { needle: "-74.0648", why: "las coordenadas de Bogotá del bloque geográfico" },
  { needle: "alimentos_liquidos", why: "una categoría del catálogo de un cliente" },
  { needle: "Cundinamarca", why: "un departamento de las fixtures" },
  { needle: "RFP §6", why: "la fuente de los presupuestos de un contrato concreto" },
  { needle: "127.0.0.1:8100", why: "la URL base del backend de Digital Catalog" },
  { needle: "bundled.yaml", why: "el nombre del documento de un cliente" },
  { needle: "catalog:admin", why: "un scope de un solo proyecto" },
  { needle: "StoreAssortmentBulkResult", why: "un tipo de respuesta de un solo contrato" },
];

function bundleFiles(directory: string): string[] {
  if (!existsSync(directory)) return [];
  return readdirSync(directory).flatMap((entry) => {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) return bundleFiles(path);
    return /\.(js|css|html)$/.test(entry) ? [path] : [];
  });
}

const files = bundleFiles(DIST);

describe("el bundle no lleva dentro ningún proyecto", () => {
  test("hay un build que inspeccionar", () => {
    // Skipping here would make every assertion below vacuously true, which is worse than a red
    // build: it would report that the decoupling holds without having looked.
    expect(files.length, `no hay build en ${DIST}: ejecuta \`pnpm --filter @eq/web build\` antes de esta prueba`).toBeGreaterThan(0);
  });

  test.each(FORBIDDEN)("no aparece $needle ($why)", ({ needle }) => {
    const offenders = files.filter((file) => readFileSync(file, "utf8").includes(needle));
    expect(offenders, `"${needle}" aparece en ${offenders.join(", ")}`).toEqual([]);
  });

  test("tampoco aparece ninguna descripción de caso generado", () => {
    // The wording of the generated cases is a resource the server owns. Finding it here would
    // mean the front end had started generating cases of its own, which is how the two would
    // drift into disagreeing about what a run will do.
    const wordings = ["Listado sin filtros", "Radio geográfico", "Clave natural duplicada", "Crear, eliminar y confirmar"];
    for (const wording of wordings) {
      const offenders = files.filter((file) => readFileSync(file, "utf8").includes(wording));
      expect(offenders, `"${wording}" aparece en ${offenders.join(", ")}`).toEqual([]);
    }
  });

  test("no queda nada de la infraestructura que el dashboard acoplado arrastraba", () => {
    // vinext and the Cloudflare Worker were the deployment the old version was tied to. A static
    // bundle is what makes "web o local" a choice rather than a rewrite.
    for (const needle of ["vinext", "wrangler", "cloudflare"]) {
      const offenders = files.filter((file) => readFileSync(file, "utf8").toLowerCase().includes(needle));
      expect(offenders, `"${needle}" aparece en ${offenders.join(", ")}`).toEqual([]);
    }
  });

  test("el bundle es estático: no hay servidor que lo acompañe", () => {
    // A single `index.html` plus assets, servable from a CDN, an nginx or the API container.
    expect(existsSync(join(DIST, "index.html"))).toBe(true);
    const scripts = files.filter((file) => file.endsWith(".js"));
    expect(scripts.length).toBeGreaterThan(0);
  });
});
