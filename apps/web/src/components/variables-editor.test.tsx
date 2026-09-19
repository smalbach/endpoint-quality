/**
 * La tabla de variables de un entorno, la de Postman.
 *
 * Lo que se comprueba: que la fila fantasma del final crea una variable al teclear (desde la primera
 * letra), que el interruptor, la casilla de secreta, restaurar y eliminar escriben lo que dicen, que
 * la vista de texto va y vuelve sin perder el valor inicial ni el secreto y que un texto mal escrito
 * se queda en pantalla con su error, y que «Ver secretos» enseña el valor **sin** escribirlo en el
 * borrador —mirar no es editar—.
 */
import { useState } from "react";
import { describe, expect, test, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";

import { VariablesEditor } from "@/components/variables-editor";
import { MASKED_VALUE, type VariableRow } from "@/lib/env-variables";

const row = (patch: Partial<VariableRow> = {}): VariableRow => ({
  name: "userId",
  initial: "42",
  current: "42",
  sensitive: false,
  enabled: true,
  ...patch,
});

function mount(
  initial: VariableRow[],
  options: {
    problems?: { index: number; detail: string }[];
    disabled?: boolean;
    onReveal?: () => Promise<Record<string, string>>;
  } = {},
) {
  const onChange = vi.fn();
  let latest = initial;
  function Harness() {
    const [rows, setRows] = useState(initial);
    return (
      <VariablesEditor
        rows={rows}
        problems={options.problems ?? []}
        disabled={options.disabled ?? false}
        onReveal={options.onReveal}
        onChange={(next) => {
          latest = next;
          onChange(next);
          setRows(next);
        }}
      />
    );
  }
  render(<Harness />);
  return { onChange, saved: () => latest };
}

const names = () => screen.getAllByLabelText<HTMLInputElement>("Nombre de variable").map((input) => input.value);

describe("la tabla de variables", () => {
  test("cuenta activas, apagadas y secretas, y siempre deja una fila en blanco al final", () => {
    mount([
      row(),
      row({ name: "old", enabled: false }),
      row({ name: "token", sensitive: true, initial: MASKED_VALUE, current: MASKED_VALUE }),
    ]);
    expect(screen.getByText("2 activas · 1 apagadas · 1 secretas")).toBeDefined();
    expect(names()).toEqual(["userId", "old", "token", ""]);
    expect(screen.getByPlaceholderText("nueva variable")).toBeDefined();
    // La explicación de la máscara solo sale cuando hay secretos.
    expect(screen.getByText(/se guarda cifrada/)).toBeDefined();
  });

  test("teclear en la fila en blanco crea la variable desde la primera letra y aparece otra en blanco", () => {
    const editor = mount([]);
    expect(screen.queryByText(/se guarda cifrada/)).toBeNull();
    fireEvent.change(screen.getByPlaceholderText("nueva variable"), { target: { value: "t" } });
    expect(editor.saved()[0].name).toBe("t");
    expect(names()).toEqual(["t", ""]);
  });

  test("editar valor inicial y actual; el actual distinto se marca y se restaura con un clic", () => {
    const editor = mount([row()]);
    fireEvent.change(screen.getAllByLabelText("Valor inicial")[0], { target: { value: "1" } });
    expect(editor.saved()[0].initial).toBe("1");
    fireEvent.change(screen.getAllByLabelText("Valor actual")[0], { target: { value: "99" } });
    expect(editor.saved()[0].current).toBe("99");

    fireEvent.click(screen.getByLabelText("Restaurar userId al valor inicial"));
    expect(editor.saved()[0].current).toBe("1");
    expect(screen.queryByLabelText("Restaurar userId al valor inicial")).toBeNull();
  });

  test("apagar, marcar como secreta y eliminar", () => {
    const editor = mount([row(), row({ name: "b" })]);
    fireEvent.click(screen.getByLabelText("Aplicar userId"));
    expect(editor.saved()[0].enabled).toBe(false);
    fireEvent.click(screen.getByLabelText("Guardar userId cifrada"));
    expect(editor.saved()[0].sensitive).toBe(true);

    fireEvent.click(screen.getByLabelText("Eliminar userId"));
    expect(editor.saved().map((entry) => entry.name)).toEqual(["b", ""]);
  });

  test("el problema de una fila se dice debajo de ella", () => {
    mount([row(), row()], { problems: [{ index: 1, detail: "Ya hay una variable con ese nombre" }] });
    expect(screen.getByText("Ya hay una variable con ese nombre")).toBeDefined();
  });

  test("bloqueada, la fila no se edita", () => {
    mount([row()], { disabled: true });
    expect(screen.getAllByLabelText<HTMLInputElement>("Nombre de variable")[0].disabled).toBe(true);
    expect(screen.getByLabelText<HTMLButtonElement>("Eliminar userId").disabled).toBe(true);
  });

  test("copiar pone {{nombre}} en el portapapeles y lo dice un momento", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    mount([row()]);
    fireEvent.click(screen.getByTitle("Copiar {{userId}}"));
    await waitFor(() => expect(screen.getByText("copiado")).toBeDefined());
    expect(writeText).toHaveBeenCalledWith("{{userId}}");
  });

  test("si el portapapeles se niega no pasa nada visible", async () => {
    Object.assign(navigator, { clipboard: { writeText: vi.fn().mockRejectedValue(new Error("no")) } });
    mount([row()]);
    await act(async () => {
      fireEvent.click(screen.getByTitle("Copiar {{userId}}"));
    });
    expect(screen.queryByText("copiado")).toBeNull();
  });
});

