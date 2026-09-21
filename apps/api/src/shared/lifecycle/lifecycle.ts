/**
 * El ciclo de vida que comparten los recursos de un proyecto: **activo, archivado y eliminado**.
 *
 * Escrito una vez porque la pregunta es la misma en los diez sitios donde se hace —«¿qué tiene que
 * salir en esta lista?»— y diez respuestas parecidas acaban siendo diez respuestas distintas: una
 * que muestra lo archivado por defecto, otra que al restaurar pierde el archivado, otra que deja
 * borrar dos veces la misma fila.
 *
 * ## Dos fechas, no un estado
 *
 * Un recurso lleva `archivedAt` y `deletedAt`, y el estado se **deriva**: borrado gana a archivado
 * porque es lo que decide dónde sale en la pantalla, pero archivar no borra la otra fecha. Por eso
 * restaurar algo que se archivó en marzo y se borró en abril lo devuelve a los archivados y no a la
 * lista principal: vuelve a donde estaba, que es lo que «restaurar» promete.
 *
 * ## Qué es cada puerta
 *
 * - **Archivar** es reversible y voluntario: sale de la lista de trabajo y sigue existiendo para
 *   quien lo busque. No cambia lo que el recurso hace si algo lo referencia.
 * - **Eliminar** es el borrado blando: desaparece de todas las listas menos la de eliminados, y
 *   desde ahí se restaura. Es lo que hace `DELETE`.
 * - **Eliminar para siempre** (`?purge=true`) solo vale sobre algo ya eliminado. Esa segunda
 *   confirmación es a propósito: el borrado sin vuelta atrás se pide dos veces o no se pide.
 */
import { InvalidInputError } from "@/shared/errors/domain-error";

export const LIFECYCLE_STATES = ["active", "archived", "deleted"] as const;
export type LifecycleState = (typeof LIFECYCLE_STATES)[number];

/** Lo que llevan todas las filas con ciclo de vida. */
export type Lifecycle = { archivedAt: Date | null; deletedAt: Date | null };

/** La misma pareja de fechas tal y como viaja por la red. */
export type LifecycleView = { archivedAt: string | null; deletedAt: string | null };

/**
 * El estado de una fila. Borrado gana: una fila archivada y luego borrada está borrada, y su
 * `archivedAt` sigue ahí para que restaurarla la devuelva a los archivados.
 */
export function lifecycleState(row: Lifecycle): LifecycleState {
  if (row.deletedAt) return "deleted";
  if (row.archivedAt) return "archived";
  return "active";
}

/** Las dos fechas como texto, para meterlas en una vista. */
export function viewLifecycle(row: Lifecycle): LifecycleView {
  return {
    archivedAt: row.archivedAt ? row.archivedAt.toISOString() : null,
    deletedAt: row.deletedAt ? row.deletedAt.toISOString() : null,
  };
}

/**
 * El `?state=` de una lista. Sin parámetro es `active`: una pantalla que se abre sin filtros
 * enseña lo que se está usando, nunca la papelera.
 *
 * Un valor inventado es un 422 y no un «pues te enseño lo activo»: quien pide `?state=archivadas`
 * está mirando una lista que no es la que cree, y callarlo lo deja creyendo que no hay nada.
 */
export function parseLifecycleState(raw: string | undefined): LifecycleState {
  if (raw === undefined || raw === "") return "active";
  if ((LIFECYCLE_STATES as readonly string[]).includes(raw)) return raw as LifecycleState;
  throw new InvalidInputError("Ese filtro no existe", [
    { field: "state", detail: `Uno de ${LIFECYCLE_STATES.join(", ")}` },
  ]);
}

/** Si esa fila entra en esa lista. Lo que usan los almacenes en memoria y las vistas. */
export function inLifecycleState(row: Lifecycle, state: LifecycleState): boolean {
  return lifecycleState(row) === state;
}

/**
 * El trozo de SQL que filtra por estado, para un `createQueryBuilder` con alias.
 *
 * Texto y no un objeto `where` de TypeORM porque la mitad de los almacenes ya construyen su
 * consulta a mano —con `join`, con orden por varias columnas— y mezclar las dos formas obliga a
 * repetir el filtro en dos sitios.
 */
export function lifecycleSql(alias: string, state: LifecycleState): string {
  if (state === "deleted") return `${alias}."deletedAt" IS NOT NULL`;
  if (state === "archived") return `${alias}."deletedAt" IS NULL AND ${alias}."archivedAt" IS NOT NULL`;
  return `${alias}."deletedAt" IS NULL AND ${alias}."archivedAt" IS NULL`;
}

/**
 * La fila archivada, o desarchivada con `at` nulo.
 *
 * Devuelve una copia en vez de tocar la que recibe porque quien la llama la guarda entera después,
 * y un objeto compartido mutado a medias es la clase de fallo que solo se ve en producción.
 */
export function archivedRow<T extends Lifecycle>(row: T, at: Date | null): T {
  return { ...row, archivedAt: at };
}

/** La fila borrada en blando. `archivedAt` se queda: restaurarla la devuelve a donde estaba. */
export function deletedRow<T extends Lifecycle>(row: T, at: Date): T {
  return { ...row, deletedAt: at };
}

/** Restaurada: se borra la fecha del borrado y **solo** esa. */
export function restoredRow<T extends Lifecycle>(row: T): T {
  return { ...row, deletedAt: null };
}
