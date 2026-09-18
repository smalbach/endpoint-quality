import type { WorkflowDocument } from "@eq/runner-core";

import { endpointKey, type Endpoint } from "@/modules/endpoints/domain/model";
import type { Environment, EnvironmentVariables } from "@/modules/environments/domain/model";
import type { RequestTemplateRow, WorkflowRow } from "@/modules/workflows/domain/model";
import { redactAuth, withoutLiteralSecrets } from "@/modules/workflows/domain/postman-auth";
import { emptySnapshot, type ForkSnapshot, type JsonValue, type MergeKind } from "./fork-merge";
import type { Lineage, LinkedKind, ProjectContents } from "./fork";

/**
 * De filas a fotos: la clave de linaje de cada elemento y lo que de él se compara.
 *
 * Lo que se compara es lo que una persona escribió. Fuera quedan los ids, las fechas, el orden en la
 * lista y quién tocó la fila por última vez —cambian solos y no son una decisión de nadie—, y fuera
 * quedan también los secretos: de una variable sensible solo cuenta que existe y cómo se llama, y de
 * una autenticación, sus parámetros sin literales. Así la foto se puede guardar en claro, y una
 * bifurcación que nació con los secretos vacíos no sale «modificada» por eso.
 */

/** id de fila → clave de linaje, por tipo. */
export type KeyMap = Record<MergeKind, Map<string, string>>;

const emptyKeyMap = (): KeyMap => ({
  endpoint: new Map(),
  template: new Map(),
  workflow: new Map(),
  environment: new Map(),
});

/** Lo que falta de un lado se marca así en la clave: no puede coincidir con ningún id. */
export const FORK_ONLY = "fork:";

const NAMED: Record<LinkedKind, (contents: ProjectContents) => { id: string; name: string }[]> = {
  template: (contents) => contents.templates,
  workflow: (contents) => contents.workflows,
  environment: (contents) => contents.environments,
};

/** Las claves del original: sus propios ids. El original es el que da nombre al linaje. */
export function parentKeys(parent: ProjectContents): KeyMap {
  const keys = emptyKeyMap();
  for (const endpoint of parent.endpoints) keys.endpoint.set(endpoint.id, endpointKey(endpoint.method, endpoint.path));
  for (const kind of ["template", "workflow", "environment"] as const) {
    for (const row of NAMED[kind](parent)) keys[kind].set(row.id, row.id);
  }
  return keys;
}

/**
 * Las claves de la bifurcación: el id del original con el que está emparejado cada elemento.
 *
 * Lo que no tiene pareja se busca **por nombre** en el original, entre los que tampoco la tienen:
 * dos personas que crearon «Login» cada una en su lado están hablando del mismo flujo, y tratarlos
 * como dos elementos distintos acabaría con dos «Login» en el mismo proyecto —que los nombres únicos
 * no permiten— en vez de con un conflicto que alguien decide. Esas parejas nuevas se devuelven
 * aparte, para que quien aplica las guarde.
 *
 * Sin `parent`, solo cuentan las parejas guardadas: es la foto de después de sincronizar, cuando
 * todas las que había que hacer ya están hechas.
 */
export function forkKeys(
  fork: ProjectContents,
  lineage: Lineage,
  parent?: ProjectContents,
): { keys: KeyMap; implicit: Lineage } {
  const keys = emptyKeyMap();
  const implicit: Lineage = { template: [], workflow: [], environment: [] };
  for (const endpoint of fork.endpoints) keys.endpoint.set(endpoint.id, endpointKey(endpoint.method, endpoint.path));
  for (const kind of ["template", "workflow", "environment"] as const) {
    const byFork = new Map(lineage[kind].map((pair) => [pair.forkId, pair.parentId]));
    const claimed = new Set(
      NAMED[kind](fork)
        .map((row) => byFork.get(row.id))
        .filter(Boolean),
    );
    const parentByName = new Map((parent ? NAMED[kind](parent) : []).map((row) => [row.name, row.id]));
    for (const row of NAMED[kind](fork)) {
      const paired = byFork.get(row.id);
      if (paired) {
        keys[kind].set(row.id, paired);
        continue;
      }
      const namesake = parentByName.get(row.name);
      if (namesake && !claimed.has(namesake)) {
        claimed.add(namesake);
        implicit[kind].push({ parentId: namesake, forkId: row.id });
        keys[kind].set(row.id, namesake);
        continue;
      }
      keys[kind].set(row.id, `${FORK_ONLY}${row.id}`);
    }
  }
  return { keys, implicit };
}

