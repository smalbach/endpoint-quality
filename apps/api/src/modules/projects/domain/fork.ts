import type { ConfigSection } from "@eq/runner-core";

import type { Channel } from "@/modules/channels/domain/model";
import type { ProtoFile } from "@/modules/channels/domain/grpc";
import type { ConfigRow } from "@/modules/config/domain/ports";
import type { Endpoint } from "@/modules/endpoints/domain/model";
import type { Environment } from "@/modules/environments/domain/model";
import type { Role, RolePermission, RoleRule } from "@/modules/roles/domain/model";
import type { DatasetRow, RequestTemplateRow, SuiteRow, WorkflowRow } from "@/modules/workflows/domain/model";
import type { ForkSnapshot } from "./fork-merge";
import type { ForkMergeRequest, MergeRequestEvent } from "./merge-request";
import type { Project } from "./model";

/**
 * «Este flujo de aquí es aquel de allí».
 *
 * Los ids se rehacen al bifurcar —dos proyectos no comparten filas—, así que sin este par no hay
 * forma de saber que el flujo `a1…` de la bifurcación es el `9f…` del original después de que
 * alguien le cambie el nombre. Los endpoints no lo necesitan: su identidad ya es el método y la
 * ruta, en los dos proyectos; las secciones tampoco, que se llaman igual en todos.
 */
export type LineagePair = { parentId: string; forkId: string };
export const LINKED_KINDS = ["template", "workflow", "suite", "channel", "environment", "role"] as const;
export type LinkedKind = (typeof LINKED_KINDS)[number];
export type Lineage = Record<LinkedKind, LineagePair[]>;

export const emptyLineage = (): Lineage => ({
  template: [],
  workflow: [],
  suite: [],
  channel: [],
  environment: [],
  role: [],
});

/**
 * El linaje con todos los tipos. Uno guardado antes de que las suites y los roles se compararan no
 * los tiene: sus parejas se encuentran por nombre en la primera comparación, como las de cualquier
 * elemento sin pareja, y quedan guardadas al sincronizar.
 */
export function completeLineage(lineage: Partial<Lineage>): Lineage {
  const complete = emptyLineage();
  for (const kind of LINKED_KINDS) complete[kind] = lineage[kind] ?? [];
  return complete;
}

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
  suites: SuiteRow[];
  /** Sin sesiones ni mensajes: son de quien conversó, como las corridas. */
  channels: Channel[];
  /** Los `.proto` de cada canal gRPC, por id de canal. */
  channelProtos: Record<string, ProtoFile[]>;
  environments: Environment[];
  roles: Role[];
  rolePermissions: RolePermission[];
  roleRules: RoleRule[];
  /** Todas, también las que no se comparan: `access` hace falta para derivarla de nuevo. */
  sections: ConfigRow[];
};

/**
 * Lo que una sincronización escribe, entero, antes de escribir nada.
 *
 * Un plan y no una secuencia de llamadas a los repositorios porque tiene que aplicarse **todo o
 * nada**: un fallo a mitad dejaría un proyecto con la mitad de los flujos del otro y una foto común
 * que ya no describe a ninguno. El adaptador de base de datos lo escribe en una transacción; todo
 * lo que puede rechazarlo —conflictos sin decidir, una huella vieja— se comprueba antes de
 * construirlo, salvo la versión de la bifurcación, que solo vale comprobada dentro (`expectedVersion`).
 */
export type ForkWritePlan = {
  targetProjectId: string;
  endpoints: { save: Endpoint[]; remove: string[] };
  templates: { save: RequestTemplateRow[]; remove: string[] };
  workflows: { save: WorkflowRow[]; remove: string[] };
  datasets: { save: DatasetRow[]; remove: string[] };
  suites: { save: SuiteRow[]; remove: string[] };
  /** Los canales se borran en blando, como en su módulo; los `.proto` de cada uno se reemplazan enteros. */
  channels: { save: Channel[]; remove: string[]; protos: { channelId: string; files: ProtoFile[] }[] };
  environments: { save: Environment[]; remove: string[] };
  /**
   * Los roles, y los permisos de los que se reescriben: se borran los que tenían (`clear`) y se
   * escriben los del origen. Las reglas entre roles son de todo el proyecto y se reemplazan enteras;
   * `null` si no cambia ningún rol.
   */
  roles: {
    save: Role[];
    remove: string[];
    permissions: { clear: string[]; save: RolePermission[] };
    rules: RoleRule[] | null;
  };
  /** Las secciones por nombre; `access` entra aquí ya derivada de los roles que quedan. */
  sections: { save: ConfigRow[]; remove: ConfigSection[] };
  /** Cuando el entorno activo del destino se borra, o el destino no tenía y ahora tiene. */
  project: Project | null;
  /** La bifurcación con su nueva foto común y su linaje al día. */
  fork: ProjectFork;
  /**
   * La versión que tenía la bifurcación cuando se comparó. El adaptador la vuelve a leer **dentro**
   * de la transacción, con la fila bloqueada, y si ya no es esta no escribe nada: dos aplicaciones a
   * la vez habrían pasado las dos la comprobación de la huella, que se hace antes, y la segunda
   * escribiría decisiones tomadas sobre una foto que la primera acaba de cambiar.
   */
  expectedVersion: number;
  /** Una solicitud de fusión que queda fusionada con este plan, y su línea en el hilo: en la misma
   * transacción, para que no pueda quedar fusionada sin plan ni el plan escrito con ella abierta. */
  mergeRequest?: { request: ForkMergeRequest; event: MergeRequestEvent };
  at: Date;
};