describe("la vista de texto", () => {
  test("enseña nombre:valor con las apagadas comentadas, y al volver conserva inicial y secreto", () => {
    const editor = mount([
      row({ initial: "1", current: "2", sensitive: true }),
      row({ name: "off", current: "x", enabled: false }),
    ]);
    fireEvent.click(screen.getByRole("button", { name: "Editar como texto" }));
    const text = screen.getByPlaceholderText(/userId:42/) as HTMLTextAreaElement;
    expect(text.value).toBe("userId:2\n//off:x");

    fireEvent.change(text, { target: { value: "userId:3\nnuevo=https://a.b:8080" } });
    fireEvent.click(screen.getByRole("button", { name: "Tabla" }));
    expect(editor.saved()).toEqual([
      { name: "userId", initial: "1", current: "3", sensitive: true, enabled: true },
      { name: "nuevo", initial: "https://a.b:8080", current: "https://a.b:8080", sensitive: false, enabled: true },
      { name: "", initial: "", current: "", sensitive: false, enabled: true },
    ]);
  });

  test("un texto mal escrito se queda en pantalla con su error y no toca las filas", () => {
    const editor = mount([row()]);
    fireEvent.click(screen.getByRole("button", { name: "Editar como texto" }));
    fireEvent.change(screen.getByPlaceholderText(/userId:42/), { target: { value: "sin separador" } });
    fireEvent.click(screen.getByRole("button", { name: "Tabla" }));
    expect(screen.getByText("Línea 1: falta «nombre:valor»")).toBeDefined();
    expect(screen.getByRole("button", { name: "Tabla" })).toBeDefined();
    expect(editor.onChange).not.toHaveBeenCalled();
  });
});

describe("ver los secretos", () => {
  const secret = () => row({ name: "token", initial: MASKED_VALUE, current: MASKED_VALUE, sensitive: true });

  test("sin permiso para leerlos no hay botón", () => {
    mount([secret()]);
    expect(screen.queryByRole("button", { name: "Ver secretos" })).toBeNull();
  });

  test("enseña el valor actual sin escribirlo en el borrador; teclear en él lo deja de enseñar", async () => {
    let resolve!: (value: Record<string, string>) => void;
    const onReveal = vi.fn(() => new Promise<Record<string, string>>((done) => (resolve = done)));
    const editor = mount([secret()], { onReveal });
    fireEvent.click(screen.getByRole("button", { name: "Ver secretos" }));
    expect(screen.getByRole("button", { name: "Leyendo…" })).toBeDefined();
    await act(async () => resolve({ token: "s3cr3t" }));

    expect(screen.getByDisplayValue("s3cr3t")).toBeDefined();
    // Mirar no es editar: el borrador sigue con la máscara.
    expect(editor.onChange).not.toHaveBeenCalled();
    // El inicial sigue tapado.
    expect(screen.getAllByLabelText<HTMLInputElement>("Valor inicial")[0].value).toBe(MASKED_VALUE);

    fireEvent.change(screen.getByDisplayValue("s3cr3t"), { target: { value: "nuevo" } });
    expect(editor.saved()[0].current).toBe("nuevo");
    expect(screen.getByDisplayValue("nuevo")).toBeDefined();
  });

  test("si la API se niega, se dice por qué", async () => {
    mount([secret()], { onReveal: () => Promise.reject(new Error("Solo admin")) });
    fireEvent.click(screen.getByRole("button", { name: "Ver secretos" }));
    expect(await screen.findByText("Solo admin")).toBeDefined();
  });

  test("un fallo que no es un Error se dice con un mensaje genérico", async () => {
    mount([secret()], { onReveal: () => Promise.reject("x") });
    fireEvent.click(screen.getByRole("button", { name: "Ver secretos" }));
    expect(await screen.findByText("No se pudieron leer los secretos")).toBeDefined();
  });
});
