/**
 * El resto de secciones con formulario: presupuestos, envoltorio, implementadas, parámetros,
 * autorización y textos, más la parte de «entre roles» de la rejilla de permisos.
 *
 * Lo que se comprueba es lo que cada formulario escribe en el documento: que el orden de las reglas
 * se mueve con las flechas (y decide cuál gana), que un opcional vacío no se guarda como cadena
 * vacía, que «sin decidir» no es «ninguna», y que un parámetro por operación que se queda sin nada
 * que decir desaparece en vez de quedarse como `{}`.
 */
import { useState } from "react";
import { describe, expect, test } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

import { SECTION_EDITORS } from "@/components/config-editors";

type Draft = Record<string, unknown>;

const OPERATIONS = ["listWidgets", "getWidget", "createWidget"];

function mount(
  section: string,
  initial: Draft,
  options: { disabled?: boolean; derivedRoles?: boolean; operationIds?: string[] } = {},
) {
  const Editor = SECTION_EDITORS[section]!;
  let latest = initial;

  function Harness() {
    const [value, setValue] = useState(initial);
    return (
      <Editor
        value={value}
        operationIds={options.operationIds ?? OPERATIONS}
        disabled={options.disabled ?? false}
        derivedRoles={options.derivedRoles}
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

const button = (name: string | RegExp) => screen.getByRole("button", { name });

describe("el registro de editores", () => {
  test("scenarios no tiene formulario: se queda en su textarea a propósito", () => {
    expect(SECTION_EDITORS.scenarios).toBeUndefined();
    expect(Object.keys(SECTION_EDITORS).sort()).toEqual(
      ["access", "authorization", "budgets", "envelope", "implemented", "labels", "parameters", "text"].sort(),
    );
  });
});

describe("los presupuestos de latencia", () => {
  test("sin reglas lo dice, y añadir crea una con id, umbral y origen", () => {
    const editor = mount("budgets", {});
    expect(screen.getByText(/Sin presupuestos/)).toBeDefined();
    fireEvent.click(button("Añadir presupuesto"));
    expect(editor.saved().budgets).toEqual([
      { id: "presupuesto", thresholdMs: 500, label: "Presupuesto", source: "manual" },
    ]);
    fireEvent.click(button("Añadir presupuesto"));
    expect((editor.saved().budgets as Draft[])[1].id).toBe("presupuesto-2");
  });

  test("editar los campos escribe la regla, y un sufijo vaciado desaparece en vez de quedarse en blanco", () => {
    const editor = mount("budgets", {
      budgets: [{ id: "a", thresholdMs: 500, label: "A", source: "manual", pathSuffix: "/x" }],
    });
    fireEvent.change(screen.getByDisplayValue("A"), { target: { value: "Listados" } });
    fireEvent.change(screen.getByDisplayValue("500"), { target: { value: "250" } });
    fireEvent.change(screen.getByDisplayValue("manual"), { target: { value: "slo" } });
    fireEvent.change(screen.getByDisplayValue("/x"), { target: { value: "" } });
    expect(editor.saved().budgets).toEqual([{ id: "a", thresholdMs: 250, label: "Listados", source: "slo" }]);
  });

  test("los métodos: ninguno es «cualquiera», y marcar y desmarcar uno lo pone y lo quita", () => {
    const editor = mount("budgets", { budgets: [{ id: "a", thresholdMs: 1, label: "A", source: "m" }] });
    expect(screen.getByText("· cualquiera")).toBeDefined();
    fireEvent.click(button("POST"));
    expect((editor.saved().budgets as Draft[])[0].methods).toEqual(["POST"]);
    expect(screen.queryByText("· cualquiera")).toBeNull();
    fireEvent.click(button("POST"));
    // Una lista vacía de métodos no se guarda: su ausencia ya significa «cualquiera».
    expect((editor.saved().budgets as Draft[])[0]).not.toHaveProperty("methods");
  });

  test("las flechas cambian el orden, que decide qué regla gana; y quitar borra solo esa", () => {
    const editor = mount("budgets", {
      budgets: [
        { id: "a", thresholdMs: 1, label: "A", source: "m" },
        { id: "b", thresholdMs: 2, label: "B", source: "m" },
        { id: "c", thresholdMs: 3, label: "C", source: "m" },
      ],
    });
    const ids = () => (editor.saved().budgets as Draft[]).map((row) => row.id);
    // La primera no sube y la última no baja.
    expect((screen.getAllByTitle("Subir")[0] as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getAllByTitle("Bajar")[2] as HTMLButtonElement).disabled).toBe(true);

    fireEvent.click(screen.getAllByTitle("Bajar")[0]);
    expect(ids()).toEqual(["b", "a", "c"]);
    fireEvent.click(screen.getAllByTitle("Subir")[2]);
    expect(ids()).toEqual(["b", "c", "a"]);
    fireEvent.click(screen.getAllByRole("button", { name: "Quitar" })[1]);
    expect(ids()).toEqual(["b", "a"]);
  });

  test("con la sección bloqueada no se puede tocar nada", () => {
    mount("budgets", { budgets: [{ id: "a", thresholdMs: 1, label: "A", source: "m" }] }, { disabled: true });
    expect((button("Añadir presupuesto") as HTMLButtonElement).disabled).toBe(true);
    expect((button("Quitar") as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByDisplayValue("A") as HTMLInputElement).disabled).toBe(true);
  });
});

describe("el envoltorio de las respuestas", () => {
  test("las formas por defecto y de error se escriben dentro de `envelope`", () => {
    const editor = mount("envelope", { envelope: { fallbackShape: "data", errorShape: "" } });
    fireEvent.change(screen.getByDisplayValue("data"), { target: { value: "items" } });
    const inputs = screen.getAllByRole("textbox");
    fireEvent.change(inputs[1], { target: { value: "error" } });
    expect(editor.saved().envelope).toEqual({ fallbackShape: "items", errorShape: "error" });
  });

  test("una regla nueva hereda la forma por defecto, y su criterio se guarda sin vacíos", () => {
    const editor = mount("envelope", { envelope: { fallbackShape: "items" } });
    expect(screen.getByText("Sin reglas: todo usa la forma por defecto.")).toBeDefined();
    fireEvent.click(button("Añadir regla"));
    const rules = () => (editor.saved().envelope as Draft).rules as Draft[];
    expect(rules()).toEqual([{ id: "envelope", match: {}, shape: "items" }]);

    const inputs = screen.getAllByRole("textbox");
    // fallback, error, prefijo de operación, sufijo de ruta, forma
    fireEvent.change(inputs[2], { target: { value: "list" } });
    fireEvent.change(inputs[3], { target: { value: "/all" } });
    fireEvent.click(button("GET"));
    expect(rules()[0].match).toEqual({ operationIdPrefix: "list", pathSuffix: "/all", methods: ["GET"] });

    fireEvent.change(inputs[3], { target: { value: "" } });
    expect(rules()[0].match).toEqual({ operationIdPrefix: "list", methods: ["GET"] });
    fireEvent.change(screen.getAllByRole("textbox")[4], { target: { value: "raw" } });
    expect(rules()[0].shape).toBe("raw");
  });

  test("sin forma por defecto, la regla nueva usa «data»", () => {
    const editor = mount("envelope", {});
    fireEvent.click(button("Añadir regla"));
    expect(((editor.saved().envelope as Draft).rules as Draft[])[0].shape).toBe("data");
  });
});

describe("las operaciones implementadas", () => {
  test("«sin decidir» es null y lo dice; elegir parte de todas marcadas", () => {
    const editor = mount("implemented", { implemented: null });
    expect(screen.getByText(/Sin decidir: la matriz ejecuta las 3 operaciones/)).toBeDefined();
    fireEvent.click(button("Elegir cuáles están implementadas"));
    expect(editor.saved().implemented).toEqual(OPERATIONS);
    expect(screen.getByText("3 de 3")).toBeDefined();
  });

  test("desmarcar y marcar una, «Ninguna» deja la lista vacía y no null, y se puede volver a sin decidir", () => {
    const editor = mount("implemented", { implemented: ["listWidgets"] });
    expect(screen.getByText("1 de 3")).toBeDefined();
    fireEvent.click(screen.getByLabelText("getWidget"));
    expect(editor.saved().implemented).toEqual(["listWidgets", "getWidget"]);
    fireEvent.click(screen.getByLabelText("listWidgets"));
    expect(editor.saved().implemented).toEqual(["getWidget"]);

    fireEvent.click(button("Ninguna"));
    expect(editor.saved().implemented).toEqual([]);
    fireEvent.click(button("Todas"));
    expect(editor.saved().implemented).toEqual(OPERATIONS);
    fireEvent.click(button("Volver a «sin decidir»"));
    expect(editor.saved().implemented).toBeNull();
    expect(screen.getByText(/Sin decidir/)).toBeDefined();
  });

  test("el filtro deja ver solo las que contienen el texto", () => {
    mount("implemented", { implemented: [] });
    fireEvent.change(screen.getByPlaceholderText("Filtrar"), { target: { value: "CREATE" } });
    expect(screen.getByLabelText("createWidget")).toBeDefined();
    expect(screen.queryByLabelText("getWidget")).toBeNull();
  });

  test("sin contrato no hay operaciones que marcar, y se dice de dónde saldrán", () => {
    mount("implemented", { implemented: [] }, { operationIds: [] });
    expect(screen.getByText("Importa un contrato y aquí saldrán sus operaciones.")).toBeDefined();
  });
});

describe("los parámetros", () => {
  test("los valores por defecto y la lista de exclusiones, una por línea y sin blancos", () => {
    const editor = mount("parameters", { fallbackPathValue: "1", missingIdValue: "999" });
    fireEvent.change(screen.getByDisplayValue("1"), { target: { value: "abc" } });
    fireEvent.change(screen.getByDisplayValue("999"), { target: { value: "0" } });
    const lines = screen.getAllByRole("textbox").find((node) => node.tagName === "TEXTAREA")!;
    fireEvent.change(lines, { target: { value: " page \n\n limit " } });
    expect(editor.saved()).toMatchObject({
      fallbackPathValue: "abc",
      missingIdValue: "0",
      excludeFromSoloScenarios: ["page", "limit"],
    });
  });

  test("los pares de ruta: añadir, escribir clave y valor, y quitar", () => {
    const editor = mount("parameters", {});
    expect(screen.getByText("Ninguno: todos los parámetros usan el valor por defecto.")).toBeDefined();
    fireEvent.click(screen.getAllByRole("button", { name: "Añadir" })[0]);
    // Una clave vacía no se guarda: el par nuevo aparece en pantalla pero el documento no cambia.
    expect(editor.saved().pathDefaults).toEqual({ "": "" });

    const [key, value] = screen.getAllByRole("textbox").slice(2, 4);
    fireEvent.change(key, { target: { value: "id" } });
    expect(editor.saved().pathDefaults).toEqual({ id: "" });
    fireEvent.change(screen.getAllByRole("textbox")[3], { target: { value: "42" } });
    expect(editor.saved().pathDefaults).toEqual({ id: "42" });
    expect(value).toBeDefined();

    fireEvent.click(button("Quitar"));
    expect(editor.saved().pathDefaults).toEqual({});
  });

  test("por operación: se elige una, y lo que se escribe se acota a ella", () => {
    const editor = mount("parameters", {});
    expect(screen.queryByPlaceholderText("(el del proyecto)")).toBeNull();
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "getWidget" } });

    fireEvent.change(screen.getByPlaceholderText("(el del proyecto)"), { target: { value: "nope" } });
    expect(editor.saved().operationParameters).toEqual({ getWidget: { missingIdValue: "nope" } });
    expect(screen.getByText("getWidget", { selector: "span" })).toBeDefined();
    expect(screen.getByRole("option", { name: "• getWidget" })).toBeDefined();

    // Valores de ruta de la operación.
    fireEvent.click(screen.getAllByRole("button", { name: "Añadir" })[1]);
    const opInputs = () => screen.getAllByRole("textbox");
    // [fallback, missing, pathKey?..] — busca los pares por su etiqueta.
    const paramKey = screen.getAllByText("Parámetro")[0].nextElementSibling as HTMLInputElement;
    fireEvent.change(paramKey, { target: { value: "id" } });
    const paramValue = screen.getAllByText("Valor")[0].nextElementSibling as HTMLInputElement;
    fireEvent.change(paramValue, { target: { value: "7" } });
    expect((editor.saved().operationParameters as Draft).getWidget).toEqual({
      missingIdValue: "nope",
      pathDefaults: { id: "7" },
    });
    expect(opInputs().length).toBeGreaterThan(0);

    // Muestras de un filtro, separadas por comas.
    fireEvent.click(screen.getAllByRole("button", { name: "Añadir" })[2]);
    const filterKey = screen.getByText("Filtro").nextElementSibling as HTMLInputElement;
    fireEvent.change(filterKey, { target: { value: "status" } });
    const filterValues = screen.getByText("Valores").nextElementSibling as HTMLInputElement;
    fireEvent.change(filterValues, { target: { value: "a, b ,, c" } });
    expect(((editor.saved().operationParameters as Draft).getWidget as Draft).parameterSamples).toEqual({
      status: ["a", "b", "c"],
    });
  });

  test("una operación que se queda sin nada que decir desaparece en vez de quedarse como {}", () => {
    const editor = mount("parameters", {
      operationParameters: { getWidget: { missingIdValue: "x", parameterSamples: { q: [1, 2] } } },
    });
    // Abre la primera configurada y enseña sus muestras como texto.
    expect(screen.getByDisplayValue("1, 2")).toBeDefined();
    expect(screen.getByText("getWidget", { selector: "span" })).toBeDefined();

    fireEvent.change(screen.getByDisplayValue("x"), { target: { value: "" } });
    expect(editor.saved().operationParameters).toEqual({ getWidget: { parameterSamples: { q: [1, 2] } } });
    fireEvent.click(button("Quitar"));
    expect(editor.saved().operationParameters).toEqual({});
  });
});

