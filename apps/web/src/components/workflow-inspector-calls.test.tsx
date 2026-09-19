/**
 * Los nodos que hablan con algo de fuera sin una petición guardada: fetch, GraphQL, mock, notificar y
 * sub-flujo.
 *
 * Lo que decide algo:
 *
 * - **El fetch solo ofrece body cuando el método lo lleva**, y avisa cuando la sesión del login viajaría
 *   a otro host. Las cabeceras apagadas se guardan aparte y un mapa vacío vuelve a ausente.
 * - **GraphQL valida lo que se puede validar sin enviarlo**: un operationName con otra gramática y unas
 *   variables que no son un objeto JSON se dicen en el sitio.
 * - **El mock responde lo que se escribe**, avisa si el body no es el JSON que su content-type promete,
 *   y ofrece capturas sacadas de su propio body.
 * - **La notificación guarda el nombre de la variable, nunca la URL**, y dice si el entorno no la tiene
 *   o no la marca como sensible.
 * - **Un canal sin canales en el proyecto** dice dónde crearlos.
 * - **El sub-flujo no ofrece el propio flujo, ni los archivados ni los que ya lo ejecutan**, y propone
 *   como salidas lo que el hijo escribe.
 */
import { describe, expect, test } from "vitest";
import { fireEvent, screen, within } from "@testing-library/react";

import { field, openTab, renderInspector, visiblePanel } from "@/test/workflow-inspector-harness";
import type { Environment, WorkflowStepView, WorkflowView } from "@/lib/types";

describe("el fetch", () => {
  test("método, URL, estado, sesión, autenticación, cabeceras y body", () => {
    const view = renderInspector({ steps: [{ id: "fetch", kind: "fetch" }], selected: "fetch" });
    const at = () => view.last()[0]!.fetch!;

    // GET no lleva body: no hay pestaña.
    expect(screen.queryByRole("tab", { name: /Body/ })).toBeNull();
    fireEvent.change(field("URL"), { target: { value: "https://otro.example.com/hook" } });
    fireEvent.change(field("Estado esperado"), { target: { value: "202" } });
    expect(at()).toEqual({ method: "GET", url: "https://otro.example.com/hook", expectedStatus: 202 });
    expect(screen.getByText("GET https://otro.example.com/hook · fetch")).toBeTruthy();
    fireEvent.change(field("Estado esperado"), { target: { value: "" } });
    expect(at().expectedStatus).toBeUndefined();

    fireEvent.click(screen.getByRole("checkbox", { name: /Enviar sesión del login/ }));
    expect(at().useSession).toBe(true);
    expect(screen.getByText(/La credencial obtenida en el login viajará a esta URL/)).toBeTruthy();
    fireEvent.click(screen.getByRole("checkbox", { name: /Enviar sesión del login/ }));
    expect(at().useSession).toBeUndefined();

    fireEvent.change(screen.getByLabelText("Tipo de autenticación"), { target: { value: "bearer" } });
    expect(at().auth).toEqual({ type: "bearer", params: {} });
    fireEvent.change(screen.getByLabelText("Tipo de autenticación"), { target: { value: "inherit" } });
    expect(at().auth).toBeUndefined();

    fireEvent.change(screen.getByLabelText("Nombre de cabeceras"), { target: { value: "X-Tenant" } });
    fireEvent.change(screen.getByLabelText("Valor de X-Tenant"), { target: { value: "acme" } });
    expect(at().headers).toEqual({ "X-Tenant": "acme" });
    fireEvent.click(screen.getByLabelText("Enviar X-Tenant"));
    expect(at().headers).toBeUndefined();
    expect(at().disabledHeaders).toEqual({ "X-Tenant": "acme" });

    fireEvent.change(field<HTMLSelectElement>("Método"), { target: { value: "POST" } });
    openTab(/Body/);
    fireEvent.change(field<HTMLTextAreaElement>("Body"), { target: { value: '{"a":1}' } });
    expect(at().body).toBe('{"a":1}');
    expect(within(screen.getByRole("tab", { name: /Body/ })).getByLabelText("configurado")).toBeTruthy();
    fireEvent.change(field<HTMLTextAreaElement>("Body"), { target: { value: "" } });
    expect(at().body).toBeUndefined();
  });

  test("capturas con sesión, comprobaciones y «Cuándo» también en el fetch", () => {
    const view = renderInspector({
      steps: [{ id: "a", kind: "wait" }, { id: "fetch", kind: "fetch", dependsOn: ["a"], fetch: { method: "GET", url: "/x" } }],
      selected: "fetch",
    });
    openTab(/Capturas/);
    fireEvent.click(screen.getByRole("checkbox", { name: /Este paso inicia sesión/ }));
    expect(view.last()[1]!.authorizes).toEqual({ from: "body", path: "data.token" });
    openTab(/Comprobaciones/);
    fireEvent.click(screen.getByRole("button", { name: "+ Comprobación" }));
    expect(view.last()[1]!.checks).toHaveLength(1);
    openTab(/Cuándo/);
    fireEvent.change(field("Esperar antes (ms)"), { target: { value: "300" } });
    expect(view.last()[1]!.waitMs).toBe(300);
    expect(within(screen.getByRole("tab", { name: /Cuándo/ })).getByLabelText("configurado")).toBeTruthy();
  });
});

