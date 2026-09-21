/**
 * El inspector de flujos en los bordes que las otras pruebas no pisan.
 *
 * Lo que decide algo:
 *
 * - **El webhook** guarda cuánto espera (en segundos en pantalla, en milisegundos en el documento,
 *   siempre entre 1 s y 10 min) y con qué verbo, y dice si lo guardado no vale.
 * - **Un campo numérico vaciado** vuelve a su suelo (0 o 1) en vez de guardar `NaN`, y uno opcional
 *   vaciado desaparece del documento.
 * - **Editar una fila de una lista** (asignaciones, entradas, capturas, comprobaciones) deja las
 *   demás como estaban.
 * - **Lo que falta en el documento** —un valor de comprobación, un tope de vueltas, el estado de un
 *   mock escrito a mano— se enseña vacío o con el valor que usará el motor.
 */
import { describe, expect, test } from "vitest";
import { fireEvent, screen, within } from "@testing-library/react";

import { field, openTab, renderInspector, visiblePanel } from "@/test/workflow-inspector-harness";
import type { ChannelView, RequestTemplateView, WorkflowStepView, WorkflowView } from "@/lib/types";

const template: RequestTemplateView = {
  id: "t1",
  name: "Crear cosa",
  operationId: "op1",
  description: null,
  expectedStatus: 201,
  parameters: {},
  disabledParameters: {},
  headers: {},
  disabledHeaders: {},
  body: { type: "none" },
  auth: "default",
  updatedAt: "2026-01-01T00:00:00Z",
};
const req = (id: string, dependsOn?: string[]): WorkflowStepView => ({ id, requestTemplateId: "t1", dependsOn });

describe("el webhook", () => {
  test("sin configurar espera un POST un minuto; el tiempo se escribe en segundos y se acota", () => {
    const view = renderInspector({ steps: [{ id: "gancho", kind: "webhook" }], selected: "gancho" });
    const at = () => view.last()[0]!.webhook!;
    expect(screen.getByText("POST · 1 min · gancho")).toBeTruthy();
    expect(screen.getByText("Espera como mucho 1 min (de 1 s a 10 min).")).toBeTruthy();
    expect(within(visiblePanel()).getByText(/La URL aparece en la corrida/)).toBeTruthy();

    fireEvent.change(field("Esperar hasta (s)"), { target: { value: "90" } });
    expect(at()).toEqual({ timeoutMs: 90_000, method: "POST" });
    fireEvent.change(field("Esperar hasta (s)"), { target: { value: "" } });
    expect(at().timeoutMs).toBe(1_000);
    fireEvent.change(field("Esperar hasta (s)"), { target: { value: "5000" } });
    expect(at().timeoutMs).toBe(600_000);

    fireEvent.change(field<HTMLSelectElement>("Método de la llamada"), { target: { value: "PUT" } });
    expect(at().method).toBe("PUT");
    expect(screen.getByText("PUT · 10 min · gancho")).toBeTruthy();

    // Sus otras pestañas: comprobaciones, capturas y qué pasa si falla.
    openTab(/Comprobaciones/);
    fireEvent.click(within(visiblePanel()).getByRole("button", { name: "+ Comprobación" }));
    expect(view.last()[0]!.checks).toHaveLength(1);
    openTab(/Capturas/);
    fireEvent.click(within(visiblePanel()).getByRole("button", { name: "+ Captura" }));
    expect(view.last()[0]!.captures).toHaveLength(1);
    openTab(/Si falla/);
    fireEvent.change(field<HTMLSelectElement>("Si este paso falla"), { target: { value: "continue" } });
    expect(view.last()[0]!.onError).toBe("continue");
  });

  test("una espera guardada fuera de rango se avisa; sin verbo guardado se entiende POST", () => {
    renderInspector({
      steps: [{ id: "gancho", kind: "webhook", webhook: { timeoutMs: 0 } as WorkflowStepView["webhook"] }],
      selected: "gancho",
    });
    expect(screen.getByText("La espera: la espera tiene que estar entre 1 s y 10 min.")).toBeTruthy();
    expect(field<HTMLSelectElement>("Método de la llamada").value).toBe("POST");
    expect(screen.getByText("POST · 0 s · gancho")).toBeTruthy();
  });
});

