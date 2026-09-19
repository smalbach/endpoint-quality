/**
 * Un objeto JSON editado como texto: se interpreta al salir del campo, no mientras se escribe; un
 * texto que no es JSON enseña el error y no llama a onChange; al corregirlo el error se va; y un
 * valor nuevo desde fuera reescribe el texto.
 */
import { expect, test, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

import { JsonObjectField } from "@/components/json-object-field";

test("interpreta al salir, avisa del JSON roto y se rehace con el valor de fuera", () => {
  const onChange = vi.fn();
  const { rerender } = render(<JsonObjectField label="Cuerpo" value={{ a: 1 }} onChange={onChange} />);
  const area = screen.getByRole("textbox") as HTMLTextAreaElement;
  expect(area.value).toBe('{\n  "a": 1\n}');
  expect(screen.getByText("Cuerpo JSON")).toBeTruthy();

  fireEvent.change(area, { target: { value: '{"a": ' } });
  expect(onChange).not.toHaveBeenCalled();
  fireEvent.blur(area);
  expect(onChange).not.toHaveBeenCalled();
  expect(document.querySelector(".text-rose-600")).toBeTruthy();

  fireEvent.change(area, { target: { value: '{"b": 2}' } });
  fireEvent.blur(area);
  expect(onChange).toHaveBeenCalledWith({ b: 2 });
  expect(document.querySelector(".text-rose-600")).toBeNull();

  rerender(<JsonObjectField label="Cuerpo" value={{ c: true }} onChange={onChange} />);
  expect(area.value).toBe('{\n  "c": true\n}');
});
