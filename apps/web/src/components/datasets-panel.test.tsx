/**
 * El panel de conjuntos de datos del flujo: sin conjuntos explica para qué sirven; se crea uno con
 * nombre; se elige con cuál recorrer; abrir uno pide sus filas (la lista no las trae) y las enseña
 * como JSON; guardar manda las filas pegadas en CSV o JSON y cierra, y unas filas mal escritas se
 * quedan con su error sin mandar nada. Un fallo al cargar se ve. Quien solo lee no edita ni borra.
 */
import { describe, expect, test, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";

import { DatasetsPanel } from "@/components/datasets-panel";
import type { DatasetView } from "@/lib/types";

const datasets = [
  { id: "d1", name: "Clientes", rowCount: 2, columns: ["nombre", "email"] },
  { id: "d2", name: "Productos", rowCount: 0, columns: [] },
] as unknown as DatasetView[];

function draw(patch: Partial<Parameters<typeof DatasetsPanel>[0]> = {}) {
  const props = {
    datasets,
    selectedId: "",
    canEdit: true,
    onSelect: vi.fn(),
    onCreate: vi.fn(),
    onSave: vi.fn(),
    onDelete: vi.fn(),
    loadRows: vi.fn(async (_id: string) => [{ nombre: "Ana", email: "ana@x.com" }]),
    ...patch,
  };
  render(<DatasetsPanel {...props} />);
  return props;
}

const rowsBox = () => screen.getByPlaceholderText(/nombre;precio/) as HTMLTextAreaElement;

describe("DatasetsPanel", () => {
  test("sin conjuntos explica para qué sirven, y «+ Conjunto» crea uno con nombre", () => {
    const { onCreate } = draw({ datasets: [] });
    expect(screen.getByText(/recorre el flujo una vez por fila/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "+ Conjunto" }));
    const dialog = screen.getByRole("dialog", { name: "Nuevo conjunto de datos" });
    fireEvent.change(within(dialog).getByPlaceholderText("clientes de prueba"), { target: { value: "Clientes" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Crear" }));
    expect(onCreate).toHaveBeenCalledWith("Clientes");
    expect(screen.queryByRole("dialog")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "+ Conjunto" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancelar" }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  test("se elige con qué recorrer, y cada conjunto dice sus filas y columnas", () => {
    const { onSelect, onDelete } = draw({ selectedId: "d1" });
    const select = screen.getByLabelText("Recorrer con") as HTMLSelectElement;
    expect(select.value).toBe("d1");
    expect([...select.options].map((option) => option.text)).toEqual([
      "Una vez, sin datos",
      "Clientes · 2 filas",
      "Productos · 0 filas",
    ]);
    fireEvent.change(select, { target: { value: "" } });
    expect(onSelect).toHaveBeenCalledWith("");
    expect(screen.getByText("nombre, email")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Eliminar Productos" }));
    expect(onDelete).toHaveBeenCalledWith("d2");
  });

  test("abrir uno carga sus filas; guardar CSV manda las filas y cierra el editor", async () => {
    const { loadRows, onSave } = draw();
    fireEvent.click(screen.getAllByRole("button", { name: "editar" })[0]!);
    expect(loadRows).toHaveBeenCalledWith("d1");
    await waitFor(() => expect(rowsBox().value).toBe('[\n  {\n    "nombre": "Ana",\n    "email": "ana@x.com"\n  }\n]'));
    expect(screen.getByRole("button", { name: "cerrar" })).toBeTruthy();

    fireEvent.change(rowsBox(), { target: { value: 'nombre;precio\nprimera;9,90\n"se;gunda";1' } });
    fireEvent.click(screen.getByRole("button", { name: "Guardar filas" }));
    expect(onSave).toHaveBeenCalledWith("d1", [
      { nombre: "primera", precio: "9,90" },
      { nombre: "se;gunda", precio: "1" },
    ]);
    expect(screen.queryByRole("button", { name: "Guardar filas" })).toBeNull();
  });

  test("unas filas mal escritas enseñan su error y no se mandan", async () => {
    const { onSave } = draw();
    fireEvent.click(screen.getAllByRole("button", { name: "editar" })[0]!);
    await waitFor(() => expect(rowsBox().value).not.toBe(""));
    fireEvent.change(rowsBox(), { target: { value: "nombre,precio total\nuno,2" } });
    fireEvent.click(screen.getByRole("button", { name: "Guardar filas" }));
    expect(screen.getByText("Línea 1: «precio total» no es un nombre válido")).toBeTruthy();

    fireEvent.change(rowsBox(), { target: { value: '[{"n": 1}]' } });
    fireEvent.click(screen.getByRole("button", { name: "Guardar filas" }));
    expect(screen.getByText("Fila 1: «n» no es texto")).toBeTruthy();
    expect(onSave).not.toHaveBeenCalled();

    fireEvent.change(rowsBox(), { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "Guardar filas" }));
    expect(onSave).toHaveBeenCalledWith("d1", []);
  });

  test("un fallo al cargar las filas se ve, y «cerrar» cierra el editor", async () => {
    draw({ loadRows: vi.fn(() => Promise.reject(new Error("No se pudieron leer las filas"))) });
    fireEvent.click(screen.getAllByRole("button", { name: "editar" })[1]!);
    expect(await screen.findByText("No se pudieron leer las filas")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "cerrar" }));
    expect(screen.queryByPlaceholderText(/nombre;precio/)).toBeNull();
  });

  test("quien solo lee elige con qué recorrer pero no crea, edita ni borra", () => {
    draw({ canEdit: false });
    expect(screen.getByLabelText("Recorrer con")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "+ Conjunto" })).toBeNull();
    expect(screen.queryByRole("button", { name: "editar" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Eliminar Clientes" })).toBeNull();
  });
});
