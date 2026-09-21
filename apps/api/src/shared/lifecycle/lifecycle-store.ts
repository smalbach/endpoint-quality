/**
 * Archivar, eliminar y restaurar, escrito una vez para los diez recursos que lo hacen igual.
 *
 * Cada módulo sigue teniendo sus comandos —un `ArchiveMockCommand` es lo que se lee en el módulo de
 * mocks, no un comando genérico con un parámetro de tabla—, pero el orden que comprueban es el
 * mismo en todos, y esa es justo la parte que se desincroniza cuando se copia: uno deja archivar lo
 * borrado, otro deja purgar lo que sigue vivo, un tercero contesta 404 donde el resto contesta 409.
 *
 * Lo que no vive aquí es lo que cada recurso hace de más al cambiar de estado —un monitor pierde el
 * turno, un flujo tiene que comprobar quién lo referencia—: eso entra por `patch`, o se queda en el
 * módulo cuando es más que un retoque de la fila.
 */
import { ConflictError, NotFoundError } from "@/shared/errors/domain-error";
import { archivedRow, deletedRow, lifecycleState, restoredRow, type Lifecycle } from "./lifecycle";

/** Lo poco que la operación necesita del almacén del módulo. */
export type LifecycleStore<T extends Lifecycle> = {
  findById(projectId: string, id: string): Promise<T | null>;
  save(row: T): Promise<void>;
  remove(projectId: string, id: string): Promise<boolean>;
};

/**
 * Cómo se llama esto en los mensajes de error.
 *
 * En castellano y con el artículo dentro porque los errores los lee una persona en un diálogo:
 * «Ese monitor no existe» y no «monitor: not found».
 */
export type LifecycleNoun = {
  /** El código de error, sin sufijo: `mock` da `mock-not-found`. */
  code: string;
  /** «Ese mock», «Esa documentación». */
  that: string;
  /** «el mock», «la documentación». */
  the: string;
};

const missing = (noun: LifecycleNoun) => new NotFoundError(`${noun.that} no existe`, `${noun.code}-not-found`);

type Options<T> = {
  /** Lo que el recurso cambia además de la fecha: la hora de modificación, un turno, un orden. */
  patch?: (row: T, now: Date) => T;
};

/** Archivar o desarchivar. Lo borrado no se archiva: primero se restaura, y así se dice. */
export async function archiveIn<T extends Lifecycle>(
  store: LifecycleStore<T>,
  projectId: string,
  id: string,
  archived: boolean,
  now: Date,
  noun: LifecycleNoun,
  options: Options<T> = {},
): Promise<T> {
  const row = await store.findById(projectId, id);
  if (!row) throw missing(noun);
  if (row.deletedAt) throw new ConflictError(`Restaura ${noun.the} antes de archivarlo`, `${noun.code}-deleted`);
  const next = apply(archivedRow(row, archived ? now : null), now, options);
  await store.save(next);
  return next;
}

/**
 * Eliminar: blando, o definitivo con `purge`.
 *
 * Blando sobre algo ya eliminado no hace nada y contesta bien: quien pulsa dos veces el mismo botón
 * no ha cometido un error, y un 409 ahí solo enseñaría un aspa por una operación que ya está hecha.
 */
export async function deleteIn<T extends Lifecycle>(
  store: LifecycleStore<T>,
  projectId: string,
  id: string,
  purge: boolean,
  now: Date,
  noun: LifecycleNoun,
  options: Options<T> = {},
): Promise<void> {
  const row = await store.findById(projectId, id);
  if (!row) throw missing(noun);

  if (purge) {
    if (lifecycleState(row) !== "deleted")
      throw new ConflictError(`Elimina ${noun.the} antes de borrarlo para siempre`, `${noun.code}-not-deleted`);
    if (!(await store.remove(projectId, id))) throw missing(noun);
    return;
  }

  if (row.deletedAt) return;
  await store.save(apply(deletedRow(row, now), now, options));
}

/**
 * Restaurar lo eliminado: vuelve a donde estaba, archivado incluido.
 *
 * Restaurar algo que no está borrado devuelve la fila tal cual, por lo mismo que borrar dos veces:
 * el resultado que pedía ya se da.
 */
export async function restoreIn<T extends Lifecycle>(
  store: LifecycleStore<T>,
  projectId: string,
  id: string,
  now: Date,
  noun: LifecycleNoun,
  options: Options<T> = {},
): Promise<T> {
  const row = await store.findById(projectId, id);
  if (!row) throw missing(noun);
  if (!row.deletedAt) return row;
  const next = apply(restoredRow(row), now, options);
  await store.save(next);
  return next;
}

const apply = <T extends Lifecycle>(row: T, now: Date, options: Options<T>): T =>
  options.patch ? options.patch(row, now) : row;