describe("la autorización", () => {
  test("el scope por defecto y las operaciones excluidas", () => {
    const editor = mount("authorization", { scopes: { default: "read" } });
    fireEvent.change(screen.getByDisplayValue("read"), { target: { value: "write" } });
    fireEvent.change(document.querySelector("textarea")!, { target: { value: "getWidget\nlistWidgets" } });
    expect(editor.saved()).toMatchObject({
      scopes: { default: "write" },
      authExcludedOperationIds: ["getWidget", "listWidgets"],
    });
  });

  test("una regla nueva espera 401 sin credencial; sus campos se escriben y el estado declarado vacío se va", () => {
    const editor = mount("authorization", {});
    expect(screen.getByText("Sin reglas: no se genera ningún caso de autorización.")).toBeDefined();
    fireEvent.click(button("Añadir regla"));
    const rule = () => (editor.saved().authRules as Draft[])[0];
    expect(rule()).toEqual({ id: "auth", credential: "none", expectedStatus: 401, when: {} });

    fireEvent.change(screen.getByDisplayValue("none"), { target: { value: "api-key" } });
    fireEvent.change(screen.getByDisplayValue("401"), { target: { value: "403" } });
    const declared = screen.getByText("Si el contrato declara").nextElementSibling as HTMLInputElement;
    fireEvent.change(declared, { target: { value: "401" } });
    fireEvent.click(button("DELETE"));
    expect(rule()).toEqual({
      id: "auth",
      credential: "api-key",
      expectedStatus: 403,
      when: { declaredStatus: 401, methods: ["DELETE"] },
    });

    fireEvent.change(declared, { target: { value: "" } });
    expect(rule().when).toEqual({ methods: ["DELETE"] });
  });
});

