/**
 * Las dos puertas compartidas: el filtro de estado y el diálogo de borrado.
 *
 * Se prueban aquí y no en cada pantalla porque son un solo sitio: lo que cada pantalla tiene que
 * demostrar es que llama a su ruta, no que el diálogo dibuja su texto.
 */
import { describe, expect, test, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";

import {
  DeleteDialog,
  LifecycleRowActions,
  LifecycleTabs,
  lifecycleLabel,
  lifecycleStateOf,
  stateQuery,
} from "@/components/lifecycle";

describe("el estado de una fila", () => {
  test("se deriva de las fechas, y borrado gana a archivado", () => {
    expect(lifecycleStateOf({})).toBe("active");
    expect(lifecycleStateOf({ archivedAt: "2026-01-01" })).toBe("archived");
    // Archivada en marzo y borrada en abril está borrada: es donde sale en la pantalla, y su
    // `archivedAt` sigue ahí para que restaurarla la devuelva a los archivados.
    expect(lifecycleStateOf({ archivedAt: "2026-03-01", deletedAt: "2026-04-01" })).toBe("deleted");
  });

  test("el activo no lleva `?state=`: la URL que se abre siempre es la más corta", () => {
    expect(stateQuery("active")).toBe("");
    expect(stateQuery("archived")).toBe("?state=archived");
    expect(stateQuery("deleted")).toBe("?state=deleted");
  });

  test("las etiquetas van en masculino o en femenino, según de qué se hable", () => {
    expect(lifecycleLabel("archived")).toBe("Archivados");
    expect(lifecycleLabel("archived", "f")).toBe("Archivadas");
    expect(lifecycleLabel("deleted", "f")).toBe("Eliminadas");
  });
});

describe("el filtro", () => {
  test("marca el abierto, dice cuántos hay cuando se sabe, y avisa del que se pulsa", () => {
    const onState = vi.fn();
    render(<LifecycleTabs state="archived" onState={onState} counts={{ active: 3, deleted: 1 }} />);
    expect(screen.getByRole("tab", { name: "Archivados" }).getAttribute("aria-selected")).toBe("true");
    expect(screen.getByRole("tab", { name: /Activos\s*3/ })).toBeTruthy();
    expect(screen.getByRole("tab", { name: /Eliminados\s*1/ })).toBeTruthy();
    fireEvent.click(screen.getByRole("tab", { name: /Eliminados/ }));
    expect(onState).toHaveBeenCalledWith("deleted");
  });
});

describe("los botones de una fila", () => {
  const spies = () => ({ onArchive: vi.fn(), onRestore: vi.fn(), onDelete: vi.fn(), onPurge: vi.fn() });

  test("en la lista: archivar y eliminar", () => {
    const handlers = spies();
    render(<LifecycleRowActions state="active" {...handlers} />);
    fireEvent.click(screen.getByRole("button", { name: "Archivar" }));
    expect(handlers.onArchive).toHaveBeenCalledWith(true);
    fireEvent.click(screen.getByRole("button", { name: "Eliminar" }));
    expect(handlers.onDelete).toHaveBeenCalled();
  });

  test("en los archivados: desarchivar, y eliminar sigue estando", () => {
    const handlers = spies();
    render(<LifecycleRowActions state="archived" {...handlers} unarchiveLabel="Volver a la lista" />);
    fireEvent.click(screen.getByRole("button", { name: "Volver a la lista" }));
    expect(handlers.onArchive).toHaveBeenCalledWith(false);
    expect(screen.getByRole("button", { name: "Eliminar" })).toBeTruthy();
  });

  test("en la papelera: restaurar y borrar del todo, y **nunca** archivar", () => {
    const handlers = spies();
    render(<LifecycleRowActions state="deleted" {...handlers} />);
    expect(screen.queryByRole("button", { name: "Archivar" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Restaurar" }));
    expect(handlers.onRestore).toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Eliminar para siempre" }));
    expect(handlers.onPurge).toHaveBeenCalled();
  });

  test("sin `onArchive` la fila solo ofrece eliminar: hay recursos que se archivan por otro sitio", () => {
    const { onArchive: _unused, ...handlers } = spies();
    render(<LifecycleRowActions state="active" {...handlers} />);
    expect(screen.queryByRole("button", { name: "Archivar" })).toBeNull();
    expect(screen.getByRole("button", { name: "Eliminar" })).toBeTruthy();
  });
});

describe("el diálogo de borrado", () => {
  test("dice dónde se restaura, ofrece archivar y confirma", () => {
    const onArchive = vi.fn();
    const onConfirm = vi.fn();
    const onClose = vi.fn();
    render(
      <DeleteDialog
        title="Eliminar el mock"
        message="La URL deja de contestar."
        onArchive={onArchive}
        onConfirm={onConfirm}
        onClose={onClose}
      />,
    );
    const dialog = within(screen.getByRole("dialog"));
    expect(dialog.getByText(/Se puede restaurar desde el filtro «Eliminados» de esta pantalla/)).toBeTruthy();
    expect(dialog.getByText(/Archivar lo saca de la lista sin borrarlo/)).toBeTruthy();
    fireEvent.click(dialog.getByRole("button", { name: "Archivar" }));
    expect(onArchive).toHaveBeenCalled();
    fireEvent.click(dialog.getByRole("button", { name: "Eliminar" }));
    expect(onConfirm).toHaveBeenCalled();
    fireEvent.click(dialog.getByRole("button", { name: "Cancelar" }));
    expect(onClose).toHaveBeenCalled();
  });

  test("sin archivar, y con otra pista: la papelera no siempre está en esta pantalla", () => {
    render(
      <DeleteDialog
        title="Eliminar entorno"
        message="Sale del selector."
        restoreHint="Se restaura en Settings → Entornos."
        onConfirm={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    const dialog = within(screen.getByRole("dialog"));
    expect(dialog.getByText(/Se restaura en Settings → Entornos/)).toBeTruthy();
    expect(dialog.queryByRole("button", { name: "Archivar" })).toBeNull();
    expect(dialog.queryByText(/Archivar lo saca de la lista/)).toBeNull();
  });

  test("el definitivo avisa de que no vuelve y pide el nombre escrito", () => {
    const onConfirm = vi.fn();
    render(
      <DeleteDialog
        title="Eliminar el mock"
        purge
        name="el del front"
        message="Se va con su bitácora."
        onArchive={vi.fn()}
        onConfirm={onConfirm}
        onClose={vi.fn()}
      />,
    );
    const dialog = within(screen.getByRole("dialog"));
    expect(dialog.getByText("Eliminar el mock para siempre")).toBeTruthy();
    expect(dialog.getByText(/de la papelera ya no vuelve/)).toBeTruthy();
    // Archivar no sale en el definitivo: ahí ya no es una alternativa.
    expect(dialog.queryByRole("button", { name: "Archivar" })).toBeNull();

    const button = dialog.getByRole("button", { name: "Eliminar para siempre" }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    fireEvent.change(dialog.getByRole("textbox"), { target: { value: "el del" } });
    expect(button.disabled).toBe(true);
    fireEvent.change(dialog.getByRole("textbox"), { target: { value: "el del front" } });
    fireEvent.click(button);
    expect(onConfirm).toHaveBeenCalled();
  });

  test("el definitivo sin nombre no pide escribir nada, y en marcha dice que está en marcha", () => {
    render(
      <DeleteDialog title="Eliminar el canal" purge message="Se va." pending onConfirm={vi.fn()} onClose={vi.fn()} />,
    );
    const dialog = within(screen.getByRole("dialog"));
    expect(dialog.queryByRole("textbox")).toBeNull();
    expect(dialog.getByText("…")).toBeTruthy();
  });
});
