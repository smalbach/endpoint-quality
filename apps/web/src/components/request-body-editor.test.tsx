import { useState } from "react";
import { describe, expect, test } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

import { emptyOf, RequestBodyEditor } from "@/components/request-body-editor";
import type { RequestBodyView } from "@/lib/types";

/**
 * El panel con su estado, porque lo que se prueba aquí es la memoria entre dos renderizados.
 *
 * El selector de tipo no es un campo más: cambia qué variante de la unión está viva, y la que se
 * deja atrás vive en una `ref` que solo existe mientras el panel está abierto. Sin montarlo de
 * verdad no hay nada que comprobar.
 */
function mount(initial: RequestBodyView = { type: "none" }) {
  function Harness() {
    const [body, setBody] = useState(initial);
    return <RequestBodyEditor body={body} canEdit onChange={setBody} variables={["email"]} />;
  }

  render(<Harness />);
  const selector = () => screen.getByLabelText("Tipo de cuerpo");
  return {
    selector,
    switchTo: (type: RequestBodyView["type"]) => fireEvent.change(selector(), { target: { value: type } }),
  };
}

/**
 * Cambiar de tipo sin perder lo escrito.
 *
 * Es la razón de que haya una `ref` y no un `useState` por variante. Alguien que compara «lo mismo
 * como JSON y como formulario» va y vuelve varias veces, y un selector que vaciara el campo en
 * cada salto convertiría esa comparación en un retecleo.
 */
describe("el selector de tipo de cuerpo", () => {
  test("volver a un tipo devuelve lo que tenía, no un campo vacío", () => {
    const panel = mount({ type: "raw", text: "<pedido/>", contentType: "application/xml" });
    panel.switchTo("json");
    panel.switchTo("raw");
    expect(screen.getByLabelText<HTMLTextAreaElement>("Cuerpo en texto").value).toBe("<pedido/>");
    expect(screen.getByLabelText<HTMLInputElement>("Content-Type").value).toBe("application/xml");
  });

  test("un tipo al que no se había ido todavía empieza vacío y completo", () => {
    // Vacío pero **entero**: la variante parcial es justo el estado que la unión existe para
    // prohibir, y un `raw` sin `contentType` llegaría al serializador sin cabecera que poner.
    const panel = mount();
    panel.switchTo("raw");
    expect(screen.getByLabelText<HTMLInputElement>("Content-Type").value).toBe("application/json");
    expect(screen.getByLabelText<HTMLTextAreaElement>("Cuerpo en texto").value).toBe("");
  });

  test("«sin cuerpo» explica que no es lo mismo que un JSON vacío", () => {
    mount();
    expect(screen.getByText(/No es lo mismo que un JSON vacío/)).toBeDefined();
    expect(screen.queryByLabelText("Cuerpo en texto")).toBeNull();
  });
});

/**
 * Los dos tipos de formulario, que comparten tabla y no destino.
 *
 * La misma tabla de filas con interruptor que los parámetros, así que lo que hay que comprobar no
 * es la tabla —ya tiene sus pruebas— sino que lo que sale de ella se guarda partido en los dos
 * mapas que la fila de la base de datos espera.
 */
describe("un cuerpo de formulario", () => {
  test("lo escrito se guarda en `fields`, y lo apagado aparte", () => {
    mount({ type: "form-data", fields: { nombre: "Ana" }, disabledFields: {} });
    fireEvent.click(screen.getByLabelText("Enviar nombre"));
    expect(screen.getByText("1 apagado")).toBeDefined();
  });

  test("cada uno avisa de lo suyo: multipart no sube ficheros, urlencoded se codifica al enviar", () => {
    const panel = mount({ type: "form-data", fields: {}, disabledFields: {} });
    expect(screen.getByText(/Solo texto/)).toBeDefined();
    panel.switchTo("x-www-form-urlencoded");
    expect(screen.getByText(/después de sustituir las variables/)).toBeDefined();
  });
});

/**
 * El cuerpo vacío de cada tipo, escrito a mano.
 *
 * Se ensambla una variante entera o ninguna. Es la misma regla que hace que el selector no pueda
 * dejar un `form-data` sin `disabledFields`: media variante pasa el compilador de quien la
 * construye y falla en el serializador, que ya no sabe de dónde vino.
 */
describe("escribir el cuerpo", () => {
  function spy(initial: RequestBodyView) {
    const seen: RequestBodyView[] = [];
    function Harness() {
      const [body, setBody] = useState(initial);
      return (
        <RequestBodyEditor
          body={body}
          canEdit
          onChange={(next) => {
            seen.push(next);
            setBody(next);
          }}
        />
      );
    }
    render(<Harness />);
    return seen;
  }

  test("un JSON se guarda al salir del campo, ya como objeto", () => {
    const seen = spy({ type: "json", json: {} });
    const box = screen.getByLabelText("Body JSON");
    fireEvent.change(box, { target: { value: '{"email":"{{email}}"}' } });
    fireEvent.blur(box);
    expect(seen.at(-1)).toEqual({ type: "json", json: { email: "{{email}}" } });
  });

  test("en texto se escriben el Content-Type y el cuerpo", () => {
    const seen = spy({ type: "raw", text: "", contentType: "application/json" });
    fireEvent.change(screen.getByLabelText("Content-Type"), { target: { value: "application/xml" } });
    fireEvent.change(screen.getByLabelText("Cuerpo en texto"), { target: { value: "<a/>" } });
    expect(seen.at(-1)).toEqual({ type: "raw", text: "<a/>", contentType: "application/xml" });
  });
});

describe("el cuerpo vacío de un tipo", () => {
  test("cada tipo trae todos sus campos", () => {
    expect(emptyOf("none")).toEqual({ type: "none" });
    expect(emptyOf("json")).toEqual({ type: "json", json: {} });
    expect(emptyOf("raw")).toEqual({ type: "raw", text: "", contentType: "application/json" });
    expect(emptyOf("form-data")).toEqual({ type: "form-data", fields: {}, disabledFields: {} });
    expect(emptyOf("x-www-form-urlencoded")).toEqual({
      type: "x-www-form-urlencoded",
      fields: {},
      disabledFields: {},
    });
  });
});
