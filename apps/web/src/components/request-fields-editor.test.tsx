import { useState } from "react";
import { describe, expect, test, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

import { RequestFieldsEditor } from "@/components/request-fields-editor";
import { fieldProblems, type FieldRow } from "@/lib/request-fields";

const row = (name: string, value: string, enabled = true): FieldRow => ({ name, value, enabled });

/** `toBeDisabled` vive en jest-dom, que este paquete no usa: la propiedad dice lo mismo. */
const locked = (element: HTMLElement) => (element as HTMLInputElement | HTMLButtonElement).disabled;

/**
 * La tabla montada de verdad, con quien la posee guardando sus filas.
 *
 * Las filas son del que llama —la misma división que en la pantalla real—, así que una prueba que
 * pasara `rows` fijas no vería lo único que importa aquí: qué pasa con la fila *siguiente* a una
 * edición. El espía devuelve la última lista emitida, que es lo que se guardaría.
 */
function mount(initial: FieldRow[] = [], options: { disabled?: boolean } = {}) {
  const emitted = vi.fn<(rows: FieldRow[]) => void>();

  function Harness() {
    const [rows, setRows] = useState(initial);
    return (
      <RequestFieldsEditor
        label="Parámetros"
        rows={rows}
        problems={fieldProblems(rows, "parameter")}
        namePlaceholder="estado"
        valuePlaceholder="activo"
        disabled={options.disabled ?? false}
        onChange={(next) => {
          emitted(next);
          setRows(next);
        }}
      />
    );
  }

  render(<Harness />);
  const names = () => screen.getAllByLabelText("Nombre de parámetros");
  return {
    /** Lo último que se emitió, sin la fila fantasma: es lo que acabaría guardado. */
    saved: () => (emitted.mock.calls.at(-1)?.[0] ?? []).filter((entry) => entry.name.trim() || entry.value),
    ghostName: () => names().at(-1)!,
    nameAt: (index: number) => names()[index],
  };
}

/**
 * La fila en blanco del final, que es la que crea un parámetro.
 *
 * Es la que se rompió una vez y en silencio: la edición se aplicaba sobre las filas que tiene el
 * padre, donde el fantasma no existe, así que la primera letra no encontraba fila que tocar y se
 * perdía. Un nombre escrito quedaba guardado desde su segunda letra, sin error y sin aviso.
 */
describe("la fila en blanco del final", () => {
  test("un nombre escrito en ella llega entero, no desde la segunda letra", () => {
    const table = mount();
    fireEvent.change(table.ghostName(), { target: { value: "e" } });
    fireEvent.change(table.nameAt(0), { target: { value: "estado" } });
    expect(table.saved()).toEqual([row("estado", "")]);
  });

  test("escribir en ella deja otra debajo: siempre hay una libre", () => {
    const table = mount([row("estado", "activo")]);
    fireEvent.change(table.ghostName(), { target: { value: "pagina" } });
    expect(screen.getAllByLabelText("Nombre de parámetros")).toHaveLength(3);
  });

  test("todavía no es una fila: no se puede apagar ni borrar", () => {
    mount();
    expect(locked(screen.getByLabelText("Enviar parámetros"))).toBe(true);
    expect(screen.queryByLabelText("Eliminar parámetros")).toBeNull();
  });
});

/**
 * El interruptor, que es la razón de existir de esta tabla.
 *
 * Apagar tiene que conservar el valor. El que alguien apaga es justo el que costó una tarde
 * encontrar, y la alternativa que había antes —borrar la fila— lo tiraba.
 */
describe("apagar una fila", () => {
  test("se queda con su valor: apagar no es borrar", () => {
    const table = mount([row("pagina", "2")]);
    fireEvent.click(screen.getByLabelText("Enviar pagina"));
    expect(table.saved()).toEqual([row("pagina", "2", false)]);
  });

  test("se dice cuántas hay apagadas, en singular cuando es una", () => {
    mount([row("pagina", "2", false)]);
    expect(screen.getByText("1 apagado")).toBeDefined();
  });

  test("y en plural cuando son más", () => {
    mount([row("pagina", "2", false), row("orden", "asc", false)]);
    expect(screen.getByText("2 apagados")).toBeDefined();
  });

  test("borrar se lleva esa fila y deja las demás", () => {
    const table = mount([row("estado", "activo"), row("pagina", "2")]);
    fireEvent.click(screen.getByLabelText("Eliminar estado"));
    expect(table.saved().map((entry) => entry.name)).toEqual(["pagina"]);
  });
});

/**
 * Lo que está mal, dicho donde está.
 *
 * El servidor lo repite —esa es la regla—, pero llegar como un 422 sobre `parameters` después de
 * guardar es demasiado tarde y demasiado lejos del cursor.
 */
describe("lo que está mal en una fila", () => {
  test("el duplicado se dice bajo la fila que sobra", () => {
    mount([row("id", "1"), row("id", "2")]);
    expect(screen.getByText("Ya hay un parámetro con ese nombre")).toBeDefined();
  });

  test("sin permiso para editar, nada de la fila se puede tocar", () => {
    mount([row("estado", "activo")], { disabled: true });
    expect(locked(screen.getAllByLabelText("Nombre de parámetros")[0])).toBe(true);
    expect(locked(screen.getByLabelText("Enviar estado"))).toBe(true);
    expect(locked(screen.getByLabelText("Eliminar estado"))).toBe(true);
  });
});
