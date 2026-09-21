/**
 * El árbol de la izquierda: lo que se ve y lo que se pide desde él.
 *
 * No guarda nada —el estado es de la página— así que lo que hay que fijar es que pinta el orden y
 * la jerarquía, que el buscador abre lo que esconde, y que cada botón de una fila pide exactamente
 * una cosa.
 */
import { describe, expect, test, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

import { CollectionTree } from "@/components/collection-tree";
import { newFolder, newRequest } from "@/lib/collections";
import type { CollectionItemView } from "@/lib/types";

const tree = (): CollectionItemView[] => [
  { ...newFolder("01 · Productos", "f1"), items: [newRequest("Crear", "r1"), newRequest("Leer", "r2")] },
  newRequest("Salud", "r3"),
];

function draw(over: Partial<Parameters<typeof CollectionTree>[0]> = {}) {
  const onAction = vi.fn();
  render(
    <CollectionTree items={tree()} selectedId={null} search="" canEdit onAction={onAction} {...over} />,
  );
  return onAction;
}

describe("el árbol", () => {
  test("pinta carpetas y peticiones con su verbo, y elegir una avisa", () => {
    const onAction = draw();
    expect(screen.getByText("01 · Productos")).toBeTruthy();
    expect(screen.getAllByText("GET").length).toBe(3);
    fireEvent.click(screen.getByRole("button", { name: "Crear" }));
    expect(onAction).toHaveBeenCalledWith({ kind: "select", id: "r1" });
  });

  test("una carpeta se cierra y se vuelve a abrir", () => {
    draw();
    fireEvent.click(screen.getByRole("button", { name: "Cerrar 01 · Productos" }));
    expect(screen.queryByRole("button", { name: "Crear" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Abrir 01 · Productos" }));
    expect(screen.getByRole("button", { name: "Crear" })).toBeTruthy();
  });

  test("el buscador filtra por nombre y por URL, y abre la carpeta que esconde el resultado", () => {
    const { rerender } = render(
      <CollectionTree items={tree()} selectedId={null} search="crear" canEdit onAction={vi.fn()} />,
    );
    expect(screen.getByRole("button", { name: "Crear" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Salud" })).toBeNull();
    // La carpeta sale porque lo que casa está dentro.
    expect(screen.getByText("01 · Productos")).toBeTruthy();

    rerender(<CollectionTree items={tree()} selectedId={null} search="nada-de-esto" canEdit onAction={vi.fn()} />);
    expect(screen.queryByRole("button", { name: "Crear" })).toBeNull();
  });

  test("una carpeta ofrece correrla y crear dentro; una petición no", () => {
    const onAction = draw();
    fireEvent.click(screen.getByRole("button", { name: "Correr 01 · Productos" }));
    expect(onAction).toHaveBeenCalledWith({ kind: "run-folder", id: "f1" });
    fireEvent.click(screen.getByRole("button", { name: "Nueva petición en 01 · Productos" }));
    expect(onAction).toHaveBeenCalledWith({ kind: "add-request", parentId: "f1" });
    fireEvent.click(screen.getByRole("button", { name: "Nueva carpeta en 01 · Productos" }));
    expect(onAction).toHaveBeenCalledWith({ kind: "add-folder", parentId: "f1" });
    expect(screen.queryByRole("button", { name: "Correr Crear" })).toBeNull();
  });

  test("subir, bajar, duplicar y eliminar piden lo suyo", () => {
    const onAction = draw();
    fireEvent.click(screen.getByRole("button", { name: "Subir Crear" }));
    expect(onAction).toHaveBeenCalledWith({ kind: "move", id: "r1", direction: -1 });
    fireEvent.click(screen.getByRole("button", { name: "Bajar Crear" }));
    expect(onAction).toHaveBeenCalledWith({ kind: "move", id: "r1", direction: 1 });
    fireEvent.click(screen.getByRole("button", { name: "Duplicar Crear" }));
    expect(onAction).toHaveBeenCalledWith({ kind: "duplicate", id: "r1" });
    fireEvent.click(screen.getByRole("button", { name: "Eliminar Crear" }));
    expect(onAction).toHaveBeenCalledWith({ kind: "delete", id: "r1" });
  });

  test("quien solo mira no ve los botones que escriben", () => {
    draw({ canEdit: false });
    expect(screen.queryByRole("button", { name: "Eliminar Crear" })).toBeNull();
    expect(screen.getByRole("button", { name: "Correr 01 · Productos" })).toBeTruthy();
  });

  test("una colección vacía lo dice", () => {
    render(<CollectionTree items={[]} selectedId={null} search="" canEdit onAction={vi.fn()} />);
    expect(screen.getByText("La colección está vacía.")).toBeTruthy();
  });

  test("una carpeta vacía no pinta lista de hijos", () => {
    render(
      <CollectionTree items={[newFolder("Vacía", "f9")]} selectedId="f9" search="" canEdit onAction={vi.fn()} />,
    );
    expect(screen.getByText("Vacía")).toBeTruthy();
  });
});