describe("los números vaciados", () => {
  test("la espera vaciada es 0, no NaN", () => {
    const view = renderInspector({ steps: [{ id: "espera", kind: "wait", waitMs: 500 }], selected: "espera" });
    fireEvent.change(field("Milisegundos"), { target: { value: "" } });
    expect(view.last()[0]!.waitMs).toBe(0);
  });

  test("el reintento: reintentos vaciados es 1 y la espera vaciada 0", () => {
    const view = renderInspector({
      steps: [
        req("leer"),
        { id: "reintento", kind: "retry", dependsOn: ["leer"], rerun: { from: "leer", target: "", attempts: 3, delayMs: 1000 } },
      ],
      selected: "reintento",
    });
    fireEvent.change(field("Reintentos (máx.)"), { target: { value: "" } });
    fireEvent.change(field("Espera antes de cada uno (ms)"), { target: { value: "" } });
    expect(view.last()[1]!.rerun).toMatchObject({ attempts: 1, delayMs: 0 });
  });

  test("el sondeo: la espera vaciada es 0", () => {
    const view = renderInspector({
      steps: [req("trabajo"), { id: "sondeo", kind: "poll", dependsOn: ["trabajo"], poll: { from: "trabajo", attempts: 3, delayMs: 500 } }],
      selected: "sondeo",
    });
    fireEvent.change(field("Cada (ms)"), { target: { value: "" } });
    expect(view.last()[1]!.poll!.delayMs).toBe(0);
    // Sin comprobaciones la pestaña no lleva cuenta.
    expect(screen.getByRole("tab", { name: /Comprobaciones/ }).textContent).toBe("Comprobaciones");
  });
});

describe("lo que falta en el documento", () => {
  test("una condición de If sin valor enseña el campo vacío", () => {
    renderInspector({
      steps: [
        req("a"),
        { id: "si", kind: "branch", dependsOn: ["a"], condition: { from: "a", check: { source: "status", operator: "equals" } } },
      ],
      selected: "si",
    });
    expect((screen.getByLabelText("Valor de la condición") as HTMLInputElement).value).toBe("");
  });

  test("una unión sin nada conectado cuenta cero ramas", () => {
    renderInspector({ steps: [{ id: "union", kind: "merge" }], selected: "union" });
    expect(within(visiblePanel()).getByText("0")).toBeTruthy();
  });

  test("un bucle sin nombre de elemento ni tope usa «item» y 50", () => {
    renderInspector({
      steps: [{ id: "bucle", kind: "loop", loop: { from: "", path: "data", as: "" } }],
      selected: "bucle",
    });
    expect(field("Máx. vueltas").value).toBe("50");
    expect(screen.getByText("{{item.id}}")).toBeTruthy();
  });

  test("un mock escrito a mano sin estado deja el campo vacío", () => {
    renderInspector({ steps: [{ id: "mock", kind: "mock", mock: {} as WorkflowStepView["mock"] }], selected: "mock" });
    expect(field("Estado").value).toBe("");
  });

  test("«Solo si…» sin valor y «Una vez por elemento» sin tope", () => {
    renderInspector({
      steps: [
        req("a"),
        {
          id: "crear",
          requestTemplateId: "t1",
          dependsOn: ["a"],
          runIf: { from: "a", check: { source: "status", operator: "equals" } },
          forEach: { from: "a", path: "data", as: "item" },
        },
      ],
      selected: "crear",
      templates: [template],
    });
    openTab(/Cuándo/);
    expect((screen.getByLabelText("Valor de la condición") as HTMLInputElement).value).toBe("");
    expect(field("Como mucho").value).toBe("50");
  });

  test("una notificación sin entorno elegido no ofrece variables", () => {
    renderInspector({ steps: [{ id: "aviso", kind: "notify" }], selected: "aviso" });
    expect(document.querySelectorAll("#notify-url-aviso option")).toHaveLength(0);
  });
});

