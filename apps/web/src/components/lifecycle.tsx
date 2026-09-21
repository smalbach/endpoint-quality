/**
 * Las dos puertas que todo recurso de un proyecto comparte: **archivar** y **eliminar**.
 *
 * Escritas una vez porque son el mismo gesto en diez pantallas, y diez copias del mismo diálogo
 * acaban diciendo cosas distintas sobre lo mismo: una que avisa de que se puede deshacer, otra que
 * no, una que ofrece archivar como alternativa y otra que solo deja borrar.
 *
 * ## El filtro
 *
 * `LifecycleTabs` es el control segmentado de siempre —el de la lista de endpoints— con los tres
 * estados: lo que se usa, lo archivado y la papelera. Vive **dentro de la pantalla** y no en un
 * menú aparte por una razón concreta: la papelera de un proyecto no es un sitio al que se va, es
 * una pregunta que se hace desde la lista donde faltaba algo.
 *
 * ## El diálogo
 *
 * `DeleteDialog` **sustituye** al `ConfirmDialog` en cada flujo de borrado, no se añade al lado.
 * Lo que cambia es que dice tres cosas que antes no decía: que se puede restaurar, dónde, y que
 * archivar es la otra opción —con su botón, ahí mismo, porque «quería quitarlo de la lista» es lo
 * que de verdad quiere casi siempre quien pulsa Eliminar.
 *
 * El borrado definitivo es el mismo diálogo con `purge`: sin salida de archivar, en rojo, y
 * diciendo que de ahí no se vuelve. Se pide **desde la papelera**, así que la confirmación es la
 * segunda y no la primera.
 */
import { useState, type ReactNode } from "react";

import { Button } from "@/components/ui";
import { Modal } from "@/components/overlay";
import { cn } from "@/lib/format";
import type { LifecycleState } from "@/lib/types";

/** Los tres estados, en el orden en que se miran. */
export const LIFECYCLE_STATES: LifecycleState[] = ["active", "archived", "deleted"];

/**
 * Cómo se llaman en la pantalla.
 *
 * En masculino y femenino porque «Archivados» al lado de una lista de suites está mal escrito, y
 * un producto que se lee en castellano no puede resolverlo con una palabra neutra que no existe.
 */
const LABELS: Record<"m" | "f", Record<LifecycleState, string>> = {
  m: { active: "Activos", archived: "Archivados", deleted: "Eliminados" },
  f: { active: "Activas", archived: "Archivadas", deleted: "Eliminadas" },
};

export function lifecycleLabel(state: LifecycleState, gender: "m" | "f" = "m"): string {
  return LABELS[gender][state];
}

/** El estado de una fila, derivado de sus fechas: borrado gana a archivado. */
export function lifecycleStateOf(row: { archivedAt?: string | null; deletedAt?: string | null }): LifecycleState {
  if (row.deletedAt) return "deleted";
  if (row.archivedAt) return "archived";
  return "active";
}

/** `?state=` para la lista. Vacío en activo: la URL más corta es la que se abre siempre. */
export function stateQuery(state: LifecycleState): string {
  return state === "active" ? "" : `?state=${state}`;
}

export function LifecycleTabs({
  state,
  onState,
  gender = "m",
  counts,
  className,
}: {
  state: LifecycleState;
  onState: (state: LifecycleState) => void;
  gender?: "m" | "f";
  /** Cuántos hay en cada estado, cuando el servidor los sabe. */
  counts?: Partial<Record<LifecycleState, number>>;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-wrap gap-1", className)} role="tablist" aria-label="Estado">
      {LIFECYCLE_STATES.map((value) => (
        <button
          key={value}
          role="tab"
          aria-selected={state === value}
          onClick={() => onState(value)}
          className={cn(
            "rounded-md px-2 py-1 text-[11px] font-medium",
            state === value ? "bg-slate-900 text-white" : "bg-slate-100 text-slate-600 hover:bg-slate-200",
          )}
        >
          {lifecycleLabel(value, gender)}
          {counts?.[value] !== undefined && <span className="ml-1 opacity-60">{counts[value]}</span>}
        </button>
      ))}
    </div>
  );
}

/**
 * El diálogo de eliminar, con archivar al lado.
 *
 * `onArchive` ausente quita esa salida: hay recursos —un flujo— donde archivar es otra cosa y se
 * hace desde su propio control, y ofrecer aquí un botón que hace algo distinto sería peor que no
 * ofrecerlo.
 */
