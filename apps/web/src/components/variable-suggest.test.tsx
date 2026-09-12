import { useState } from "react";
import { describe, expect, test } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";

import { VariableSuggest } from "@/components/variable-suggest";

const VARIABLES = ["email", "pedidoId", "tenant"];

/**
 * Un campo de verdad detrás del render prop, con su cursor.
 *
 * Todo lo decidible sin DOM ya está probado en `lib/variable-suggestions.ts`. Lo que queda aquí es
 * justo lo que necesita un campo montado: dónde está el cursor cuando se escribe, qué teclas se le
 * quitan al formulario mientras la lista está abierta, y que el cursor acabe dentro del texto y no
 * al final de él.
 */
function mount(initial = "") {
  function Harness() {
    const [value, setValue] = useState(initial);
    return (
      <VariableSuggest variables={VARIABLES} value={value} onChange={setValue}>
        {(suggest) => <input {...suggest} aria-label="Valor" />}
      </VariableSuggest>
    );
  }

  render(<Harness />);
  const field = screen.getByLabelText<HTMLInputElement>("Valor");

  /**
   * Escribir, que aquí son dos cosas: el texto y dónde queda el cursor.
   *
   * El componente lee `selectionStart` del elemento y no del evento, porque después de pegar o de
   * mover con una flecha es lo único que sabe dónde acabó el cursor de verdad. Un `fireEvent` no
   * lo mueve, así que la prueba tiene que colocarlo como lo dejaría el navegador.
   */
  const type = async (text: string, caret = text.length) => {
    fireEvent.change(field, { target: { value: text } });
    field.setSelectionRange(caret, caret);
    // El seguimiento del cursor va en el siguiente fotograma, a propósito: en el momento del
    // `onChange` el campo todavía tiene el texto viejo. Se espera ese fotograma y no a que
    // aparezca la lista, porque «no aparece» es la mitad de lo que hay que comprobar.
    await act(async () => {
      await new Promise((resolve) => requestAnimationFrame(resolve));
    });
  };

  return { field, type, options: () => screen.queryAllByRole("button").map((entry) => entry.textContent) };
}

/**
 * Cuándo aparece la lista, que es lo que hizo inusable la primera versión.
 *
 * No filtra como un combobox: solo sale mientras hay un `{{` abierto. En un campo donde casi todo
 * lo que se teclea es una ruta, una lista permanente tapa el campo de debajo en cada letra.
 */
describe("cuándo se ofrecen los nombres", () => {
  test("escribir texto normal no abre nada", async () => {
    const suggest = mount();
    await suggest.type("/pedidos/7");
    expect(suggest.options()).toEqual([]);
  });

  test("un `{{` abierto los ofrece todos", async () => {
    const suggest = mount();
    await suggest.type("/pedidos/{{");
    expect(suggest.options()).toEqual(VARIABLES);
  });

  test("lo tecleado después estrecha la lista", async () => {
    const suggest = mount();
    await suggest.type("{{ped");
    expect(suggest.options()).toEqual(["pedidoId"]);
  });

  test("un token ya cerrado no está abierto: nadie lo está escribiendo", async () => {
    const suggest = mount();
    await suggest.type("{{email}}/detalle");
    expect(suggest.options()).toEqual([]);
  });

  test("sin variables no sale una lista vacía: no sale nada", async () => {
    function Harness() {
      return (
        <VariableSuggest variables={[]} value="{{" onChange={() => {}}>
          {(props) => <input {...props} aria-label="Valor" />}
        </VariableSuggest>
      );
    }
    render(<Harness />);
    fireEvent.keyDown(screen.getByLabelText("Valor"), { key: "ArrowLeft" });
    expect(screen.queryAllByRole("button")).toEqual([]);
  });
});

/**
 * Aceptar un nombre, y las teclas que eso le quita al formulario.
 *
 * Enter en un campo de una línea envía, y Tab se va al siguiente. Mientras la lista está arriba
 * los dos significan «esta», que es lo que significan en cualquier editor.
 */
describe("elegir un nombre", () => {
  test("Enter escribe el nombre con sus llaves y deja el cursor detrás", async () => {
    const suggest = mount();
    await suggest.type("/pedidos/{{ped");
    fireEvent.keyDown(suggest.field, { key: "Enter" });
    expect(suggest.field.value).toBe("/pedidos/{{pedidoId}}");
    expect(suggest.field.selectionStart).toBe("/pedidos/{{pedidoId}}".length);
  });

  test("las flechas recorren la lista y no mueven el cursor", async () => {
    const suggest = mount();
    await suggest.type("{{");
    fireEvent.keyDown(suggest.field, { key: "ArrowDown" });
    fireEvent.keyDown(suggest.field, { key: "Enter" });
    expect(suggest.field.value).toBe("{{pedidoId}}");
  });

  test("arriba desde la primera da la vuelta a la última", async () => {
    const suggest = mount();
    await suggest.type("{{");
    fireEvent.keyDown(suggest.field, { key: "ArrowUp" });
    fireEvent.keyDown(suggest.field, { key: "Enter" });
    expect(suggest.field.value).toBe("{{tenant}}");
  });

  test("pulsar sobre un nombre lo escribe: el ratón cuenta como el teclado", async () => {
    // `onMouseDown` y no `onClick`, porque el clic llegaría después del `blur` que cierra la
    // lista, y para entonces ya no queda nada donde pulsar.
    const suggest = mount();
    await suggest.type("{{");
    fireEvent.mouseDown(screen.getByText("tenant"));
    expect(suggest.field.value).toBe("{{tenant}}");
  });

  test("Escape cierra la lista y deja el texto como estaba", async () => {
    const suggest = mount();
    await suggest.type("{{ped");
    fireEvent.keyDown(suggest.field, { key: "Escape" });
    expect(suggest.options()).toEqual([]);
    expect(suggest.field.value).toBe("{{ped");
  });

  test("un nombre elegido dentro de un token ya cerrado no duplica las llaves", async () => {
    // Corregir el medio de `{{pedidold}}` es el caso: sin esto queda `{{pedidoId}}}}`, que no
    // interpola nada y parece un error de quien lo escribió.
    const suggest = mount();
    await suggest.type("{{ped}}/detalle", "{{ped".length);
    fireEvent.keyDown(suggest.field, { key: "Enter" });
    expect(suggest.field.value).toBe("{{pedidoId}}/detalle");
  });
});
