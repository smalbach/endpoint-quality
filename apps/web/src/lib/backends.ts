/**
 * A qué backend habla esta pestaña.
 *
 * El producto tiene tres implementaciones de la misma API —NestJS, FastAPI y Go— sobre la misma
 * base de datos (ver `docs/backends-poliglotas.md`). La elección se hace **antes de entrar**, se
 * recuerda, y a partir de ahí toda petición sale por ahí.
 *
 * Dos decisiones que no son de estilo:
 *
 * - **La elección vive en `localStorage` y no en el estado de React.** `api.ts` no es un
 *   componente y se llama desde sitios que no tienen contexto —un `queryFn`, un reintento de
 *   refresco— así que preguntar por el backend tiene que funcionar fuera del árbol. Además, una
 *   elección que se olvida al recargar convierte «¿con cuál estaba hablando?» en una pregunta
 *   sin respuesta justo cuando más importa.
 * - **Cambiar de backend recarga la página.** Las respuestas cacheadas son de quien las contestó,
 *   y dejarlas vivas después del cambio enseña datos de un backend bajo el nombre de otro. La
 *   sesión sobrevive igualmente: la cookie de refresco es del origen, no del prefijo, y los tres
 *   firman con el mismo secreto — que es justo lo que este montaje quiere enseñar.
 */

export type BackendId = "node" | "python" | "go";

/** Cuánto cubre un backend de un módulo. `partial` es «hay rutas, no todas». */
export type ModuleCoverage = "full" | "partial" | "none";

export type BackendDescriptor = {
  id: string;
  name: string;
  runtime: string;
  version: string;
  reference: boolean;
  modules: Record<string, ModuleCoverage>;
};

export type BackendChoice = {
  id: BackendId;
  label: string;
  /** El prefijo por el que salen las peticiones. En desarrollo lo proxea Vite; en Docker, nginx. */
  base: string;
  language: string;
};

/**
 * Los tres, con el prefijo por el que se les llega.
 *
 * Prefijos del mismo origen y no URLs absolutas a `localhost:3002`: la cookie de refresco es
 * `SameSite=Strict`, y en cuanto el front habla con otro origen deja de viajar — la sesión moriría
 * en cada recarga y el cambio de backend parecería un cierre de sesión.
 */
const BY_ID: Record<BackendId, BackendChoice> = {
  node: { id: "node", label: "NestJS", base: import.meta.env.VITE_API_URL ?? "/api", language: "TypeScript" },
  python: { id: "python", label: "FastAPI", base: import.meta.env.VITE_API_PY_URL ?? "/api-py", language: "Python" },
  go: { id: "go", label: "Go", base: import.meta.env.VITE_API_GO_URL ?? "/api-go", language: "Go" },
};

/** En el orden en que se enseñan: primero el de referencia. */
export const BACKENDS: BackendChoice[] = [BY_ID.node, BY_ID.python, BY_ID.go];

const STORAGE_KEY = "eq.backend";

/** El de referencia: el que define el contrato cuando dos discrepan, y el que se usa por defecto. */
export const DEFAULT_BACKEND: BackendId = "node";

export function isBackendId(value: unknown): value is BackendId {
  return typeof value === "string" && value in BY_ID;
}

function read(): BackendId {
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    return isBackendId(stored) ? stored : DEFAULT_BACKEND;
  } catch {
    // Un navegador con el almacenamiento bloqueado tiene que poder usar el producto: se queda con
    // el de referencia y no se recuerda la elección, que es peor que no arrancar.
    return DEFAULT_BACKEND;
  }
}

let current: BackendId = read();
const listeners = new Set<(id: BackendId) => void>();

export function selectedBackendId(): BackendId {
  return current;
}

export function selectedBackend(): BackendChoice {
  // Por índice y no con un `find` con respaldo: `current` solo toma valores de la tabla, así que
  // un respaldo sería una rama que no se puede alcanzar ni, por tanto, probar.
  return BY_ID[current];
}

/** El prefijo que usa `api.ts` en cada petición. */
export function apiBase(): string {
  return selectedBackend().base;
}

export function selectBackend(id: BackendId): void {
  current = id;
  try {
    window.localStorage.setItem(STORAGE_KEY, id);
  } catch {
    // Sin almacenamiento la elección dura lo que la pestaña. Sigue siendo una elección válida.
  }
  for (const listener of listeners) listener(id);
}

export function onBackendChange(listener: (id: BackendId) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * Qué módulos cubre un backend, según él mismo.
 *
 * `/backend` es pública a propósito: se pide mientras se decide con cuál conectar, cuando todavía
 * no hay sesión. Un fallo no es excepcional —el backend puede no estar levantado— así que devuelve
 * `null` en vez de lanzar: la pantalla enseña «no contesta», que es información.
 */
export async function fetchDescriptor(backend: BackendChoice, signal?: AbortSignal): Promise<BackendDescriptor | null> {
  try {
    const response = await fetch(`${backend.base}/backend`, { ...(signal ? { signal } : {}) });
    if (!response.ok) return null;
    return (await response.json()) as BackendDescriptor;
  } catch {
    return null;
  }
}

/** Lo que un backend no cubre, en el orden del descriptor, para poder decirlo en la pantalla. */
export function missingModules(descriptor: BackendDescriptor | null): string[] {
  if (!descriptor) return [];
  return Object.entries(descriptor.modules)
    .filter(([, coverage]) => coverage === "none")
    .map(([name]) => name);
}

/** Si una pantalla que depende de `module` se puede usar con el backend elegido. */
export function covers(descriptor: BackendDescriptor | null, module: string): boolean {
  // Sin descriptor no se apaga nada: un backend que no contestó todavía no es un backend que no
  // sabe hacer las cosas, y una interfaz que se apaga sola mientras carga parece rota.
  if (!descriptor) return true;
  return descriptor.modules[module] !== "none";
}