export function DeleteDialog({
  title,
  message,
  name,
  pending,
  purge = false,
  archiveLabel = "Archivar",
  restoreHint,
  onArchive,
  onConfirm,
  onClose,
}: {
  title: string;
  /** Qué se pierde, en palabras. Lo que no hay que repetir: que se puede restaurar. */
  message: ReactNode;
  /** El nombre de la cosa, cuando el borrado definitivo tiene que pedir que se escriba. */
  name?: string;
  pending?: boolean;
  /** El definitivo: sin archivar, y pidiendo el nombre cuando se da uno. */
  purge?: boolean;
  /**
   * Dónde se restaura, cuando no es esta pantalla.
   *
   * Hay dos sitios desde los que se borra un entorno —el panel rápido de la barra y su pantalla de
   * settings— y solo uno tiene la papelera. Decir «el filtro de esta pantalla» en el otro sería
   * mandar a alguien a un control que no está ahí.
   */
  restoreHint?: ReactNode;
  archiveLabel?: string;
  onArchive?: () => void;
  onConfirm: () => void;
  onClose: () => void;
}) {
  const [typed, setTyped] = useState("");
  const locked = purge && name !== undefined && typed !== name;

  return (
    <Modal
      title={purge ? `${title} para siempre` : title}
      onClose={onClose}
      size="sm"
      footer={
        <>
          <Button variant="ghost" onClick={onClose} autoFocus>
            Cancelar
          </Button>
          {!purge && onArchive && (
            <Button variant="ghost" disabled={pending} onClick={onArchive}>
              {archiveLabel}
            </Button>
          )}
          <Button variant="danger" disabled={pending || locked} onClick={onConfirm}>
            {pending ? "…" : purge ? "Eliminar para siempre" : "Eliminar"}
          </Button>
        </>
      }
    >
      <p className="text-xs leading-5 text-slate-600">{message}</p>
      {purge ? (
        <>
          <p className="mt-2 text-xs leading-5 font-medium text-rose-700">
            Esto no se puede deshacer: de la papelera ya no vuelve.
          </p>
          {name !== undefined && (
            <label className="mt-3 block">
              <span className="text-xs font-medium text-slate-600">Escribe «{name}» para confirmar</span>
              <input
                className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm outline-none focus:border-slate-400"
                value={typed}
                onChange={(event) => setTyped(event.target.value)}
              />
            </label>
          )}
        </>
      ) : (
        <p className="mt-2 text-xs leading-5 text-slate-500">
          {restoreHint ?? `Se puede restaurar desde el filtro «${lifecycleLabel("deleted")}» de esta pantalla.`}
          {onArchive && " Archivar lo saca de la lista sin borrarlo."}
        </p>
      )}
    </Modal>
  );
}

/**
 * Los botones de una fila según dónde está: archivar y eliminar, o restaurar y borrar del todo.
 *
 * Un solo sitio que decida qué se ofrece en cada estado, porque la respuesta no es evidente: en la
 * papelera **no** se archiva —primero se restaura— y desde los archivados sí se elimina.
 */
export function LifecycleRowActions({
  state,
  onArchive,
  onRestore,
  onDelete,
  onPurge,
  pending,
  className,
  archiveLabel = "Archivar",
  unarchiveLabel = "Desarchivar",
}: {
  state: LifecycleState;
  onArchive?: (archived: boolean) => void;
  onRestore: () => void;
  onDelete: () => void;
  onPurge: () => void;
  pending?: boolean;
  className?: string;
  archiveLabel?: string;
  unarchiveLabel?: string;
}) {
  if (state === "deleted") {
    return (
      <div className={cn("flex flex-wrap items-center gap-2", className)}>
        <Button variant="ghost" className="h-7 px-2 text-[11px]" disabled={pending} onClick={onRestore}>
          Restaurar
        </Button>
        <Button variant="ghost" className="h-7 px-2 text-[11px] text-rose-600" disabled={pending} onClick={onPurge}>
          Eliminar para siempre
        </Button>
      </div>
    );
  }
  return (
    <div className={cn("flex flex-wrap items-center gap-2", className)}>
      {onArchive && (
        <Button
          variant="ghost"
          className="h-7 px-2 text-[11px]"
          disabled={pending}
          onClick={() => onArchive(state !== "archived")}
        >
          {state === "archived" ? unarchiveLabel : archiveLabel}
        </Button>
      )}
      <Button variant="ghost" className="h-7 px-2 text-[11px] text-rose-600" disabled={pending} onClick={onDelete}>
        Eliminar
      </Button>
    </div>
  );
}
