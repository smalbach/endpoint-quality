/**
 * Una sola puerta de import, abierta desde cualquier sitio.
 *
 * Antes había seis: un fichero de endpoints en la página de endpoints, una colección de Postman en
 * el cajón de flujos, un proyecto exportado detrás de otro botón del mismo cajón, un contrato en
 * los ajustes, y dos más. Cada una leía un subconjunto de los formatos y se callaba lo que tiraba:
 * soltar una colección en la puerta de endpoints daba endpoints y ningún flujo, y nada lo decía.
 *
 * Postman tiene una, y está donde se ve: arriba, junto a «New», visible en todas las pantallas,
 * dentro de un workspace o fuera de él, con **Cmd+O** y aceptando ficheros soltados en cualquier
 * parte de la ventana. Las tres cosas son este fichero.
 *
 * El diálogo vive aquí arriba y no en cada pantalla, porque «importar» no pertenece a ninguna: lo
 * que se importa cae en el contrato, en los endpoints, en los flujos y en los entornos a la vez.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";

import { ImportDialog, type DroppedFile } from "@/components/import-dialog";

type Opener = {
  /** Abre el diálogo. Con ficheros ya leídos cuando vienen de un arrastre. */
  open: (files?: DroppedFile[]) => void;
};

const ImportContext = createContext<Opener | null>(null);

/**
 * El botón «Importar» de cualquier pantalla llama a esto.
 *
 * Revienta fuera del provider en vez de devolver un no-op, porque el no-op ya costó una vez: el
 * botón de la cabecera se montaba fuera del contexto y no hacía absolutamente nada, sin un solo
 * error en la consola que lo dijera.
 */
export function useImport(): Opener {
  const opener = useContext(ImportContext);
  if (!opener) throw new Error("useImport fuera de <ImportProvider>");
  return opener;
}

export function ImportProvider({ projectId, children }: { projectId?: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const [initial, setInitial] = useState<DroppedFile[]>([]);
  const queryClient = useQueryClient();

  const opener = useMemo<Opener>(
    () => ({
      open: (files) => {
        setInitial(files ?? []);
        setOpen(true);
      },
    }),
    [],
  );

  // Cmd+O / Ctrl+O, el mismo atajo que Postman, y por el mismo motivo: traer lo que ya tienes es
  // de las primeras cosas que se hacen y no debería costar encontrar dónde.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() !== "o" || !(event.metaKey || event.ctrlKey) || event.shiftKey) return;
      event.preventDefault();
      opener.open();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [opener]);

  return (
    <ImportContext.Provider value={opener}>
      <DropTarget onFiles={(files) => opener.open(files)}>{children}</DropTarget>
      {open && (
        <ImportDialog
          projectId={projectId}
          initial={initial}
          onClose={() => setOpen(false)}
          // Un import toca el contrato, los endpoints, los flujos y los entornos a la vez, así que
          // lo que se invalida es todo: cualquier pantalla abierta detrás está mirando algo que
          // acaba de cambiar.
          onImported={() => void queryClient.invalidateQueries()}
        />
      )}
    </ImportContext.Provider>
  );
}

/**
 * Soltar un fichero en cualquier parte de la ventana abre el import con él dentro.
 *
 * Es lo que hace Postman y es la diferencia entre «¿dónde se importa esto?» y soltarlo. El aviso
 * se cuenta con un contador en vez de un booleano porque `dragleave` salta también al pasar de un
 * hijo a otro, y un booleano hace parpadear el cartel por toda la pantalla.
 */
function DropTarget({ onFiles, children }: { onFiles: (files: DroppedFile[]) => void; children: ReactNode }) {
  const [over, setOver] = useState(false);
  const depth = useRef(0);

  const carriesFiles = (event: DragEvent) => Array.from(event.dataTransfer?.types ?? []).includes("Files");

  const reset = useCallback(() => {
    depth.current = 0;
    setOver(false);
  }, []);

  useEffect(() => {
    const onEnter = (event: DragEvent) => {
      if (!carriesFiles(event)) return;
      depth.current += 1;
      setOver(true);
    };
    const onLeave = (event: DragEvent) => {
      if (!carriesFiles(event)) return;
      depth.current = Math.max(0, depth.current - 1);
      if (depth.current === 0) setOver(false);
    };
    // Sin esto el navegador abre el fichero soltado como si fuera una dirección, que es perder lo
    // que se estaba haciendo.
    const onOver = (event: DragEvent) => {
      if (carriesFiles(event)) event.preventDefault();
    };
    const onDrop = (event: DragEvent) => {
      if (!carriesFiles(event)) return;
      event.preventDefault();
      reset();
      const files = Array.from(event.dataTransfer?.files ?? []);
      if (!files.length) return;
      void Promise.all(files.map(async (file) => ({ name: file.name, text: await file.text() }))).then(onFiles);
    };
    window.addEventListener("dragenter", onEnter);
    window.addEventListener("dragleave", onLeave);
    window.addEventListener("dragover", onOver);
    window.addEventListener("drop", onDrop);
    return () => {
      window.removeEventListener("dragenter", onEnter);
      window.removeEventListener("dragleave", onLeave);
      window.removeEventListener("dragover", onOver);
      window.removeEventListener("drop", onDrop);
    };
  }, [onFiles, reset]);

  return (
    <>
      {children}
      {over && (
        <div className="pointer-events-none fixed inset-0 z-40 grid place-items-center bg-slate-900/20 backdrop-blur-[1px]">
          <p className="rounded-xl border-2 border-dashed border-white bg-slate-900/80 px-6 py-4 text-sm font-medium text-white">
            Suelta para importar
          </p>
        </div>
      )}
    </>
  );
}