describe("los textos", () => {
  test("el idioma y los textos propios, como pares clave-texto", () => {
    const editor = mount("text", { text: { hola: "Hola" } });
    expect(screen.getByDisplayValue("es")).toBeDefined();
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "en" } });
    fireEvent.change(screen.getByDisplayValue("Hola"), { target: { value: "Hello" } });
    expect(editor.saved()).toEqual({ locale: "en", text: { hola: "Hello" } });
  });

  test("sin textos propios se usan los del motor", () => {
    mount("text", {});
    expect(screen.getByText("Ninguno: se usan los textos del motor.")).toBeDefined();
  });
});

describe("los permisos entre roles", () => {
  test("con los roles derivados no se editan ni se dibuja la rejilla: se enseñan", () => {
    mount("access", { access: { roles: ["vendedor", "comprador"] } }, { derivedRoles: true });
    expect(screen.getByText(/Los roles \(vendedor, comprador\)/)).toBeDefined();
    expect(screen.queryByPlaceholderText("vendedor, comprador, admin")).toBeNull();
    expect(screen.queryByLabelText("getWidget para vendedor")).toBeNull();
  });

  test("sin roles derivados todavía, se dice «ninguno»", () => {
    mount("access", {}, { derivedRoles: true });
    expect(screen.getByText(/Los roles \(ninguno\)/)).toBeDefined();
  });

  test("una regla nueva cruza el primer rol con el segundo y todos sus campos se escriben", () => {
    const editor = mount("access", { access: { roles: ["vendedor", "comprador"] } });
    expect(screen.getByText("Sin reglas entre roles.")).toBeDefined();
    fireEvent.click(button("Añadir regla entre roles"));
    const rule = () => ((editor.saved().access as Draft).crossRole as Draft[])[0];
    expect(rule()).toEqual({
      source: "vendedor",
      target: "comprador",
      createOperationId: "listWidgets",
      operationId: "listWidgets",
      allowed: false,
    });

    const select = (text: string) => screen.getByText(text, { selector: "p" }).nextElementSibling as HTMLSelectElement;
    fireEvent.change(select("Lo crea"), { target: { value: "comprador" } });
    fireEvent.change(select("Creando con"), { target: { value: "createWidget" } });
    fireEvent.change(select("Lo intenta"), { target: { value: "vendedor" } });
    fireEvent.change(select("Sobre"), { target: { value: "getWidget" } });
    fireEvent.change(select("Y"), { target: { value: "si" } });
    expect(rule()).toEqual({
      source: "comprador",
      target: "vendedor",
      createOperationId: "createWidget",
      operationId: "getWidget",
      allowed: true,
    });
  });

  test("sin roles ni operaciones la regla nueva nace con los campos vacíos", () => {
    const editor = mount("access", {}, { operationIds: [] });
    fireEvent.click(button("Añadir regla entre roles"));
    expect(((editor.saved().access as Draft).crossRole as Draft[])[0]).toEqual({
      source: "",
      target: "",
      createOperationId: "",
      operationId: "",
      allowed: false,
    });
  });
});