export const endpointContent = (endpoint: Endpoint): JsonValue =>
  json({
    method: endpoint.method,
    path: endpoint.path,
    description: endpoint.description,
    pathParameters: endpoint.pathParameters,
    query: endpoint.query,
    headers: endpoint.headers,
    body: endpoint.body,
    requiresAuth: endpoint.requiresAuth,
    auth: redactAuth(endpoint.auth).auth,
    tags: endpoint.tags,
    status: endpoint.status,
    preRequestScript: endpoint.preRequestScript,
    postResponseScript: endpoint.postResponseScript,
  });

export const templateContent = (template: RequestTemplateRow): JsonValue =>
  json({
    name: template.name,
    operationId: template.operationId,
    description: template.description,
    expectedStatus: template.expectedStatus,
    parameters: template.parameters,
    disabledParameters: template.disabledParameters,
    headers: template.headers,
    disabledHeaders: template.disabledHeaders,
    body: template.body,
    auth: template.auth,
  });

/** Una referencia que no apunta a nada se escribe igual en los dos lados, para que dos flujos
 * rotos del mismo modo no salgan distintos por el id al que apuntaba cada uno. */
const DANGLING = "(no existe)";

/**
 * El documento de un flujo con sus referencias escritas como claves de linaje.
 *
 * Un paso nombra su prueba por id, y el mismo paso en la bifurcación nombra otro id —la copia de
 * esa prueba—. Comparar los ids diría que todos los flujos cambiaron el día de la bifurcación.
 */
export function linkedDefinition(definition: WorkflowDocument, keys: KeyMap): WorkflowDocument {
  const clean = withoutLiteralSecrets(definition);
  return {
    ...clean,
    steps: clean.steps.map((step) => ({
      ...step,
      ...(step.requestTemplateId ? { requestTemplateId: keys.template.get(step.requestTemplateId) ?? DANGLING } : {}),
      ...(step.subflow
        ? { subflow: { ...step.subflow, workflowId: keys.workflow.get(step.subflow.workflowId) ?? DANGLING } }
        : {}),
    })),
  };
}

export function workflowContent(workflow: WorkflowRow, contents: ProjectContents, keys: KeyMap): JsonValue {
  return json({
    name: workflow.name,
    description: workflow.description,
    status: workflow.status,
    definition: linkedDefinition(workflow.definition, keys),
    // Por nombre y en orden: un dataset no tiene más identidad que su nombre dentro del flujo.
    datasets: contents.datasets
      .filter((dataset) => dataset.workflowId === workflow.id)
      .map((dataset) => ({ name: dataset.name, rows: dataset.rows }))
      .sort((a, b) => a.name.localeCompare(b.name)),
  });
}

/** Una variable sensible es su nombre y la marca: el valor es cifrado de un solo proyecto. */
const comparableVariables = (variables: EnvironmentVariables) =>
  Object.fromEntries(
    Object.entries(variables).map(([name, variable]) => [
      name,
      variable.sensitive
        ? { sensitive: true }
        : { initial: variable.initial, current: variable.current, sensitive: false },
    ]),
  );

export const environmentContent = (environment: Environment): JsonValue =>
  json({
    name: environment.name,
    baseUrl: environment.baseUrl,
    specUrl: environment.specUrl,
    variables: comparableVariables(environment.variables),
    disabledVariables: comparableVariables(environment.disabledVariables),
  });

/** La foto de un proyecto con las claves dadas. */
export function snapshotOf(contents: ProjectContents, keys: KeyMap): ForkSnapshot {
  const snapshot = emptySnapshot();
  for (const endpoint of contents.endpoints) {
    snapshot.endpoint[keys.endpoint.get(endpoint.id)!] = {
      label: `${endpoint.method} ${endpoint.path}`,
      content: endpointContent(endpoint),
    };
  }
  for (const template of contents.templates) {
    snapshot.template[keys.template.get(template.id)!] = { label: template.name, content: templateContent(template) };
  }
  for (const workflow of contents.workflows) {
    snapshot.workflow[keys.workflow.get(workflow.id)!] = {
      label: workflow.name,
      content: workflowContent(workflow, contents, keys),
    };
  }
  for (const environment of contents.environments) {
    snapshot.environment[keys.environment.get(environment.id)!] = {
      label: environment.name,
      content: environmentContent(environment),
    };
  }
  return snapshot;
}

/** Por JSON y de vuelta: lo que se guarda en `jsonb` es lo que se compara, sin `undefined` ni fechas
 * que la columna devolvería de otra forma. */
const json = (value: unknown): JsonValue => JSON.parse(JSON.stringify(value)) as JsonValue;