describe("editar una fila deja las demás", () => {
  test("las asignaciones del nodo Set", () => {
    const view = renderInspector({
      steps: [
        {
          id: "vars",
          kind: "set",
          set: {
            assignments: [
              { variable: "a", value: "1" },
              { variable: "b", value: "2" },
            ],
          },
        },
      ],
      selected: "vars",
    });
    fireEvent.change(screen.getAllByLabelText("Variable")[1]!, { target: { value: "c" } });
    fireEvent.change(screen.getAllByLabelText("Valor")[0]!, { target: { value: "9" } });
    expect(view.last()[0]!.set!.assignments).toEqual([
      { variable: "a", value: "9" },
      { variable: "c", value: "2" },
    ]);
  });

  test("las entradas de un sub-flujo, y un hijo de un solo paso lo dice en singular", () => {
    const flows = [
      { id: "hijo", name: "Hijo", description: null, status: "draft", steps: [req("x")], updatedAt: "" } as WorkflowView,
    ];
    const view = renderInspector({
      steps: [
        {
          id: "sub",
          kind: "subflow",
          subflow: {
            workflowId: "hijo",
            inputs: [
              { variable: "a", value: "1" },
              { variable: "b", value: "2" },
            ],
          },
        },
      ],
      selected: "sub",
      flows,
    });
    expect(screen.getByText(/^1 paso\./)).toBeTruthy();
    openTab(/Entradas/);
    fireEvent.change(screen.getAllByLabelText("Variable del hijo")[1]!, { target: { value: "c" } });
    fireEvent.change(within(visiblePanel()).getAllByLabelText("Valor")[0]!, { target: { value: "9" } });
    expect(view.last()[0]!.subflow!.inputs).toEqual([
      { variable: "a", value: "9" },
      { variable: "c", value: "2" },
    ]);
  });

  test("las capturas y las comprobaciones; una comprobación sin valor sale vacía", () => {
    const view = renderInspector({
      steps: [
        {
          id: "crear",
          requestTemplateId: "t1",
          captures: [
            { variable: "a", from: "body", path: "a" },
            { variable: "b", from: "body", path: "b" },
          ],
          checks: [
            { source: "status", operator: "equals", value: "201" },
            { source: "body", path: "ok", operator: "equals" },
          ],
        },
      ],
      selected: "crear",
      templates: [template],
    });
    openTab(/Capturas/);
    fireEvent.change(screen.getAllByLabelText("Variable capturada")[1]!, { target: { value: "c" } });
    expect(view.last()[0]!.captures).toEqual([
      { variable: "a", from: "body", path: "a" },
      { variable: "c", from: "body", path: "b" },
    ]);

    openTab(/Comprobaciones/);
    const values = screen.getAllByLabelText("Valor esperado") as HTMLInputElement[];
    expect(values[1]!.value).toBe("");
    fireEvent.change(values[1]!, { target: { value: "true" } });
    expect(view.last()[0]!.checks).toEqual([
      { source: "status", operator: "equals", value: "201" },
      { source: "body", path: "ok", operator: "equals", value: "true" },
    ]);
  });
});

describe("GraphQL y mock: sesión y cabeceras apagadas", () => {
  test("GraphQL: quitar la sesión la borra, y una cabecera apagada se guarda aparte", () => {
    const view = renderInspector({
      steps: [{ id: "gql", kind: "graphql", graphql: { url: "https://x/graphql", query: "{a}", useSession: true, headers: { "X-A": "1" } } }],
      selected: "gql",
    });
    const at = () => view.last()[0]!.graphql!;
    fireEvent.click(screen.getByRole("checkbox", { name: /Enviar sesión del login/ }));
    expect(at().useSession).toBeUndefined();
    fireEvent.click(screen.getByLabelText("Enviar X-A"));
    expect(at().headers).toBeUndefined();
    expect(at().disabledHeaders).toEqual({ "X-A": "1" });
    expect(screen.getByRole("tab", { name: /Comprobaciones/ }).textContent).toBe("Comprobaciones");
  });

  test("mock: una cabecera apagada se guarda aparte; volver a encenderla la devuelve", () => {
    const view = renderInspector({
      steps: [{ id: "mock", kind: "mock", mock: { status: 200, headers: { "X-A": "1" } } }],
      selected: "mock",
    });
    const at = () => view.last()[0]!.mock!;
    fireEvent.click(screen.getByLabelText("Enviar X-A"));
    expect(at().headers).toBeUndefined();
    expect(at().disabledHeaders).toEqual({ "X-A": "1" });
    fireEvent.click(screen.getByLabelText("Enviar X-A"));
    expect(at().headers).toEqual({ "X-A": "1" });
    expect(at().disabledHeaders).toBeUndefined();
    expect(screen.getByRole("tab", { name: /Comprobaciones/ }).textContent).toBe("Comprobaciones");
  });
});

