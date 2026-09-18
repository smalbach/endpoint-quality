import type { Endpoint } from "@/modules/endpoints/domain/model";
import type { Environment } from "@/modules/environments/domain/model";
import type { DatasetRow, RequestTemplateRow, SuiteRow, WorkflowRow } from "@/modules/workflows/domain/model";
import type { ForkSnapshot } from "./fork-merge";
import type { Project } from "./model";

/**
 * «Este flujo de aquí es aquel de allí».
 *
 * Los ids se rehacen al bifurcar —dos proyectos no comparten filas—, así que sin este par no hay
 * forma de saber que el flujo `a1…` de la bifurcación es el `9f…` del original después de que
 * alguien le cambie el nombre. Los endpoints no lo necesitan: su identidad ya es el método y la
 * ruta, en los dos proyectos.
 */
export type LineagePair = { parentId: string; forkId: string };
export type LinkedKind = "template" | "workflow" | "environment";
export type Lineage = Record<LinkedKind, LineagePair[]>;

export const emptyLineage = (): Lineage => ({ template: [], workflow: [], environment: [] });

/**
 * Una bifurcación: de quién sale, y la última foto que los dos proyectos tuvieron en común.
 *
 * `base` es lo que hace correcta la comparación a tres bandas. Con solo dos lados, «el original no
 * tiene este endpoint» no distingue entre «el original lo borró» y «la bifurcación lo creó», y cada
 * una de las dos pide lo contrario. `version` sube con cada sincronización, para que una pantalla
 * pueda decir «desde la versión 3».
 *
 * La foto no lleva ningún secreto: los valores sensibles salen como su nombre y la autenticación
 * sin sus literales. Es una columna `jsonb`, y un secreto ahí sería un secreto en claro.
 */
export type ProjectFork = {
  forkProjectId: string;
  parentProjectId: string;
  organizationId: string;
  createdBy: string;
  createdAt: Date;
  /** La última vez que se trajo o se fusionó. Al nacer, el momento de la bifurcación. */
  syncedAt: Date;
  version: number;
  base: ForkSnapshot;
  lineage: Lineage;
};

/** Todo lo que se compara de un proyecto, leído de una vez. */
export type ProjectContents = {
  endpoints: Endpoint[];
  templates: RequestTemplateRow[];
  workflows: WorkflowRow[];
  datasets: DatasetRow[];
  /** No se comparan —una suite es una decisión de cada proyecto sobre qué correr junto—, pero una
   * sincronización no puede borrar un flujo que una suite del destino nombra. */
  suites: SuiteRow[];
  environments: Environment[];
};

/**
 * Lo que una sincronización escribe, entero, antes de escribir nada.
 *
 * Un plan y no una secuencia de llamadas a los repositorios porque tiene que aplicarse **todo o
 * nada**: un fallo a mitad dejaría un proyecto con la mitad de los flujos del otro y una foto común
 * que ya no describe a ninguno. El adaptador de base de datos lo escribe en una transacción; todo
 * lo que puede rechazarlo —conflictos sin decidir, una huella vieja— se comprueba antes de
 * construirlo.
 */
export type ForkWritePlan = {
  targetProjectId: string;
  endpoints: { save: Endpoint[]; remove: string[] };
  templates: { save: RequestTemplateRow[]; remove: string[] };
  workflows: { save: WorkflowRow[]; remove: string[] };
  datasets: { save: DatasetRow[]; remove: string[] };
  environments: { save: Environment[]; remove: string[] };
  /** Cuando el entorno activo del destino se borra, o el destino no tenía y ahora tiene. */
  project: Project | null;
  /** La bifurcación con su nueva foto común y su linaje al día. */
  fork: ProjectFork;
  at: Date;
};
