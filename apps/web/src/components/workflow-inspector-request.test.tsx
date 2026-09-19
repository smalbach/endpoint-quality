/**
 * El nodo de petición guardada: lo que más se edita del inspector.
 *
 * Lo que decide algo:
 *
 * - **Una petición compartida avisa y se separa**: con varios nodos usándola se ofrece la copia
 *   privada, y cambiar la operación crea esa copia en vez de arrastrar a los demás.
 * - **Lo de la petición va a la plantilla; lo del paso, al paso**: nombre, estado, auth, parámetros y
 *   cabeceras salen por `onTemplate`; capturas, comprobaciones, «Cuándo» y «Si falla», por `onSteps`.
 * - **Las capturas se sugieren desde una respuesta real**: la del envío de prueba o una pegada, y lo
 *   ya capturado deja de ofrecerse.
 * - **«Cuándo» solo ofrece los pasos de los que depende**, y sin ninguno lo dice.
 * - **Un paso que apunta a una prueba borrada lo dice** en lugar de enseñar un formulario vacío.
 */
import { describe, expect, test, vi } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";

import { field, openTab, renderInspector, visiblePanel } from "@/test/workflow-inspector-harness";
import type { Environment, RequestTemplateView, WorkflowStepView } from "@/lib/types";

const call = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", async (original) => ({ ...(await original<object>()), api: call }));

const template = (patch: Partial<RequestTemplateView> = {}): RequestTemplateView => ({
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
  ...patch,
});

const OPERATIONS = [
  { id: "op1", method: "POST", path: "/things", summary: "" },
  { id: "op2", method: "GET", path: "/things/{id}", summary: "" },
];

const ENV = {
  id: "env1",
  name: "Staging",
  baseUrl: "https://x",
  specUrl: null,
  variables: {},
  disabledVariables: {},
  writesAllowed: true,
  authEnforced: false,
  active: true,
  credentials: [],
} as unknown as Environment;

const step = (patch: Partial<WorkflowStepView> = {}): WorkflowStepView => ({ id: "crear", requestTemplateId: "t1", ...patch });