describe("el nodo GraphQL", () => {
  test("URL, operationName, estado, variables y banderas", () => {
    const view = renderInspector({ steps: [{ id: "graphql", kind: "graphql" }], selected: "graphql" });
    const at = () => view.last()[0]!.graphql!;

    fireEvent.change(field("URL"), { target: { value: "https://api.example.com/graphql" } });
    fireEvent.change(field("operationName"), { target: { value: "1mal" } });
    expect(screen.getByText(/Un operationName solo lleva letras/)).toBeTruthy();
    fireEvent.change(field("operationName"), { target: { value: "Widget" } });
    expect(screen.queryByText(/Un operationName solo lleva letras/)).toBeNull();
    expect(screen.getByText("Widget · https://api.example.com/graphql · graphql")).toBeTruthy();
    fireEvent.change(field("operationName"), { target: { value: "" } });
    expect(at().operationName).toBeUndefined();

    fireEvent.change(field("Estado esperado"), { target: { value: "200" } });
    expect(at().expectedStatus).toBe(200);
    fireEvent.change(field("Estado esperado"), { target: { value: "" } });
    expect(at().expectedStatus).toBeUndefined();

    fireEvent.change(field<HTMLTextAreaElement>("Query"), { target: { value: "query Widget { widget { id } }" } });
    expect(at().query).toBe("query Widget { widget { id } }");
    fireEvent.change(field<HTMLTextAreaElement>("Variables (JSON)"), { target: { value: "[1]" } });
    expect(screen.getByText("Las variables tienen que ser un objeto JSON.")).toBeTruthy();
    fireEvent.change(field<HTMLTextAreaElement>("Variables (JSON)"), { target: { value: "" } });
    expect(at().variables).toBeUndefined();

    fireEvent.click(screen.getByRole("checkbox", { name: /Enviar sesión del login/ }));
    expect(screen.getByText(/La credencial obtenida en el login viajará/)).toBeTruthy();
    fireEvent.click(screen.getByRole("checkbox", { name: /Admitir errors en la respuesta/ }));
    expect(at().allowErrors).toBe(true);
    fireEvent.click(screen.getByRole("checkbox", { name: /Admitir errors en la respuesta/ }));
    expect(at().allowErrors).toBeUndefined();

    fireEvent.change(screen.getByLabelText("Tipo de autenticación"), { target: { value: "bearer" } });
    expect(at().auth!.type).toBe("bearer");
    fireEvent.change(screen.getByLabelText("Tipo de autenticación"), { target: { value: "inherit" } });
    expect(at().auth).toBeUndefined();

    fireEvent.change(screen.getByLabelText("Nombre de cabeceras"), { target: { value: "X-Api" } });
    expect(at().headers).toEqual({ "X-Api": "" });
    fireEvent.click(screen.getByLabelText("Eliminar X-Api"));
    expect(at().headers).toBeUndefined();

    // Las demás pestañas del nodo.
    openTab(/Capturas/);
    fireEvent.click(within(visiblePanel()).getByRole("button", { name: "+ Captura" }));
    expect(view.last()[0]!.captures).toHaveLength(1);
    openTab(/Si falla/);
    fireEvent.change(field<HTMLSelectElement>("Si este paso falla"), { target: { value: "continue" } });
    expect(view.last()[0]!.onError).toBe("continue");
  });
});

