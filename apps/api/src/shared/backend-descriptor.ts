/**
 * Quién contesta, y hasta dónde llega.
 *
 * El producto tiene tres implementaciones de la misma API —NestJS, FastAPI y Go— sobre la misma
 * base de datos, y el front elige con cuál habla antes de entrar (ver `docs/backends-poliglotas.md`).
 * Para que esa elección no sea a ciegas, **toda** implementación publica este documento en
 * `GET /backend`: quién es, sobre qué corre, y qué módulos cubre.
 *
 * `modules` no es una promesa sino un resumen de lo que ya pasa `tools/conformance`. Un módulo se
 * sube a `full` **después** de que el guion de paridad lo dé por bueno en esa implementación, no
 * antes: un descriptor optimista es peor que ninguno, porque el front apaga lo que no hay y
 * enciende —confiado— lo que no funciona.
 */

/** Cuánto cubre una implementación de un módulo. `partial` es «hay rutas, no todas». */
export type ModuleCoverage = "full" | "partial" | "none";

/** Los módulos de la API, en el orden en que un backend nuevo los porta: sin sesión no hay nada,
 * sin organización no hay proyecto, sin proyecto no hay contrato. */
export const API_MODULES = [
  "auth",
  "iam",
  "projects",
  "specs",
  "environments",
  "config",
  "endpoints",
  "collections",
  "workflows",
  "runs",
  "security-runs",
  "performance",
  "mocks",
  "docs",
  "monitors",
  "channels",
  "captures",
  "roles",
  "code-scan",
  "dashboard",
] as const;

export type ApiModule = (typeof API_MODULES)[number];

export type BackendDescriptor = {
  /** Estable, y el que el front guarda para recordar la elección. */
  id: string;
  name: string;
  runtime: string;
  version: string;
  /** La implementación de referencia: la que define el contrato cuando dos discrepan. Hay
   * exactamente una, y es esta. */
  reference: boolean;
  modules: Record<ApiModule, ModuleCoverage>;
};

const everything = (): Record<ApiModule, ModuleCoverage> =>
  Object.fromEntries(API_MODULES.map((module) => [module, "full"])) as Record<ApiModule, ModuleCoverage>;

/**
 * El descriptor de esta implementación.
 *
 * Todo en `full` porque este es el original: el contrato es lo que hace este código, y las otras
 * dos implementaciones se miden contra él. El día que eso deje de ser cierto —una ruta nueva que
 * nazca en otro sitio— será un módulo `partial` aquí, y estará bien que se vea.
 */
export const NODE_BACKEND: BackendDescriptor = {
  id: "node",
  name: "NestJS",
  runtime: "node 22 · nestjs 11 · typeorm",
  version: "0.1.0",
  reference: true,
  modules: everything(),
};
