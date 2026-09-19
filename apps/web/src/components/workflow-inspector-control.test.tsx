/**
 * Los nodos de control del inspector: los que no mandan una petición propia.
 *
 * Lo que decide algo:
 *
 * - **Lo que leen sale de sus dependencias**: If, validación, script, bucle, esquema y sondeo solo
 *   ofrecen los pasos conectados a su entrada, y sin ninguno avisan de que hay que conectarlos.
 * - **Los números se acotan al escribirlos**: la espera a 0–60 000, el bucle a 1–200, el reintento a
 *   1–10 y el sondeo a 1–20, para que lo guardado sea lo que el motor acepta.
 * - **Lo vacío no se guarda como texto vacío**: el script de la validación vuelve a ausente.
 * - **Cada nodo dice lo que va a pasar**: el bucle qué corre por vuelta, el reintento qué tramo repite,
 *   el esquema si el contrato sirve para ese paso o el JSON escrito tiene un problema.
 */
import { describe, expect, test } from "vitest";
import { fireEvent, screen, within } from "@testing-library/react";

import { field, openTab, renderInspector, visiblePanel } from "@/test/workflow-inspector-harness";
import type { WorkflowStepView } from "@/lib/types";

const req = (id: string, dependsOn?: string[]): WorkflowStepView => ({ id, requestTemplateId: `t-${id}`, dependsOn });

describe("la bifurcación (If)", () => {
  test("sin conexión pide conectarla; conectada edita paso, origen, ruta, operador y valor", () => {
    const view = renderInspector({
      steps: [req("a"), req("b"), { id: "rama", kind: "branch", dependsOn: ["a", "b"] }],
      selected: "rama",
    });
    // La condición por defecto: status equals 200 del primer paso conectado.
    expect((field<HTMLSelectElement>("Lee el paso")).value).toBe("a");
    expect((screen.getByLabelText("Ruta de la condición") as HTMLInputElement).disabled).toBe(true);

    fireEvent.change(field<HTMLSelectElement>("Lee el paso"), { target: { value: "b" } });
    expect(view.last()[2]!.condition!.from).toBe("b");

    fireEvent.change(field<HTMLSelectElement>("Origen"), { target: { value: "body" } });
    fireEvent.change(screen.getByLabelText("Ruta de la condición"), { target: { value: "data.estado" } });
    fireEvent.change(screen.getByLabelText("Valor de la condición"), { target: { value: "listo" } });
    expect(view.last()[2]!.condition).toEqual({
      from: "b",
      check: { source: "body", operator: "equals", value: "listo", path: "data.estado" },
    });

    // Un operador que no compara esconde el valor.
    fireEvent.change(screen.getByLabelText("Operador de la condición"), { target: { value: "exists" } });
    expect(view.last()[2]!.condition!.check.operator).toBe("exists");
    expect(screen.queryByLabelText("Valor de la condición")).toBeNull();
  });

  test("sin pasos conectados avisa en lugar de ofrecer la condición", () => {
    renderInspector({ steps: [{ id: "rama", kind: "branch" }], selected: "rama" });
    expect(screen.getByText(/Conéctalo a la petición que quieres leer/)).toBeTruthy();
  });
});

describe("la espera y la unión", () => {
  test("la espera se acota entre 0 y 60 000 ms", () => {
    const view = renderInspector({ steps: [{ id: "espera", kind: "wait" }], selected: "espera" });
    expect(field("Milisegundos").value).toBe("0");
    fireEvent.change(field("Milisegundos"), { target: { value: "90000" } });
    expect(view.last()[0]!.waitMs).toBe(60000);
    fireEvent.change(field("Milisegundos"), { target: { value: "-5" } });
    expect(view.last()[0]!.waitMs).toBe(0);
  });

  test("la unión cuenta sus ramas y elige entre todas o cualquiera", () => {
    const view = renderInspector({
      steps: [req("a"), req("b"), { id: "union", kind: "merge", dependsOn: ["a", "b"] }],
      selected: "union",
    });
    expect(screen.getByRole("tab", { name: /Unión/ }).textContent).toBe("Unión2");
    fireEvent.change(field<HTMLSelectElement>("Cuándo continúa"), { target: { value: "any" } });
    expect(view.last()[2]!.waits).toBe("any");
    fireEvent.change(field<HTMLSelectElement>("Cuándo continúa"), { target: { value: "all" } });
    expect(view.last()[2]!.waits).toBe("all");
  });
});

