/**
 * El panel de suites: se crea una con nombre desde el diálogo; al abrirla se ven sus flujos en
 * orden (uno borrado se dice); las flechas y el arrastre reordenan escribiendo la lista entera; la
 * × quita un flujo; el selector solo ofrece los que no están y no están archivados; ejecutar pide
 * al menos un flujo y no estar ya corriendo. Quien solo lee puede ejecutar, nada más.
 */
import { describe, expect, test, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";

import { SuitesPanel } from "@/components/suites-panel";
import type { SuiteView, WorkflowView } from "@/lib/types";

const workflows = [
  { id: "w1", name: "Login", status: "ready" },
  { id: "w2", name: "Pedidos", status: "draft" },
  { id: "w3", name: "Pagos", status: "ready" },
  { id: "w4", name: "Viejo", status: "archived" },
] as WorkflowView[];
const suite = { id: "s1", name: "Antes de publicar", workflowIds: ["w1", "w2", "gone"] } as SuiteView;

function draw(patch: Partial<Parameters<typeof SuitesPanel>[0]> = {}) {
  const mocks = {
    suites: [suite],
    workflows,
    canEdit: true,
    running: false,
    onCreate: vi.fn(),
    onChange: vi.fn(),
    onDelete: vi.fn(),
    onArchive: vi.fn(),
    onRun: vi.fn(),
  };
  const props = { ...mocks, ...patch } as typeof mocks;
  render(<SuitesPanel {...props} />);
  return props;
}

const open = () => fireEvent.click(screen.getByText("Antes de publicar"));
const rows = () => screen.getAllByRole("listitem");

describe("SuitesPanel", () => {
  test("sin suites lo explica, y «+ Nueva» pide un nombre y la crea", () => {
    const { onCreate } = draw({ suites: [] });
    expect(screen.getByText(/Ninguna\. Una suite/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "+ Nueva" }));
    const dialog = screen.getByRole("dialog", { name: "Nueva suite" });
    fireEvent.change(within(dialog).getByPlaceholderText("Antes de publicar"), { target: { value: "Nocturna" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Crear" }));
    expect(onCreate).toHaveBeenCalledWith("Nocturna");
    expect(screen.queryByRole("dialog")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "+ Nueva" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancelar" }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  test("abierta enseña los flujos en orden, y un flujo borrado se dice", () => {
    draw();
    expect(screen.getByText("3 flujos")).toBeTruthy();
    expect(screen.queryByRole("list")).toBeNull();
    open();
    expect(rows().map((row) => row.textContent)).toEqual([
      expect.stringContaining("Login"),
      expect.stringContaining("Pedidos"),
      expect.stringContaining("flujo eliminado"),
    ]);
    open();
    expect(screen.queryByRole("list")).toBeNull();
  });

  test("las flechas mueven un flujo y no salen de la lista; la × lo quita", () => {
    const { onChange } = draw();
    open();
    fireEvent.click(within(rows()[0]!).getByRole("button", { name: "↑" }));
    fireEvent.click(within(rows()[2]!).getByRole("button", { name: "↓" }));
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.click(within(rows()[0]!).getByRole("button", { name: "↓" }));
    expect(onChange).toHaveBeenLastCalledWith({ ...suite, workflowIds: ["w2", "w1", "gone"] });
    fireEvent.click(within(rows()[2]!).getByRole("button", { name: "↑" }));
    expect(onChange).toHaveBeenLastCalledWith({ ...suite, workflowIds: ["w1", "gone", "w2"] });
    fireEvent.click(within(rows()[2]!).getByRole("button", { name: "×" }));
    expect(onChange).toHaveBeenLastCalledWith({ ...suite, workflowIds: ["w1", "w2"] });
  });

  test("arrastrar un flujo sobre otro lo deja en su sitio, y soltarlo en el mismo no escribe", () => {
    const { onChange } = draw();
    open();
    fireEvent.dragStart(rows()[2]!);
    expect(rows()[2]!.className).toContain("opacity-40");
    fireEvent.dragOver(rows()[0]!);
    expect(rows()[0]!.className).toContain("ring-1");
    fireEvent.drop(rows()[0]!);
    expect(onChange).toHaveBeenLastCalledWith({ ...suite, workflowIds: ["gone", "w1", "w2"] });

    onChange.mockClear();
    fireEvent.dragStart(rows()[1]!);
    fireEvent.drop(rows()[1]!);
    fireEvent.dragEnd(rows()[1]!);
    expect(onChange).not.toHaveBeenCalled();
    // Sin arrastre en curso, pasar por encima o soltar no hace nada.
    fireEvent.dragOver(rows()[0]!);
    fireEvent.drop(rows()[0]!);
    expect(onChange).not.toHaveBeenCalled();
  });

  test("el selector ofrece solo lo que falta y no está archivado, y lo añade al final", () => {
    const { onChange } = draw();
    open();
    const select = screen.getByRole("combobox") as HTMLSelectElement;
    expect([...select.options].map((option) => option.text)).toEqual(["Añadir flujo…", "Pagos"]);
    fireEvent.change(select, { target: { value: "" } });
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.change(select, { target: { value: "w3" } });
    expect(onChange).toHaveBeenCalledWith({ ...suite, workflowIds: ["w1", "w2", "gone", "w3"] });
  });

  test("ejecuta y elimina; no se ejecuta mientras corre ni vacía", () => {
    const { onRun, onDelete, onArchive } = draw({
      suites: [suite, { id: "s2", name: "Vacía", workflowIds: [] } as unknown as SuiteView],
    });
    open();
    fireEvent.click(screen.getByRole("button", { name: "Ejecutar" }));
    expect(onRun).toHaveBeenCalledWith("s1");
    // Eliminar pregunta antes, con archivar como la otra salida.
    fireEvent.click(screen.getByRole("button", { name: "Eliminar" }));
    expect(screen.getByText(/«Antes de publicar» sale de la lista/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Archivar" }));
    expect(onArchive).toHaveBeenCalledWith("s1");

    // Cancelar cierra sin borrar.
    fireEvent.click(screen.getByRole("button", { name: "Eliminar" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancelar" }));
    expect(onDelete).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Eliminar" }));
    fireEvent.click(screen.getAllByRole("button", { name: "Eliminar" })[1]);
    expect(onDelete).toHaveBeenCalledWith("s1");

    fireEvent.click(screen.getByText("Vacía"));
    expect((screen.getByRole("button", { name: "Ejecutar" }) as HTMLButtonElement).disabled).toBe(true);
  });

  test("corriendo no se puede ejecutar; quien solo lee no reordena ni añade ni borra", () => {
    const { onRun } = draw({ canEdit: false, running: true });
    expect(screen.queryByRole("button", { name: "+ Nueva" })).toBeNull();
    open();
    expect(rows()[0]!.getAttribute("draggable")).toBe("false");
    expect(screen.queryByRole("button", { name: "↑" })).toBeNull();
    expect(screen.queryByRole("combobox")).toBeNull();
    expect(screen.queryByRole("button", { name: "Eliminar" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Ejecutar" }));
    expect(onRun).not.toHaveBeenCalled();
  });
});