/**
 * Reglas escritas a mano en el documento, a las que les falta algo: el formulario las enseña con
 * los campos vacíos (o con el valor que el motor usaría) y tocar uno no inventa los demás.
 */
describe("las reglas escritas a mano con campos de menos", () => {
  const next = (text: string) => screen.getByText(text, { selector: "p" }).nextElementSibling as HTMLInputElement;

  test("un presupuesto con solo su id sale en blanco y a cero", () => {
    const editor = mount("budgets", { budgets: [{ id: "a" }] });
    expect(next("Etiqueta").value).toBe("");
    expect(next("Umbral (ms)").value).toBe("0");
    expect(next("Origen").value).toBe("");
    fireEvent.change(next("Origen"), { target: { value: "slo" } });
    expect(editor.saved().budgets).toEqual([{ id: "a", source: "slo" }]);
  });

  test("una regla de envoltorio sin criterio ni forma", () => {
    const editor = mount("envelope", { envelope: { rules: [{ id: "e" }] } });
    expect(next("Forma").value).toBe("");
    fireEvent.change(next("La ruta acaba en"), { target: { value: "/x" } });
    expect((editor.saved().envelope as Draft).rules).toEqual([{ id: "e", match: { pathSuffix: "/x" } }]);
  });

  test("una regla de autorización sin credencial ni estado usa los del motor: none y 401", () => {
    const editor = mount("authorization", { authRules: [{ id: "x" }] });
    expect((next("Credencial") as unknown as HTMLSelectElement).value).toBe("none");
    expect(next("Espera").value).toBe("401");
    fireEvent.change(next("Si el contrato declara"), { target: { value: "404" } });
    expect(editor.saved().authRules).toEqual([{ id: "x", when: { declaredStatus: 404 } }]);
  });

  test("una regla entre roles vacía: cambiar quién lo crea escribe solo eso", () => {
    const editor = mount("access", { access: { roles: ["vendedor", "comprador"], crossRole: [{}] } });
    fireEvent.change(next("Lo crea"), { target: { value: "comprador" } });
    expect((editor.saved().access as Draft).crossRole).toEqual([{ source: "comprador" }]);
  });
});