describe("la validación", () => {
  test("elige el paso, añade comprobaciones y escribe un script que se borra a ausente", () => {
    const view = renderInspector({
      steps: [req("a"), req("b"), { id: "valida", kind: "validate", dependsOn: ["a", "b"] }],
      selected: "valida",
    });
    fireEvent.change(field<HTMLSelectElement>("Lee el paso"), { target: { value: "b" } });
    expect(view.last()[2]!.validate).toEqual({ from: "b" });

    fireEvent.click(screen.getByRole("button", { name: "+ Comprobación" }));
    expect(view.last()[2]!.checks).toEqual([{ source: "status", operator: "equals", value: "200" }]);
    expect(screen.getByRole("tab", { name: /Comprobaciones/ }).textContent).toBe("Comprobaciones1");

    openTab(/Script/);
    fireEvent.change(screen.getByLabelText("Script de validación"), { target: { value: "pm.test('x', () => {})" } });
    expect(view.last()[2]!.validate!.script).toBe("pm.test('x', () => {})");
    // Con script la pestaña lleva la marca de «configurado».
    expect(within(screen.getByRole("tab", { name: /Script/ })).getByLabelText("configurado")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Script de validación"), { target: { value: "" } });
    expect(view.last()[2]!.validate!.script).toBeUndefined();
  });

  test("sin conexión avisa de que hay que conectarla", () => {
    renderInspector({ steps: [{ id: "valida", kind: "validate" }], selected: "valida" });
    expect(screen.getByText(/Conéctalo a la petición cuya respuesta quieres validar/)).toBeTruthy();
  });
});

describe("el nodo Set", () => {
  test("añade, edita y quita asignaciones", () => {
    const view = renderInspector({ steps: [{ id: "variables", kind: "set" }], selected: "variables" });
    fireEvent.click(screen.getByRole("button", { name: "+ Variable" }));
    fireEvent.change(screen.getByLabelText("Variable"), { target: { value: "total" } });
    fireEvent.change(screen.getByLabelText("Valor"), { target: { value: "{{precio}}" } });
    expect(view.last()[0]!.set).toEqual({ assignments: [{ variable: "total", value: "{{precio}}" }] });

    fireEvent.click(screen.getByRole("button", { name: "+ Variable" }));
    expect(view.last()[0]!.set!.assignments).toHaveLength(2);
    fireEvent.click(screen.getAllByRole("button", { name: "Quitar variable" })[0]!);
    expect(view.last()[0]!.set!.assignments).toEqual([{ variable: "", value: "" }]);
  });
});

describe("el nodo Script", () => {
  test("lee la respuesta de un paso conectado o de ninguno, y guarda el código", () => {
    const view = renderInspector({
      steps: [req("a"), { id: "script", kind: "script", dependsOn: ["a"] }],
      selected: "script",
    });
    fireEvent.change(screen.getByLabelText("Código del script"), { target: { value: "pm.variables.set('x','1')" } });
    expect(view.last()[1]!.script).toEqual({ code: "pm.variables.set('x','1')" });

    fireEvent.change(field<HTMLSelectElement>("Lee la respuesta de"), { target: { value: "a" } });
    expect(view.last()[1]!.script).toEqual({ code: "pm.variables.set('x','1')", from: "a" });
    fireEvent.change(field<HTMLSelectElement>("Lee la respuesta de"), { target: { value: "" } });
    expect(view.last()[1]!.script).toEqual({ code: "pm.variables.set('x','1')" });
  });

  test("«Si falla» elige qué pasa y el reintento propio se enciende con su configuración", () => {
    const view = renderInspector({ steps: [{ id: "script", kind: "script" }], selected: "script" });
    openTab(/Si falla/);
    expect(screen.getByText(/contado dos veces/)).toBeTruthy();
    fireEvent.change(field<HTMLSelectElement>("Si este paso falla"), { target: { value: "stop" } });
    expect(view.last()[0]!.onError).toBe("stop");
    expect(screen.getByText(/sin este paso todo lo demás/)).toBeTruthy();

    fireEvent.click(screen.getByRole("checkbox", { name: /Reintentar/ }));
    expect(view.last()[0]!.retry).toEqual({ attempts: 2, delayMs: 500, backoff: 2 });
    fireEvent.change(field("Intentos"), { target: { value: "4" } });
    fireEvent.change(field("Espera (ms)"), { target: { value: "1000" } });
    fireEvent.change(field("Factor"), { target: { value: "1.5" } });
    fireEvent.change(field("Solo estos estados"), { target: { value: "502, 503 abc 99" } });
    expect(view.last()[0]!.retry).toEqual({ attempts: 4, delayMs: 1000, backoff: 1.5, onStatus: [502, 503] });
    fireEvent.change(field("Solo estos estados"), { target: { value: "" } });
    expect(view.last()[0]!.retry!.onStatus).toBeUndefined();

    fireEvent.click(screen.getByRole("checkbox", { name: /Reintentar/ }));
    expect(view.last()[0]!.retry).toBeUndefined();
  });
});

describe("el bucle", () => {
  test("elige la lista, acota las vueltas y dice qué corre en cada una", () => {
    const view = renderInspector({
      steps: [
        req("listar"),
        { id: "bucle", kind: "loop", dependsOn: ["listar"] },
        { id: "leer", requestTemplateId: "t", dependsOn: ["bucle"], inLoop: "bucle" },
        { id: "borrar", requestTemplateId: "t", dependsOn: ["leer"] },
      ],
      selected: "bucle",
    });
    expect(screen.getByText("Por vuelta: leer → borrar")).toBeTruthy();
    // Sin lista elegida se ofrece «Elige un paso».
    expect(within(field<HTMLSelectElement>("Lee la lista de")).getByText("Elige un paso")).toBeTruthy();
    fireEvent.change(field<HTMLSelectElement>("Lee la lista de"), { target: { value: "listar" } });
    fireEvent.change(field("Ruta a la lista en el body"), { target: { value: "data.items" } });
    fireEvent.change(field("Cada elemento"), { target: { value: "pedido" } });
    fireEvent.change(field("Máx. vueltas"), { target: { value: "999" } });
    expect(view.last()[1]!.loop).toEqual({ from: "listar", path: "data.items", as: "pedido", max: 200 });
    expect(screen.getByText("{{pedido.id}}")).toBeTruthy();
    fireEvent.change(field("Máx. vueltas"), { target: { value: "0" } });
    expect(view.last()[1]!.loop!.max).toBe(1);

    // Su «Si falla» no ofrece el reintento propio.
    openTab(/Si falla/);
    expect(screen.queryByRole("checkbox", { name: /Reintentar/ })).toBeNull();
  });

  test("sin nada conectado avisa en los dos extremos", () => {
    renderInspector({ steps: [{ id: "bucle", kind: "loop" }], selected: "bucle" });
    expect(screen.getByText(/Conéctalo al paso cuya respuesta trae la lista/)).toBeTruthy();
    expect(within(visiblePanel()).getByText(/Nada conectado a «cada»/)).toBeTruthy();
  });
});

describe("el esquema", () => {
  test("un esquema propio avisa de su JSON; el contrato solo sirve para peticiones guardadas", () => {
    const view = renderInspector({
      steps: [
        req("crear"),
        { id: "llamar", kind: "fetch", fetch: { method: "GET", url: "/x" } },
        { id: "esquema", kind: "schema", dependsOn: ["crear", "llamar"] },
      ],
      selected: "esquema",
    });
    expect(screen.getByText("Falta el JSON Schema.")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("JSON Schema"), { target: { value: "{no" } });
    expect(screen.getByText("El esquema no es JSON válido.")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("JSON Schema"), { target: { value: '{"type":"object"}' } });
    expect(screen.getByText(/type, required, properties/)).toBeTruthy();

    fireEvent.change(field<HTMLSelectElement>("Valida el paso"), { target: { value: "crear" } });
    fireEvent.change(field<HTMLSelectElement>("Contra"), { target: { value: "contract" } });
    expect(screen.getByText(/Usa el esquema que el contrato declara/)).toBeTruthy();
    expect(screen.queryByLabelText("JSON Schema")).toBeNull();

    fireEvent.change(field<HTMLSelectElement>("Valida el paso"), { target: { value: "llamar" } });
    expect(screen.getByText(/Ese paso no es una petición guardada/)).toBeTruthy();

    fireEvent.click(screen.getByRole("checkbox", { name: /Estricto/ }));
    expect(view.last()[2]!.schema).toEqual({ from: "llamar", source: "contract", json: '{"type":"object"}', strict: true });
  });

  test("sin conexión pide conectarlo", () => {
    renderInspector({ steps: [{ id: "esquema", kind: "schema" }], selected: "esquema" });
    expect(screen.getByText(/Conéctalo al paso cuya respuesta quieres validar/)).toBeTruthy();
  });
});

describe("el reintento", () => {
  const steps: WorkflowStepView[] = [
    req("crear"),
    req("leer", ["crear"]),
    { id: "reintento", kind: "retry", dependsOn: ["leer"], rerun: { from: "leer", target: "", attempts: 3, delayMs: 1000 } },
  ];

  test("ofrece el paso vigilado y los anteriores, y dice qué tramo repite", () => {
    const view = renderInspector({ steps, selected: "reintento" });
    expect(screen.getByText("leer (el mismo paso)")).toBeTruthy();
    fireEvent.change(field<HTMLSelectElement>("Repite desde"), { target: { value: "crear" } });
    expect(view.last()[2]!.rerun!.target).toBe("crear");
    expect(screen.getByText("crear → leer")).toBeTruthy();

    fireEvent.change(field("Reintentos (máx.)"), { target: { value: "50" } });
    expect(view.last()[2]!.rerun!.attempts).toBe(10);
    fireEvent.change(field("Espera antes de cada uno (ms)"), { target: { value: "99999" } });
    expect(view.last()[2]!.rerun!.delayMs).toBe(60000);
  });

  test("sin paso vigilado pide conectarlo y no ofrece desde dónde repetir", () => {
    renderInspector({ steps: [{ id: "reintento", kind: "retry" }], selected: "reintento" });
    expect(within(visiblePanel()).getByText(/Conecta a su entrada el paso que puede fallar/)).toBeTruthy();
    expect(field<HTMLSelectElement>("Repite desde").disabled).toBe(true);
  });
});

describe("el sondeo", () => {
  test("solo repite peticiones o fetch sin bucle ni login, y acota reenvíos y espera", () => {
    const view = renderInspector({
      steps: [
        req("trabajo"),
        { id: "login", requestTemplateId: "t", authorizes: { from: "body", path: "data.token" } },
        { id: "rama", kind: "branch" },
        { id: "sondeo", kind: "poll", dependsOn: ["trabajo", "login", "rama"] },
      ],
      selected: "sondeo",
    });
    const select = field<HTMLSelectElement>("Repite el paso");
    expect([...select.options].map((option) => option.value)).toEqual(["", "trabajo"]);
    fireEvent.change(select, { target: { value: "trabajo" } });
    fireEvent.change(field("Reenvíos (máx.)"), { target: { value: "0" } });
    fireEvent.change(field("Cada (ms)"), { target: { value: "-1" } });
    expect(view.last()[3]!.poll).toEqual({ from: "trabajo", attempts: 1, delayMs: 0 });

    openTab(/Capturas/);
    expect(within(visiblePanel()).getByText("Capturas de la última respuesta")).toBeTruthy();
    fireEvent.click(within(visiblePanel()).getByRole("button", { name: "+ Captura" }));
    expect(view.last()[3]!.captures).toEqual([{ variable: "", from: "body", path: "" }]);
  });

  test("sin nada que repetir avisa", () => {
    renderInspector({ steps: [{ id: "sondeo", kind: "poll" }], selected: "sondeo" });
    expect(screen.getByText(/Conéctalo a una petición o un fetch/)).toBeTruthy();
  });
});
