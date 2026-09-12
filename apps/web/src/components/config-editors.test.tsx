import { useState } from "react";
import { describe, expect, test } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

import { SECTION_EDITORS } from "@/components/config-editors";

type Draft = Record<string, unknown>;

const OPERATIONS = ["listWidgets", "getWidget", "createWidget"];

/**
 * La sección montada por su nombre, como la monta la pantalla.
 *
 * Ninguno de estos editores se exporta suelto: se llega a ellos por el registro, que es también
 * quien decide qué secciones tienen formulario y cuáles se quedan en su textarea. Montarlos así
 * comprueba de paso ese cableado, que es lo que se olvida al añadir una sección nueva.
 */
function mount(section: string, initial: Draft) {
  const Editor = SECTION_EDITORS[section]!;
  let latest = initial;

  function Harness() {
    const [value, setValue] = useState(initial);
    return (
      <Editor
        value={value}
        operationIds={OPERATIONS}
        disabled={false}
        onChange={(next) => {
          latest = next;
          setValue(next);
        }}
      />
    );
  }

  render(<Harness />);
  return { saved: () => latest };
}

/**
 * La rejilla de permisos, que es la sección que menos aguanta un textarea.
 *
 * Roles por operaciones y tres estados por celda: escrito a mano es contar corchetes, y cada
 * corchete mal puesto es un caso de permisos que no se genera sin que nadie lo note.
 */
describe("quién puede llegar a qué", () => {
  test("sin roles no se dibuja la matriz: no hay columnas que poner", () => {
    mount("access", {});
    expect(screen.getByText("Escribe los roles para dibujar la matriz.")).toBeDefined();
    expect(screen.queryByLabelText("listWidgets para vendedor")).toBeNull();
  });

  test("los roles se escriben en una línea y salen como columnas, sin los espacios", () => {
    const editor = mount("access", {});
    fireEvent.change(screen.getByPlaceholderText("vendedor, comprador, admin"), {
      target: { value: " vendedor , comprador " },
    });
    expect((editor.saved().access as Draft).roles).toEqual(["vendedor", "comprador"]);
    expect(screen.getByLabelText("createWidget para comprador")).toBeDefined();
  });

  test("marcar una celda escribe la regla de esa operación", () => {
    const editor = mount("access", { access: { roles: ["vendedor"] } });
    fireEvent.change(screen.getByLabelText("getWidget para vendedor"), { target: { value: "allow" } });
    expect((editor.saved().access as Draft).rules).toEqual([
      { operationId: "getWidget", allow: ["vendedor"], deny: [] },
    ]);
  });

  test("volver a «sin decidir» quita la regla entera, no la deja vacía", () => {
    // Una regla que no dice nada la rechaza el esquema al guardar, así que dejarla atrás
    // convertiría un clic que parece deshacer en una sección que ya no se puede guardar.
    const editor = mount("access", {
      access: { roles: ["vendedor"], rules: [{ operationId: "getWidget", allow: ["vendedor"], deny: [] }] },
    });
    fireEvent.change(screen.getByLabelText("getWidget para vendedor"), { target: { value: "" } });
    expect((editor.saved().access as Draft).rules).toEqual([]);
  });

  test("pasar de «no debe pasar» a «debe pasar» no deja el rol en las dos listas", () => {
    // El esquema rechaza un rol que esté en `allow` y en `deny` a la vez, y el clic que lo
    // produciría es el más natural de todos: corregir una celda.
    const editor = mount("access", {
      access: { roles: ["vendedor"], rules: [{ operationId: "getWidget", allow: [], deny: ["vendedor"] }] },
    });
    fireEvent.change(screen.getByLabelText("getWidget para vendedor"), { target: { value: "allow" } });
    expect((editor.saved().access as Draft).rules).toEqual([
      { operationId: "getWidget", allow: ["vendedor"], deny: [] },
    ]);
  });

  test("una celda de otra operación no toca la regla de la primera", () => {
    const editor = mount("access", {
      access: { roles: ["vendedor"], rules: [{ operationId: "getWidget", allow: ["vendedor"], deny: [] }] },
    });
    fireEvent.change(screen.getByLabelText("listWidgets para vendedor"), { target: { value: "deny" } });
    expect((editor.saved().access as Draft).rules).toEqual([
      { operationId: "getWidget", allow: ["vendedor"], deny: [] },
      { operationId: "listWidgets", allow: [], deny: ["vendedor"] },
    ]);
  });

  test("lo que cuenta como rechazo son 403 y 404 mientras nadie diga otra cosa", () => {
    mount("access", { access: { roles: ["vendedor"] } });
    expect(screen.getByDisplayValue("403, 404")).toBeDefined();
  });

  test("lo que no es un número entero no llega a la lista de rechazos", () => {
    const editor = mount("access", { access: { roles: ["vendedor"], deniedStatuses: [403] } });
    fireEvent.change(screen.getByDisplayValue("403"), { target: { value: "403, cuatrocientos, 404" } });
    expect((editor.saved().access as Draft).deniedStatuses).toEqual([403, 404]);
  });
});

/**
 * Las palabras del equipo sobre cada operación.
 *
 * Una línea por operación y nada más listo, porque el trabajo real es sentarse una vez y etiquetar
 * cuarenta: teclear «critico, pagos» y seguir con el teclado gana a elegir de un menú cuarenta
 * veces.
 */
describe("las etiquetas propias", () => {
  test("lo escrito se guarda partido por comas y sin espacios", () => {
    const editor = mount("labels", {});
    fireEvent.change(screen.getByLabelText("Etiquetas de getWidget"), { target: { value: " critico , pagos " } });
    expect(editor.saved().labels).toEqual({ getWidget: ["critico", "pagos"] });
  });

  test("vaciar la línea quita la operación en vez de dejarla con una lista vacía", () => {
    // «Sin etiquetar» es la ausencia de la fila. Guardar la lista vacía haría que la sección
    // creciera con cada operación en la que alguien hubiera pinchado alguna vez.
    const editor = mount("labels", { labels: { getWidget: ["critico"] } });
    fireEvent.change(screen.getByLabelText("Etiquetas de getWidget"), { target: { value: "  " } });
    expect(editor.saved().labels).toEqual({});
  });

  test("las que ya tienen etiqueta suben arriba: son las que alguien decidió", () => {
    mount("labels", { labels: { createWidget: ["pagos"] } });
    const first = screen.getAllByRole("textbox")[1];
    expect(first.getAttribute("aria-label")).toBe("Etiquetas de createWidget");
  });

  test("se dice qué etiquetas hay en uso, sin repetirlas", () => {
    mount("labels", { labels: { getWidget: ["critico"], createWidget: ["pagos", "critico"] } });
    expect(screen.getByText("En uso: critico, pagos")).toBeDefined();
  });

  test("el filtro deja solo las operaciones cuyo id lo contiene", () => {
    mount("labels", {});
    fireEvent.change(screen.getByPlaceholderText("Filtrar"), { target: { value: "widgets" } });
    expect(screen.getByLabelText("Etiquetas de listWidgets")).toBeDefined();
    expect(screen.queryByLabelText("Etiquetas de getWidget")).toBeNull();
  });
});
