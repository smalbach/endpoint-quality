import { randomUUID } from "node:crypto";

import type { EnvironmentVariables } from "@/modules/environments/domain/model";

/**
 * Las dos reglas que comparten todas las formas de llevar algo de un proyecto a otro: bifurcar,
 * importar elementos sueltos y el fichero de proyecto.
 */

/** A sensitive variable keeps its name and loses its value: the name is the useful half — it is
 * what a `{{token}}` in a path refers to — and the value is the half that must not be duplicated. */
export function withoutSecrets(variables: EnvironmentVariables): {
  variables: EnvironmentVariables;
  emptied: string[];
} {
  const emptied: string[] = [];
  const copied = Object.fromEntries(
    Object.entries(variables).map(([name, variable]) => {
      if (!variable.sensitive) return [name, variable];
      emptied.push(name);
      return [name, { initial: "", current: "", sensitive: true }];
    }),
  );
  return { variables: copied, emptied };
}

/** Names are unique per project, so a copy into a project that already has one has to resolve the
 * collision rather than fail on it — and numbering is what a person would do. */
export function uniqueName(name: string, taken: Set<string>): string {
  const base = name.trim().slice(0, 110) || "Copiado";
  if (!taken.has(base)) return base;
  for (let suffix = 2; suffix < 1000; suffix += 1) {
    const candidate = `${base} (${suffix})`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${base} ${randomUUID().slice(0, 8)}`;
}