describe("las pestañas cuentan lo que el nodo ya tiene", () => {
  const capture = { variable: "a", from: "body", path: "a" } as const;
  const check = { source: "status", operator: "equals", value: "200" } as const;
  test.each<[string, WorkflowStepView, RegExp, string]>([
    ["fetch", { id: "n", kind: "fetch", fetch: { method: "GET", url: "https://x" }, captures: [capture] }, /Capturas/, "Capturas1"],
    ["graphql", { id: "n", kind: "graphql", checks: [check] }, /Comprobaciones/, "Comprobaciones1"],
    ["mock", { id: "n", kind: "mock", checks: [check] }, /Comprobaciones/, "Comprobaciones1"],
    ["canal", { id: "n", kind: "channel", captures: [capture] }, /Capturas/, "Capturas1"],
    ["sondeo", { id: "n", kind: "poll", checks: [check] }, /Comprobaciones/, "Comprobaciones1"],
  ])("%s", (_kind, step, tab, text) => {
    renderInspector({ steps: [step], selected: "n", channels: [] });
    expect(screen.getByRole("tab", { name: tab }).textContent).toBe(text);
  });
});

describe("la petición guardada", () => {
  test("cambiar el tipo de body lo escribe en la plantilla", () => {
    const view = renderInspector({ steps: [req("crear")], selected: "crear", templates: [template] });
    openTab(/Body/);
    fireEvent.change(screen.getByLabelText("Tipo de cuerpo"), { target: { value: "json" } });
    expect(view.onTemplate).toHaveBeenLastCalledWith(expect.objectContaining({ id: "t1", body: expect.objectContaining({ type: "json" }) }));
  });
});

describe("el canal, en sus bordes", () => {
  const channel = (patch: Partial<ChannelView>): ChannelView => ({
    id: "c-ws",
    protocol: "mqtt",
    name: "sensores",
    url: "mqtt://broker",
    subprotocols: [],
    headers: [],
    auth: null,
    limits: { maxMessages: 200, maxBytes: 1_048_576, maxMessageBytes: 65_536, maxDurationMs: 30_000, idleMs: 10_000 },
    expectations: { minMessages: 1, checks: [{ source: "body", operator: "exists", path: "t" }] as never },
    messages: [{ name: "temp", body: "21", topic: "casa/temp" }],
    mqtt: null,
    grpc: null,
    orderIndex: 0,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    archivedAt: null,
    deletedAt: null,
    ...patch,
  });

  test("dice las comprobaciones del canal; cerrar al recibir e inactividad se escriben y vaciados desaparecen", () => {
    const view = renderInspector({
      steps: [{ id: "canal", kind: "channel", channel: { channelId: "c-ws" } }],
      selected: "canal",
      channels: [channel({})],
    });
    const at = () => view.last()[0]!.channel!;
    expect(screen.getByText(/y 1 comprobación\(es\)\./)).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Mensajes para cerrar"), { target: { value: "3" } });
    fireEvent.change(screen.getByLabelText("Inactividad"), { target: { value: "500" } });
    expect(at()).toEqual({ channelId: "c-ws", untilMessages: 3, idleMs: 500 });
    fireEvent.change(screen.getByLabelText("Mensajes para cerrar"), { target: { value: "" } });
    fireEvent.change(screen.getByLabelText("Inactividad"), { target: { value: "" } });
    expect(at()).toEqual({ channelId: "c-ws" });

    // El guion heredado enseña el tema de cada mensaje.
    openTab(/Guion/);
    expect(within(visiblePanel()).getByText("1. casa/temp ← 21")).toBeTruthy();
    expect(screen.getByRole("tab", { name: /Capturas/ }).textContent).toBe("Capturas");
  });

  test("gRPC sin mensaje guardado: la petición parte de {} y vaciarla la quita", () => {
    const view = renderInspector({
      steps: [{ id: "canal", kind: "channel", channel: { channelId: "c-grpc" } }],
      selected: "canal",
      channels: [
        channel({
          id: "c-grpc",
          protocol: "grpc",
          name: "tienda",
          messages: [],
          expectations: {},
          grpc: { source: "proto", service: "s", method: "m", message: "", deadlineMs: 5000 } as ChannelView["grpc"],
        }),
      ],
    });
    const request = screen.getByLabelText("Petición gRPC") as HTMLTextAreaElement;
    expect(request.placeholder).toBe("{}");
    fireEvent.change(request, { target: { value: '{"id":1}' } });
    expect(view.last()[0]!.channel!.request).toBe('{"id":1}');
    fireEvent.change(request, { target: { value: "" } });
    expect(view.last()[0]!.channel).toEqual({ channelId: "c-grpc" });
  });
});