describe("la pestaña «Petición»", () => {
  test("edita la plantilla: operación, nombre, estado, auth, parámetros y cabeceras", () => {
    const view = renderInspector({
      steps: [step()],
      selected: "crear",
      templates: [template()],
      operations: OPERATIONS,
    });
    expect(screen.getByText("Crear cosa")).toBeTruthy();
    expect(screen.getByText("POST /things · crear")).toBeTruthy();
    // Solo la usa este nodo: no hay aviso de compartida.
    expect(screen.queryByRole("button", { name: "Hacer independiente este nodo" })).toBeNull();

    fireEvent.change(field<HTMLSelectElement>("Operación"), { target: { value: "op2" } });
    expect(view.onTemplate).toHaveBeenLastCalledWith(expect.objectContaining({ operationId: "op2" }));
    fireEvent.change(field("Nombre"), { target: { value: "Leer cosa" } });
    fireEvent.change(field("Estado"), { target: { value: "200" } });
    fireEvent.change(field<HTMLSelectElement>("Auth"), { target: { value: "none" } });
    expect(view.onTemplate).toHaveBeenLastCalledWith(
      expect.objectContaining({ name: "Leer cosa", expectedStatus: 200, auth: "none", operationId: "op2" }),
    );

    fireEvent.change(screen.getByLabelText("Nombre de parámetros"), { target: { value: "id" } });
    fireEvent.change(screen.getByLabelText("Valor de id"), { target: { value: "{{thingId}}" } });
    expect(view.onTemplate).toHaveBeenLastCalledWith(
      expect.objectContaining({ parameters: { id: "{{thingId}}" }, disabledParameters: {} }),
    );
    fireEvent.change(screen.getByLabelText("Nombre de cabeceras"), { target: { value: "X-Tenant" } });
    fireEvent.click(screen.getByLabelText("Enviar X-Tenant"));
    expect(view.onTemplate).toHaveBeenLastCalledWith(
      expect.objectContaining({ headers: {}, disabledHeaders: { "X-Tenant": "" } }),
    );
    // La pestaña cuenta parámetros y cabeceras enviados.
    expect(screen.getByRole("tab", { name: /Petición/ }).textContent).toBe("Petición1");
    expect(view.onSteps).not.toHaveBeenCalled();
  });

  test("compartida por varios nodos: avisa, separa, y cambiar la operación crea la copia", () => {
    const view = renderInspector({
      steps: [step()],
      selected: "crear",
      templates: [template()],
      operations: OPERATIONS,
      templateUsage: () => 3,
    });
    expect(screen.getByText("3 nodos")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Hacer independiente este nodo" }));
    expect(view.onFork).toHaveBeenLastCalledWith(expect.objectContaining({ id: "crear" }), undefined);

    fireEvent.change(field<HTMLSelectElement>("Operación"), { target: { value: "op2" } });
    expect(view.onFork).toHaveBeenLastCalledWith(expect.objectContaining({ id: "crear" }), { operationId: "op2" });
    expect(view.onTemplate).not.toHaveBeenCalled();
  });

  test("mientras se crea la copia el botón lo dice y la operación no se toca", () => {
    renderInspector({
      steps: [step()],
      selected: "crear",
      templates: [template()],
      operations: OPERATIONS,
      templateUsage: () => 2,
      forking: true,
    });
    expect((screen.getByRole("button", { name: "Creando copia…" }) as HTMLButtonElement).disabled).toBe(true);
    expect(field<HTMLSelectElement>("Operación").disabled).toBe(true);
  });

  test("un paso cuya prueba ya no existe lo dice y no ofrece body", () => {
    renderInspector({ steps: [step()], selected: "crear", templates: [] });
    expect(screen.getByText(/apunta a una prueba que ya no existe/)).toBeTruthy();
    expect(screen.getByText("Prueba reutilizable")).toBeTruthy();
    expect(screen.queryByRole("tab", { name: /Body/ })).toBeNull();
  });

  test("un login se presenta como login", () => {
    renderInspector({ steps: [step({ kind: "login" })], selected: "crear", templates: [template()] });
    openTab("Ayuda");
    expect(within(visiblePanel()).getByText(/Qué hace/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Eliminar paso" })).toBeTruthy();
  });
});

describe("la pestaña «Body» y las capturas sugeridas", () => {
  test("un body configurado lleva la marca, y la respuesta del envío de prueba sugiere capturas", async () => {
    call.mockResolvedValue({
      ok: true,
      failure: null,
      request: { method: "POST", url: "https://x/things", headers: {}, body: null },
      expected: { status: 201, shape: "", operationPath: "/things" },
      response: {
        status: 201,
        contentType: "application/json",
        headers: {},
        body: { data: { id: "abc", token: "t" } },
        sizeBytes: 10,
      },
      assertions: [],
      latency: { samples: [], budgetMs: null },
      durationMs: 12,
    });
    const view = renderInspector({
      steps: [step()],
      selected: "crear",
      templates: [template({ body: { type: "json", json: { a: 1 } } })],
      environments: [ENV],
      environmentId: "env1",
    });
    expect(within(screen.getByRole("tab", { name: /Body/ })).getByLabelText("configurado")).toBeTruthy();
    openTab(/Body/);
    fireEvent.click(within(visiblePanel()).getByRole("button", { name: "Enviar" }));
    await waitFor(() => expect(call).toHaveBeenCalledWith("/orgs/o/projects/p/request-preview", expect.anything()));

    openTab(/Capturas/);
    fireEvent.click(screen.getByText("Sugerir capturas desde la respuesta"));
    await waitFor(() => expect((screen.getByText("Usar última respuesta") as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByText("Usar última respuesta"));
    fireEvent.click(screen.getByTitle("data.token"));
    expect(view.last()[0]!.captures).toEqual([expect.objectContaining({ from: "body", path: "data.token" })]);
    // El resto se sigue ofreciendo; lo capturado no.
    expect(screen.queryByTitle("data.token")).toBeNull();
    expect(screen.getByTitle("data.id")).toBeTruthy();
    fireEvent.click(screen.getByText("Ocultar sugerencias"));
    expect(screen.queryByTitle("data.id")).toBeNull();
  });
});

describe("la pestaña «Capturas»", () => {
  test("añade, edita, sugiere desde una respuesta pegada y quita capturas", () => {
    const view = renderInspector({ steps: [step()], selected: "crear", templates: [template()] });
    openTab(/Capturas/);
    const panel = visiblePanel();
    fireEvent.click(within(panel).getByRole("button", { name: "+ Captura" }));
    fireEvent.change(screen.getByLabelText("Variable capturada"), { target: { value: "reqId" } });
    fireEvent.change(screen.getByLabelText("Origen de la captura"), { target: { value: "header" } });
    expect((screen.getByLabelText("Ruta de captura") as HTMLInputElement).placeholder).toBe("X-Request-Id");
    fireEvent.change(screen.getByLabelText("Ruta de captura"), { target: { value: "X-Request-Id" } });
    expect(view.last()[0]!.captures).toEqual([{ variable: "reqId", from: "header", path: "X-Request-Id" }]);

    fireEvent.click(screen.getByText("Sugerir capturas desde la respuesta"));
    // Sin envío de prueba no hay última respuesta que usar.
    expect((screen.getByText("Usar última respuesta") as HTMLButtonElement).disabled).toBe(true);
    const box = screen.getByPlaceholderText(/"data": \{ "id": 1/);
    fireEvent.change(box, { target: { value: "{mal" } });
    expect(screen.getByText("No es JSON válido.")).toBeTruthy();
    fireEvent.change(box, { target: { value: '{"id": 7}' } });
    fireEvent.click(screen.getByTitle("id"));
    expect(view.last()[0]!.captures).toHaveLength(2);

    fireEvent.click(screen.getAllByRole("button", { name: "Eliminar captura" })[0]!);
    expect(view.last()[0]!.captures).toEqual([expect.objectContaining({ path: "id" })]);
    expect(screen.getByRole("tab", { name: /Capturas/ }).textContent).toBe("Capturas1");
  });

  test("el paso que inicia sesión dice de dónde sale el token y cómo se presenta", () => {
    const view = renderInspector({ steps: [step()], selected: "crear", templates: [template()] });
    openTab(/Capturas/);
    fireEvent.click(screen.getByRole("checkbox", { name: /Este paso inicia sesión/ }));
    fireEvent.change(screen.getByLabelText("De dónde sale el token"), { target: { value: "cookie" } });
    fireEvent.change(screen.getByLabelText("Ruta del token"), { target: { value: "session" } });
    fireEvent.change(field("Cabecera"), { target: { value: "X-Auth" } });
    fireEvent.change(field("Prefijo"), { target: { value: "" } });
    expect(view.last()[0]!.authorizes).toEqual({ from: "cookie", path: "session", header: "X-Auth", scheme: "" });
    fireEvent.change(field("Cabecera"), { target: { value: "" } });
    expect(view.last()[0]!.authorizes!.header).toBeUndefined();
    fireEvent.click(screen.getByRole("checkbox", { name: /Este paso inicia sesión/ }));
    expect(view.last()[0]!.authorizes).toBeUndefined();
  });
});

describe("la pestaña «Comprobaciones»", () => {
  test("origen, ruta, operador, valor, aviso y borrar la última deja el campo ausente", () => {
    const view = renderInspector({ steps: [step()], selected: "crear", templates: [template()] });
    openTab(/Comprobaciones/);
    fireEvent.click(screen.getByRole("button", { name: "+ Comprobación" }));
    // Con status la ruta no se usa.
    expect((screen.getByLabelText("Ruta o cabecera") as HTMLInputElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Origen"), { target: { value: "header" } });
    expect((screen.getByLabelText("Ruta o cabecera") as HTMLInputElement).placeholder).toBe("X-Total-Count");
    fireEvent.change(screen.getByLabelText("Ruta o cabecera"), { target: { value: "X-Total-Count" } });
    fireEvent.change(screen.getByLabelText("Operador"), { target: { value: "greater_than" } });
    fireEvent.change(screen.getByLabelText("Valor esperado"), { target: { value: "0" } });
    fireEvent.click(screen.getByRole("checkbox", { name: /Solo aviso/ }));
    expect(view.last()[0]!.checks).toEqual([
      { source: "header", operator: "greater_than", value: "0", path: "X-Total-Count", severity: "warning" },
    ]);

    fireEvent.change(screen.getByLabelText("Operador"), { target: { value: "is_not_empty" } });
    expect(screen.queryByLabelText("Valor esperado")).toBeNull();
    fireEvent.click(screen.getByRole("checkbox", { name: /Solo aviso/ }));
    expect(view.last()[0]!.checks![0]!.severity).toBeUndefined();

    fireEvent.click(screen.getByRole("button", { name: "Eliminar comprobación" }));
    expect(view.last()[0]!.checks).toBeUndefined();
  });
});

describe("la pestaña «Cuándo»", () => {
  const deps: WorkflowStepView[] = [
    { id: "a", requestTemplateId: "t1" },
    { id: "b", requestTemplateId: "t1" },
  ];

  test("sin dependencias pide conectarlo; la espera 0 vuelve a ausente", () => {
    const view = renderInspector({ steps: [step({ waitMs: 200 })], selected: "crear", templates: [template()] });
    openTab(/Cuándo/);
    expect(within(visiblePanel()).getByText(/Conecta este paso a otro para poder condicionarlo/)).toBeTruthy();
    expect(screen.queryByText("Empieza cuando")).toBeNull();
    fireEvent.change(field("Esperar antes (ms)"), { target: { value: "0" } });
    expect(view.last()[0]!.waitMs).toBeUndefined();
  });

  test("con varias dependencias: todas o cualquiera, «Solo si…» y «Una vez por elemento de…»", () => {
    const view = renderInspector({
      steps: [...deps, step({ dependsOn: ["a", "b"] })],
      selected: "crear",
      templates: [template()],
    });
    const at = () => view.last()[2]!;
    openTab(/Cuándo/);
    fireEvent.change(field<HTMLSelectElement>("Empieza cuando"), { target: { value: "any" } });
    expect(at().waits).toBe("any");
    fireEvent.change(field<HTMLSelectElement>("Empieza cuando"), { target: { value: "all" } });
    expect(at().waits).toBeUndefined();

    fireEvent.click(screen.getByRole("checkbox", { name: /Solo si…/ }));
    expect(at().runIf).toEqual({ from: "a", check: { source: "status", operator: "equals", value: "200" } });
    fireEvent.change(field<HTMLSelectElement>("Del paso"), { target: { value: "b" } });
    fireEvent.change(field<HTMLSelectElement>("Origen"), { target: { value: "body" } });
    fireEvent.change(screen.getByLabelText("Ruta de la condición"), { target: { value: "data.ok" } });
    fireEvent.change(screen.getByLabelText("Operador de la condición"), { target: { value: "not_equals" } });
    fireEvent.change(screen.getByLabelText("Valor de la condición"), { target: { value: "false" } });
    expect(at().runIf).toEqual({
      from: "b",
      check: { source: "body", operator: "not_equals", value: "false", path: "data.ok" },
    });
    fireEvent.change(screen.getByLabelText("Operador de la condición"), { target: { value: "not_exists" } });
    expect(screen.queryByLabelText("Valor de la condición")).toBeNull();
    fireEvent.click(screen.getByRole("checkbox", { name: /Solo si…/ }));
    expect(at().runIf).toBeUndefined();

    fireEvent.click(screen.getByRole("checkbox", { name: /Una vez por elemento de…/ }));
    expect(at().forEach).toEqual({ from: "a", path: "data", as: "item", max: 50 });
    fireEvent.change(field<HTMLSelectElement>("Lista del paso"), { target: { value: "b" } });
    fireEvent.change(field("Ruta"), { target: { value: "data.items" } });
    fireEvent.change(field("Se llama"), { target: { value: "cosa" } });
    fireEvent.change(field("Como mucho"), { target: { value: "10" } });
    expect(at().forEach).toEqual({ from: "b", path: "data.items", as: "cosa", max: 10 });
    fireEvent.click(screen.getByRole("checkbox", { name: /Una vez por elemento de…/ }));
    expect(at().forEach).toBeUndefined();
  });
});

describe("sin permiso de edición", () => {
  test("todo se ve y nada se ofrece para cambiar", () => {
    renderInspector({
      steps: [
        step({
          captures: [{ variable: "id", from: "body", path: "data.id" }],
          checks: [{ source: "status", operator: "equals", value: "201" }],
          retry: { attempts: 1, delayMs: 100 },
        }),
      ],
      selected: "crear",
      templates: [template()],
      templateUsage: () => 2,
      canEdit: false,
    });
    expect(screen.queryByRole("button", { name: "Hacer independiente este nodo" })).toBeNull();
    expect(field("Nombre").disabled).toBe(true);
    openTab(/Capturas/);
    expect(screen.queryByRole("button", { name: "Eliminar captura" })).toBeNull();
    expect(screen.queryByText("Sugerir capturas desde la respuesta")).toBeNull();
    openTab(/Comprobaciones/);
    expect(screen.queryByRole("button", { name: "+ Comprobación" })).toBeNull();
    openTab(/Si falla/);
    // El factor ausente se enseña como 1.
    expect(field("Factor").value).toBe("1");
    expect(within(screen.getByRole("tab", { name: /Si falla/ })).getByLabelText("configurado")).toBeTruthy();
  });
});