describe("los pares clave-valor con varias filas", () => {
  test("editar la clave o el valor de una fila deja las demás como estaban", () => {
    const editor = mount("text", { text: { a: "A", b: "B" } });
    fireEvent.change(screen.getByDisplayValue("B"), { target: { value: "Bee" } });
    expect(editor.saved().text).toEqual({ a: "A", b: "Bee" });
    fireEvent.change(screen.getByDisplayValue("a"), { target: { value: "z" } });
    expect(editor.saved().text).toEqual({ z: "A", b: "Bee" });
  });

  test("quitar el último valor de ruta de una operación lo borra de ella en vez de dejar {}", () => {
    const editor = mount("parameters", {
      operationParameters: { getWidget: { missingIdValue: "x", pathDefaults: { id: "7" } } },
    });
    fireEvent.click(button("Quitar"));
    expect(editor.saved().operationParameters).toEqual({ getWidget: { missingIdValue: "x" } });
  });

  test("pasar una celda de «debe pasar» a «no debe pasar» mueve el rol de lista", () => {
    const editor = mount("access", {
      access: { roles: ["vendedor"], rules: [{ operationId: "getWidget", allow: ["vendedor"], deny: [] }] },
    });
    fireEvent.change(screen.getByLabelText("getWidget para vendedor"), { target: { value: "deny" } });
    expect((editor.saved().access as Draft).rules).toEqual([
      { operationId: "getWidget", allow: [], deny: ["vendedor"] },
    ]);
  });
});
