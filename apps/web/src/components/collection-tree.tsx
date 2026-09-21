/**
 * El árbol de la colección, a la izquierda, como en Postman.
 *
 * Es la pantalla de una colección: la lista de carpetas y peticiones en su orden, el verbo de cada
 * una en su color, y la que se está mirando resaltada. Lo que se puede hacer sobre un nodo vive en
 * su fila —añadir dentro, duplicar, subir, bajar, borrar— y no en un menú escondido: son las cinco
 * cosas que se hacen todo el rato mientras se ordena una colección.
 *
 * El estado del árbol es del padre. Aquí no se guarda nada: esto pinta `items` y avisa de lo que
 * alguien pidió, que es lo que permite que la página entera sea un borrador con un botón de
 * guardar.
 */
import { useState } from "react";

import { cn } from "@/lib/format";
import { METHOD_CLASS, flatten } from "@/lib/collections";
import type { CollectionItemView } from "@/lib/types";

export type TreeAction =
  | { kind: "select"; id: string }
  | { kind: "add-request"; parentId: string | null }
  | { kind: "add-folder"; parentId: string | null }
  | { kind: "duplicate"; id: string }
  | { kind: "delete"; id: string }
  | { kind: "move"; id: string; direction: -1 | 1 }
  | { kind: "run-folder"; id: string };

export function CollectionTree({
  items,
  selectedId,
  search,
  canEdit,
  onAction,
}: {
  items: CollectionItemView[];
  selectedId: string | null;
  /** Lo escrito en el buscador. Filtra por nombre a cualquier profundidad. */
  search: string;
  canEdit: boolean;
  onAction: (action: TreeAction) => void;
}) {
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const needle = search.trim().toLowerCase();
  // Con búsqueda, las carpetas que contienen algo que casa se abren solas: un resultado escondido
  // dentro de una carpeta cerrada es un resultado que no existe.
  const matches = (item: CollectionItemView): boolean =>
    !needle ||
    item.name.toLowerCase().includes(needle) ||
    (item.request?.url ?? "").toLowerCase().includes(needle) ||
    flatten(item.items).some((entry) => entry.item.name.toLowerCase().includes(needle));

  const row = (item: CollectionItemView, depth: number) => {
    if (!matches(item)) return null;
    const open = needle ? true : !collapsed[item.id];
    return (
      <li key={item.id}>
        <div
          className={cn(
            "group flex items-center gap-1 rounded px-1 py-1 text-sm",
            selectedId === item.id ? "bg-sky-50 text-sky-900" : "hover:bg-slate-100",
          )}
          style={{ paddingLeft: `${depth * 12 + 4}px` }}
        >
          {item.kind === "folder" ? (
            <button
              type="button"
              aria-label={open ? `Cerrar ${item.name}` : `Abrir ${item.name}`}
              className="w-4 text-slate-400"
              onClick={() => setCollapsed((state) => ({ ...state, [item.id]: open }))}
            >
              {open ? "▾" : "▸"}
            </button>
          ) : (
            <span className={cn("w-12 shrink-0 text-[10px] font-bold", METHOD_CLASS[item.request!.method])}>
              {item.request!.method}
            </span>
          )}
          <button type="button" className="flex-1 truncate text-left" onClick={() => onAction({ kind: "select", id: item.id })}>
            {item.name}
          </button>
          <span className="hidden items-center gap-0.5 text-slate-400 group-hover:flex">
            {item.kind === "folder" && (
              <>
                <IconButton label={`Correr ${item.name}`} onClick={() => onAction({ kind: "run-folder", id: item.id })}>
                  ▶
                </IconButton>
                {canEdit && (
                  <>
                    <IconButton label={`Nueva petición en ${item.name}`} onClick={() => onAction({ kind: "add-request", parentId: item.id })}>
                      +
                    </IconButton>
                    <IconButton label={`Nueva carpeta en ${item.name}`} onClick={() => onAction({ kind: "add-folder", parentId: item.id })}>
                      ⊞
                    </IconButton>
                  </>
                )}
              </>
            )}
            {canEdit && (
              <>
                <IconButton label={`Subir ${item.name}`} onClick={() => onAction({ kind: "move", id: item.id, direction: -1 })}>
                  ↑
                </IconButton>
                <IconButton label={`Bajar ${item.name}`} onClick={() => onAction({ kind: "move", id: item.id, direction: 1 })}>
                  ↓
                </IconButton>
                <IconButton label={`Duplicar ${item.name}`} onClick={() => onAction({ kind: "duplicate", id: item.id })}>
                  ⧉
                </IconButton>
                <IconButton label={`Eliminar ${item.name}`} onClick={() => onAction({ kind: "delete", id: item.id })}>
                  ✕
                </IconButton>
              </>
            )}
          </span>
        </div>
        {item.kind === "folder" && open && item.items.length > 0 && (
          <ul>{item.items.map((child) => row(child, depth + 1))}</ul>
        )}
      </li>
    );
  };

  return (
    <nav aria-label="Contenido de la colección" className="min-h-0 flex-1 overflow-y-auto">
      <ul>{items.map((item) => row(item, 0))}</ul>
      {items.length === 0 && <p className="px-2 py-4 text-sm text-slate-500">La colección está vacía.</p>}
    </nav>
  );
}

function IconButton({ label, onClick, children }: { label: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      className="rounded px-1 text-xs hover:bg-slate-200 hover:text-slate-700"
      onClick={onClick}
    >
      {children}
    </button>
  );
}
