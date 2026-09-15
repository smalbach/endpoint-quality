/**
 * A project as a file, from the browser's side: which parts there are, reading a file somebody
 * picked before sending it, naming the download and saying what an import did.
 *
 * The API validates the file for real; this only reads enough of it to show what it carries and to
 * refuse, without a round trip, a file that is not one of ours at all.
 */
import type { ProjectBundleImportResultView, ProjectBundlePart } from "@/lib/types";

export const BUNDLE_FORMAT = "endpoint-quality/project";
export const BUNDLE_VERSION = 1;

export const BUNDLE_PARTS: ProjectBundlePart[] = [
  "settings",
  "config",
  "endpoints",
  "roles",
  "flows",
  "environments",
  "performance",
];

export const BUNDLE_PART_META: Record<ProjectBundlePart, { label: string; hint: string }> = {
  settings: { label: "Ajustes", hint: "Descripción, URL base y etiquetas. El login no viaja." },
  config: { label: "Configuración", hint: "Secciones del contrato: presupuestos, envelope, textos…" },
  endpoints: { label: "Endpoints", hint: "Rutas, parámetros, cuerpos y scripts." },
  roles: { label: "Roles y permisos", hint: "Roles, permisos por endpoint y reglas entre roles." },
  flows: { label: "Flujos", hint: "Flujos, peticiones guardadas, datasets y suites." },
  environments: { label: "Entornos", hint: "URL y variables, sin credenciales ni valores secretos." },
  performance: { label: "Planes de rendimiento", hint: "Escenarios, perfil de carga y umbrales." },
};

export type BundleFile = {
  bundle: Record<string, unknown>;
  projectName: string | null;
  exportedAt: string | null;
  /** The parts the file carries, in the fixed order. */
  parts: ProjectBundlePart[];
  counts: Partial<Record<ProjectBundlePart, number>>;
};

const length = (value: unknown) => (Array.isArray(value) ? value.length : 0);

export function readBundle(text: string): { ok: true; file: BundleFile } | { ok: false; error: string } {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return { ok: false, error: "El fichero no es JSON." };
  }
  if (!data || typeof data !== "object" || Array.isArray(data))
    return { ok: false, error: "No es un fichero exportado de endpoint-quality." };
  const bundle = data as Record<string, unknown>;
  if (bundle.format !== BUNDLE_FORMAT) return { ok: false, error: "No es un fichero exportado de endpoint-quality." };
  if (typeof bundle.version !== "number" || bundle.version > BUNDLE_VERSION)
    return { ok: false, error: "Lo exportó una versión más nueva; actualiza antes de importarlo." };

  const flows = (bundle.flows && typeof bundle.flows === "object" ? bundle.flows : {}) as Record<string, unknown>;
  const counts: Partial<Record<ProjectBundlePart, number>> = {};
  const add = (part: ProjectBundlePart, count: number) => {
    if (count > 0) counts[part] = count;
  };
  if (bundle.settings && typeof bundle.settings === "object") counts.settings = 1;
  add("config", length(bundle.config));
  add("endpoints", length(bundle.endpoints));
  add("roles", length(bundle.roles) || length(bundle.roleRules));
  add("flows", length(flows.workflows) || length(flows.requestTemplates));
  add("environments", length(bundle.environments));
  add("performance", length(bundle.performance));

  const parts = BUNDLE_PARTS.filter((part) => counts[part] !== undefined);
  if (!parts.length) return { ok: false, error: "El fichero no trae nada que importar." };
  const project = bundle.project as { name?: unknown } | undefined;
  return {
    ok: true,
    file: {
      bundle,
      projectName: typeof project?.name === "string" ? project.name : null,
      exportedAt: typeof bundle.exportedAt === "string" ? bundle.exportedAt : null,
      parts,
      counts,
    },
  };
}

const slug = (value: string) =>
  value
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);

/** `mi-api-2026-09-15.eq.json`, or `mi-api-login-2026-09-15.eq.json` for one flow. */
export function bundleFileName(projectName: string, suffix?: string, now = new Date()): string {
  const pieces = [slug(projectName) || "proyecto", ...(suffix && slug(suffix) ? [slug(suffix)] : [])];
  return `${pieces.join("-")}-${now.toISOString().slice(0, 10)}.eq.json`;
}

export function downloadJson(filename: string, data: unknown): void {
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** «2 flujos, 1 petición, ajustes» — only what was written. */
export function describeImport(result: ProjectBundleImportResultView): string {
  const counted: [number, string, string][] = [
    [result.endpoints, "endpoint", "endpoints"],
    [result.roles, "rol", "roles"],
    [result.permissions, "permiso", "permisos"],
    [result.requestTemplates, "petición", "peticiones"],
    [result.workflows, "flujo", "flujos"],
    [result.datasets, "dataset", "datasets"],
    [result.suites, "suite", "suites"],
    [result.environments, "entorno", "entornos"],
    [result.performancePlans, "plan de rendimiento", "planes de rendimiento"],
  ];
  const pieces = [
    ...(result.settings ? ["ajustes"] : []),
    ...(result.sections.length
      ? [`${result.sections.length} ${result.sections.length === 1 ? "sección" : "secciones"} de configuración`]
      : []),
    ...counted.filter(([count]) => count > 0).map(([count, one, many]) => `${count} ${count === 1 ? one : many}`),
  ];
  return pieces.length ? pieces.join(", ") : "nada nuevo";
}