describe("el mock", () => {
  test("estado, retardo, cabeceras y un body que no es el JSON prometido", () => {
    const view = renderInspector({ steps: [{ id: "mock", kind: "mock" }], selected: "mock" });
    const at = () => view.last()[0]!.mock!;
    expect(screen.getByText("200 · mock")).toBeTruthy();

    fireEvent.change(field("Estado"), { target: { value: "201" } });
    expect(at().status).toBe(201);
    fireEvent.change(field("Retardo (ms)"), { target: { value: "150" } });
    expect(at().delayMs).toBe(150);
    fireEvent.change(field("Retardo (ms)"), { target: { value: "" } });
    expect(at().delayMs).toBeUndefined();

    fireEvent.change(screen.getByLabelText("Nombre de cabeceras"), { target: { value: "Content-Type" } });
    fireEvent.change(screen.getByLabelText("Valor de Content-Type"), { target: { value: "application/json" } });
    expect(at().headers).toEqual({ "Content-Type": "application/json" });

    fireEvent.change(screen.getByLabelText("Body simulado"), { target: { value: "no es json" } });
    expect(screen.getByText(/el body no es JSON válido/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Body simulado"), { target: { value: '{"data":{"id":"{{thingId}}"}}' } });
    expect(screen.queryByText(/el body no es JSON válido/)).toBeNull();

    // Las capturas se sugieren desde su propio body.
    openTab(/Capturas/);
    fireEvent.click(screen.getByText("Sugerir capturas desde la respuesta"));
    fireEvent.click(screen.getByText("Usar última respuesta"));
    fireEvent.click(screen.getByTitle("data.id"));
    expect(view.last()[0]!.captures).toEqual([expect.objectContaining({ from: "body", path: "data.id" })]);
    // Lo ya capturado deja de ofrecerse.
    expect(screen.getByText("Nada nuevo que capturar en esta respuesta.")).toBeTruthy();

    fireEvent.change(screen.getByLabelText("Body simulado"), { target: { value: "" } });
    expect(at().body).toBeUndefined();
  });
});

describe("la notificación", () => {
  const env = (variables: Record<string, { value: string; sensitive: boolean }>) =>
    ({
      id: "env1",
      name: "Staging",
      baseUrl: "https://x",
      specUrl: null,
      variables,
      disabledVariables: {},
      writesAllowed: true,
      authEnforced: false,
      active: true,
      credentials: [],
    }) as unknown as Environment;

  test("canal, variable del entorno con la URL, mensaje y fallar si no llega", () => {
    const view = renderInspector({
      steps: [{ id: "notificar", kind: "notify" }],
      selected: "notificar",
      environments: [env({ SLACK_WEBHOOK_URL: { value: "https://hooks", sensitive: false }, SECRET_HOOK: { value: "x", sensitive: true } })],
      environmentId: "env1",
    });
    const at = () => view.last()[0]!.notify!;
    expect(screen.getByText(/Incoming webhook de Slack/)).toBeTruthy();
    fireEvent.change(field<HTMLSelectElement>("Canal"), { target: { value: "teams" } });
    expect(at().channel).toBe("teams");
    expect(screen.getByText(/Webhook entrante de Teams/)).toBeTruthy();

    // El datalist ofrece las variables del entorno, marcando las sensibles.
    const options = [...document.querySelectorAll("#notify-url-notificar option")].map((option) => option.getAttribute("value"));
    expect(options).toEqual(["SECRET_HOOK", "SLACK_WEBHOOK_URL"]);

    fireEvent.change(field("Variable del entorno con la URL"), { target: { value: " NO_EXISTE " } });
    expect(at().urlVariable).toBe("NO_EXISTE");
    expect(screen.getByText(/El entorno elegido no define «NO_EXISTE»/)).toBeTruthy();
    fireEvent.change(field("Variable del entorno con la URL"), { target: { value: "SLACK_WEBHOOK_URL" } });
    expect(screen.getByText(/no está marcada como sensible/)).toBeTruthy();
    fireEvent.change(field("Variable del entorno con la URL"), { target: { value: "SECRET_HOOK" } });
    expect(screen.queryByText(/no está marcada como sensible/)).toBeNull();

    fireEvent.change(screen.getByRole("textbox", { name: "Mensaje" }), { target: { value: "Pedido creado" } });
    expect(at().message).toBe("Pedido creado");

    fireEvent.click(screen.getByRole("checkbox", { name: /Fallar el nodo si el mensaje no llega/ }));
    expect(at().onError).toBe("fail");
    fireEvent.click(screen.getByRole("checkbox", { name: /Fallar el nodo si el mensaje no llega/ }));
    expect(at().onError).toBe("continue");
  });
});

describe("el canal sin canales en el proyecto", () => {
  test("dice dónde crearlos", () => {
    renderInspector({ steps: [{ id: "canal", kind: "channel" }], selected: "canal", channels: [] });
    expect(screen.getByText(/El proyecto no tiene canales/)).toBeTruthy();
    expect([...field<HTMLSelectElement>("Canal").options].map((option) => option.value)).toEqual([""]);
  });
});

describe("el sub-flujo", () => {
  const flow = (patch: Partial<WorkflowView>): WorkflowView => ({
    id: "f",
    name: "Hijo",
    description: null,
    status: "draft",
    steps: [],
    updatedAt: "2026-01-01T00:00:00Z",
    ...patch,
  });
  const FLOWS = [
    flow({ id: "w1", name: "Este" }),
    flow({
      id: "hijo",
      name: "Crear cosa",
      steps: [
        { id: "crear", requestTemplateId: "t", captures: [{ variable: "thingId", from: "body", path: "data.id" }] },
        { id: "v", kind: "set", set: { assignments: [{ variable: "total", value: "1" }] } },
      ],
    }),
    flow({ id: "viejo", name: "Viejo", status: "archived" }),
    flow({ id: "ciclo", name: "Vuelve", steps: [{ id: "s", kind: "subflow", subflow: { workflowId: "w1" } }] }),
  ];
  const node = (subflow?: WorkflowStepView["subflow"]): WorkflowStepView => ({ id: "subflujo", kind: "subflow", subflow });

  test("elige el flujo entre los que se pueden ejecutar y dice cuántos pasos tiene", () => {
    const view = renderInspector({ steps: [node()], selected: "subflujo", flows: FLOWS });
    expect(screen.getByText("Elige el flujo que se ejecutará en este punto.")).toBeTruthy();
    const select = field<HTMLSelectElement>("Ejecuta el flujo");
    const labels = [...select.options].map((option) => [option.textContent, option.disabled]);
    expect(labels).toEqual([
      ["Elige un flujo", false],
      ["Crear cosa", false],
      ["Viejo (archivado)", true],
      ["Vuelve (ya ejecuta este flujo)", true],
    ]);
    fireEvent.change(select, { target: { value: "hijo" } });
    expect(view.last()[0]!.subflow).toEqual({ workflowId: "hijo" });
    expect(screen.getByText(/^2 pasos\./)).toBeTruthy();
  });

  test.each([
    ["viejo", /Ese flujo está archivado/],
    ["ciclo", /juntos formarían un ciclo/],
    ["borrado", /Ese flujo ya no está en el proyecto/],
  ])("un flujo %s ya elegido se explica", (workflowId, text) => {
    renderInspector({ steps: [node({ workflowId })], selected: "subflujo", flows: FLOWS });
    expect(screen.getByText(text)).toBeTruthy();
  });

  test("entradas y salidas, con las variables que el hijo escribe como atajo", () => {
    const view = renderInspector({ steps: [node({ workflowId: "hijo" })], selected: "subflujo", flows: FLOWS });
    const at = () => view.last()[0]!.subflow!;

    openTab(/Entradas/);
    fireEvent.click(screen.getByRole("button", { name: "+ Entrada" }));
    fireEvent.change(screen.getByLabelText("Variable del hijo"), { target: { value: "entityName" } });
    fireEvent.change(within(visiblePanel()).getByLabelText("Valor"), { target: { value: "{{nombre}}" } });
    expect(at().inputs).toEqual([{ variable: "entityName", value: "{{nombre}}" }]);
    fireEvent.click(screen.getByRole("button", { name: "Quitar entrada" }));
    expect(at().inputs).toEqual([]);

    openTab(/Salidas/);
    fireEvent.click(screen.getByRole("button", { name: "+ thingId" }));
    expect(at().outputs).toEqual(["thingId"]);
    // Lo ya pedido deja de ofrecerse.
    expect(screen.queryByRole("button", { name: "+ thingId" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "+ Salida" }));
    const inputs = screen.getAllByLabelText("Variable devuelta");
    fireEvent.change(inputs[1]!, { target: { value: "otra" } });
    expect(at().outputs).toEqual(["thingId", "otra"]);
    fireEvent.click(screen.getAllByRole("button", { name: "Quitar salida" })[0]!);
    expect(at().outputs).toEqual(["otra"]);
  });
});
