/**
 * El lienzo del flujo: cada tipo de nodo con su forma, la corrida en vivo sobre él, y todo lo que
 * se cambia desde él —paleta, arrastrar al lienzo, menú contextual, conectar, cortar y mover—.
 *
 * Lo que se comprueba: que cada tipo de nodo dice lo que tiene configurado (o lo que le falta), que
 * una corrida vigilada tiñe los nodos, cuenta las esperas y enseña los reintentos, que la pausa y los
 * puntos de parada se dibujan, y que cada acción del lienzo acaba en `onChange`/`onSelect` con el
 * documento que tocaba. Sin `onAddRequest` el lienzo es solo de lectura: ni paleta ni menú.
 *
 * React Flow en jsdom necesita que le demos tamaños: `ResizeObserver`, `DOMMatrixReadOnly` y los
 * `offsetWidth/offsetHeight` se sustituyen aquí, como en la receta de pruebas de React Flow.
 */
import { beforeAll, describe, expect, test, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

import { WorkflowCanvas } from "@/components/workflow-canvas";
import type { OperationSummary, RetryNote } from "@/lib/workflow-draft";
import type { CaseStatus, ChannelView, RequestTemplateView, WorkflowStepView } from "@/lib/types";

beforeAll(() => {
  class ResizeObserverStub {
    constructor(private readonly callback: ResizeObserverCallback) {}
    observe(target: Element) {
      // Después del render: los hijos se observan antes de que React Flow sepa cuál es su lienzo.
      const box = { width: 200, height: 100 };
      setTimeout(() =>
        this.callback(
          [{ target, contentRect: box, borderBoxSize: [{ inlineSize: 200, blockSize: 100 }] } as unknown as ResizeObserverEntry],
          this as unknown as ResizeObserver,
        ),
      );
    }
    unobserve() {}
    disconnect() {}
  }
  class DOMMatrixReadOnlyStub {
    m22: number;
    constructor(transform?: string) {
      const scale = transform?.match(/scale\(([1-9.]+)\)/)?.[1];
      this.m22 = scale !== undefined ? Number(scale) : 1;
    }
  }
  vi.stubGlobal("ResizeObserver", ResizeObserverStub);
  vi.stubGlobal("DOMMatrixReadOnly", DOMMatrixReadOnlyStub);
  Object.defineProperties(HTMLElement.prototype, {
    offsetHeight: { configurable: true, get: () => 100 },
    offsetWidth: { configurable: true, get: () => 200 },
  });
  (SVGElement.prototype as unknown as { getBBox: () => DOMRect }).getBBox = () =>
    ({ x: 0, y: 0, width: 10, height: 10 }) as DOMRect;
});

type Check = NonNullable<WorkflowStepView["checks"]>[number];
const check: Check = { source: "status", operator: "equals", value: "200" } as Check;

const TEMPLATES = [
  { id: "t-login", name: "Iniciar sesión", operationId: "op-login", expectedStatus: 200 },
  { id: "t-list", name: "Listar pedidos", operationId: "op-list", expectedStatus: 200 },
  { id: "t-lost", name: "Sin operación", operationId: "op-gone", expectedStatus: 204 },
] as RequestTemplateView[];
const OPERATIONS: OperationSummary[] = [
  { id: "op-login", method: "POST", path: "/auth/login", summary: "" },
  { id: "op-list", method: "GET", path: "/orders", summary: "" },
];

/** Un flujo con un nodo de cada tipo, todos configurados. */
const FULL: WorkflowStepView[] = [
  { id: "login", kind: "login", requestTemplateId: "t-login", authorizes: { from: "body", path: "token" } as never, position: { x: 0, y: 0 } },
  {
    id: "list",
    requestTemplateId: "t-list",
    dependsOn: ["login"],
    captures: [{ variable: "id" } as never],
    checks: [check, check],
    retry: { attempts: 3 } as never,
    forEach: { from: "login", path: "data", as: "x" },
    position: { x: 300, y: 0 },
  },
  { id: "lost", requestTemplateId: "t-lost", position: { x: 600, y: 0 } },
  { id: "rama", kind: "branch", condition: { from: "list", check }, dependsOn: ["list"], position: { x: 0, y: 200 } },
  { id: "espera", kind: "wait", waitMs: 2000, position: { x: 300, y: 200 } },
  { id: "union", kind: "merge", dependsOn: ["rama", "espera"], waits: "any", position: { x: 600, y: 200 } },
  { id: "valida", kind: "validate", validate: { from: "list", script: "pm.test()" }, checks: [check, check], position: { x: 0, y: 400 } },
  {
    id: "fetch",
    kind: "fetch",
    fetch: { method: "POST", url: "https://otra.api/x", useSession: true },
    captures: [{ variable: "a" } as never],
    checks: [check],
    position: { x: 300, y: 400 },
  },
  { id: "variables", kind: "set", set: { assignments: [{ variable: "token", value: "1" }, { variable: "id", value: "2" }] }, position: { x: 600, y: 400 } },
  { id: "script", kind: "script", script: { code: "a\nb\nc", from: "list" }, position: { x: 0, y: 600 } },
  { id: "reintento", kind: "retry", rerun: { from: "list", target: "login", attempts: 4, delayMs: 500 }, position: { x: 300, y: 600 } },
  { id: "sondeo", kind: "poll", poll: { from: "list", attempts: 5, delayMs: 250 }, checks: [check], position: { x: 600, y: 600 } },
  { id: "bucle", kind: "loop", loop: { from: "list", path: "items", as: "item", max: 10 }, position: { x: 0, y: 800 } },
  { id: "hijo", kind: "wait", waitMs: 5, inLoop: "bucle", dependsOn: ["bucle"], position: { x: 300, y: 800 } },
  { id: "esquema", kind: "schema", schema: { from: "list", source: "contract", strict: true }, position: { x: 600, y: 800 } },
  {
    id: "notificar",
    kind: "notify",
    notify: { channel: "slack", urlVariable: "SLACK_URL", message: "Hola equipo", onError: "fail" },
    position: { x: 0, y: 1000 },
  },
  {
    id: "subflujo",
    kind: "subflow",
    subflow: { workflowId: "wf-2", inputs: [{ variable: "a", value: "1" }], outputs: ["b", "c"] },
    position: { x: 300, y: 1000 },
  },
  {
    id: "graphql",
    kind: "graphql",
    graphql: { url: "https://gql/x", query: "{ a }", operationName: "Pedidos", useSession: true, allowErrors: true } as never,
    captures: [{ variable: "a" } as never],
    checks: [check],
    position: { x: 600, y: 1000 },
  },
  { id: "canal", kind: "channel", channel: { channelId: "ch-1", messages: [{} as never, {} as never] }, captures: [{ variable: "m" } as never], position: { x: 0, y: 1200 } },
  { id: "mock", kind: "mock", mock: { status: 201, delayMs: 50 }, captures: [{ variable: "a" } as never], checks: [check], position: { x: 300, y: 1200 } },
];

/** El mismo repertorio, sin configurar: cada nodo dice lo que le falta. */
const EMPTY: WorkflowStepView[] = [
  { id: "rama", kind: "branch" },
  { id: "valida", kind: "validate" },
  { id: "fetch", kind: "fetch" },
  { id: "variables", kind: "set" },
  { id: "script", kind: "script" },
  { id: "reintento", kind: "retry" },
  { id: "sondeo", kind: "poll" },
  { id: "bucle", kind: "loop" },
  { id: "esquema", kind: "schema" },
  { id: "notificar", kind: "notify", notify: { channel: "teams", urlVariable: "", message: "" } },
  { id: "subflujo", kind: "subflow", subflow: { workflowId: "", inputs: [{ variable: "a", value: "" }], outputs: ["b"] } },
  { id: "graphql", kind: "graphql" },
  { id: "canal", kind: "channel" },
  { id: "canal-2", kind: "channel", channel: { channelId: "ch" } },
  { id: "canal-3", kind: "channel", channel: { channelId: "ch", messages: [] } },
  { id: "mock", kind: "mock" },
  { id: "union", kind: "merge", dependsOn: ["rama"] },
  { id: "script-2", kind: "script", script: { code: "uno" } },
  { id: "bucle-2", kind: "loop", loop: { from: "x", path: "data", as: "item" } },
  { id: "hijo", kind: "wait", inLoop: "bucle-2", dependsOn: ["bucle-2"] },
  { id: "hijo-2", kind: "wait", inLoop: "bucle-2", dependsOn: ["bucle-2"] },
  { id: "huerfano", requestTemplateId: "t-borrada" },
  { id: "login", kind: "login" },
];

type Props = Partial<Parameters<typeof WorkflowCanvas>[0]>;

function mount(steps: WorkflowStepView[], props: Props = {}) {
  const onChange = vi.fn();
  const onSelect = vi.fn();
  const onAddRequest = vi.fn();
  const onAddLogin = vi.fn();
  const all = { steps, templates: TEMPLATES, operations: OPERATIONS, onChange, onSelect, onAddRequest, onAddLogin, ...props };
  const view = render(
    <div style={{ width: 1200, height: 800 }}>
      <WorkflowCanvas {...all} />
    </div>,
  );
  const rerender = (next: Props) =>
    view.rerender(
      <div style={{ width: 1200, height: 800 }}>
        <WorkflowCanvas {...all} {...next} />
      </div>,
    );
  return { onChange, onSelect, onAddRequest, onAddLogin, rerender, container: view.container };
}

const nodeEl = (id: string) => document.querySelector(`.react-flow__node[data-id="${id}"]`) as HTMLElement;
const lastSteps = (onChange: ReturnType<typeof vi.fn>) => onChange.mock.calls.at(-1)![0] as WorkflowStepView[];

/** Lo que lleva un arrastre de la paleta; jsdom no tiene `DataTransfer`. */
function transfer(kind?: string) {
  const data = new Map<string, string>(kind ? [["application/x-eq-node-kind", kind]] : []);
  return {
    types: [...data.keys()],
    getData: (type: string) => data.get(type) ?? "",
    setData: (type: string, value: string) => data.set(type, value),
    dropEffect: "none",
    effectAllowed: "all",
  };
}

describe("cada nodo con su forma", () => {
  test("un flujo configurado: cada tipo dice lo que tiene", async () => {
    mount(FULL);
    await waitFor(() => expect(nodeEl("login")).toBeTruthy());

    // Petición y login, con su operación.
    const login = nodeEl("login");
    expect(within(login).getByText("Iniciar sesión")).toBeTruthy();
    expect(within(login).getByText("POST")).toBeTruthy();
    expect(within(login).getByText("Reescribe la credencial de los siguientes")).toBeTruthy();
    const list = nodeEl("list");
    expect(within(list).getByText("/orders")).toBeTruthy();
    expect(within(list).getByText("espera 200")).toBeTruthy();
    expect(within(list).getByTitle("Una vez por elemento (bucle en el paso)")).toBeTruthy();
    expect(within(list).getByTitle("2 comprobaciones")).toBeTruthy();
    expect(within(list).getByTitle("Reintenta al fallar")).toBeTruthy();
    expect(list.textContent).toContain("1 capturas · 2 comprob.");
    // Una plantilla cuya operación ya no está enseña su id.
    expect(within(nodeEl("lost")).getByText("op-gone")).toBeTruthy();

    expect(nodeEl("rama").textContent).toContain("If · rama");
    expect(nodeEl("rama").textContent).toContain("lee list");
    expect(nodeEl("espera").textContent).toContain("2000 ms");
    expect(nodeEl("union").textContent).toContain("basta con una · 2 ramas");
    expect(nodeEl("valida").textContent).toContain("2 comprob. · script");
    expect(nodeEl("fetch").textContent).toContain("https://otra.api/x");
    expect(within(nodeEl("fetch")).getByTitle("Presenta la sesión del login")).toBeTruthy();
    expect(nodeEl("fetch").textContent).toContain("1 capturas · 1 comprob.");
    expect(nodeEl("variables").textContent).toContain("token, id");
    expect(nodeEl("script").textContent).toContain("lee list");
    expect(nodeEl("script").textContent).toContain("3 líneas");
    expect(nodeEl("reintento").textContent).toContain("si falla list");
    expect(nodeEl("reintento").textContent).toContain("hasta 4 × cada 500 ms");
    expect(nodeEl("reintento").textContent).toContain("reintentar → login");
    expect(nodeEl("sondeo").textContent).toContain("repite list");
    expect(nodeEl("sondeo").textContent).toContain("hasta 5 × cada 250 ms · 1 comprob.");
    expect(nodeEl("bucle").textContent).toContain("item ∈ list.items");
    expect(nodeEl("bucle").textContent).toContain("1 nodo por vuelta · máx. 10");
    expect(nodeEl("esquema").textContent).toContain("valida list");
    expect(nodeEl("esquema").textContent).toContain("del contrato · estricto");
    expect(nodeEl("notificar").textContent).toContain("Hola equipo");
    expect(nodeEl("notificar").textContent).toContain("Slack · SLACK_URL · falla si no llega");
    expect(nodeEl("subflujo").textContent).toContain("ejecuta otro flujo");
    expect(nodeEl("subflujo").textContent).toContain("1 entrada · 2 salidas");
    expect(nodeEl("graphql").textContent).toContain("Pedidos · https://gql/x");
    expect(nodeEl("graphql").textContent).toContain("1 capturas · 1 comprob. · admite errors");
    expect(nodeEl("canal").textContent).toContain("guion de 2 acciones");
    expect(nodeEl("canal").textContent).toContain("sus expectativas deciden · 1 capturas");
    expect(nodeEl("mock").textContent).toContain("responde 201 tras 50 ms");
    expect(nodeEl("mock").textContent).toContain("simulado · sin red · 1 capturas · 1 comprob.");

    // Y las aristas salen de las dependencias, la de «reintentar» incluida.
    expect(document.querySelector('.react-flow__edge[data-id="reintento~reintentar~login"]')).toBeTruthy();
  });

  test("un flujo sin configurar: cada tipo dice lo que le falta", async () => {
    mount(EMPTY);
    await waitFor(() => expect(nodeEl("rama")).toBeTruthy());
    expect(nodeEl("rama").textContent).toContain("conéctalo a un paso");
    expect(nodeEl("valida").textContent).toContain("sin comprobaciones");
    expect(nodeEl("fetch").textContent).toContain("sin URL");
    expect(nodeEl("variables").textContent).toContain("sin variables");
    expect(nodeEl("script").textContent).toContain("sin respuesta que leer");
    expect(nodeEl("script").textContent).toContain("sin código");
    expect(nodeEl("script-2").textContent).toContain("1 línea");
    expect(nodeEl("reintento").textContent).toContain("conéctale el paso que vigila");
    expect(nodeEl("reintento").textContent).toContain("reintentar (sin conectar)");
    expect(nodeEl("sondeo").textContent).toContain("conéctalo a una petición");
    expect(nodeEl("sondeo").textContent).toContain("sin comprobaciones");
    expect(nodeEl("bucle").textContent).toContain("conéctalo a un paso con una lista");
    expect(nodeEl("bucle").textContent).toContain("nada en «cada»");
    expect(nodeEl("bucle-2").textContent).toContain("2 nodos por vuelta");
    expect(nodeEl("esquema").textContent).toContain("esquema propio");
    expect(nodeEl("notificar").textContent).toContain("sin mensaje");
    expect(nodeEl("notificar").textContent).toContain("Teams · sin variable");
    expect(nodeEl("subflujo").textContent).toContain("elige el flujo que ejecuta");
    expect(nodeEl("subflujo").textContent).toContain("1 entrada · 1 salida");
    expect(nodeEl("graphql").textContent).toContain("sin URL");
    expect(nodeEl("canal").textContent).toContain("elige el canal");
    expect(nodeEl("canal-2").textContent).toContain("manda los mensajes del canal");
    expect(nodeEl("canal-3").textContent).toContain("solo escucha");
    expect(nodeEl("mock").textContent).toContain("responde ?");
    expect(nodeEl("union").textContent).toContain("espera a todas · 1 rama");
    expect(nodeEl("huerfano").textContent).toContain("Prueba eliminada");
    expect(nodeEl("login").textContent).toContain("Falta de dónde sale la credencial");
  });
});

describe("una corrida vigilada sobre el lienzo", () => {
  test("cada estado tiñe su nodo y pone su punto", async () => {
    const statuses: CaseStatus[] = ["running", "passed", "failed", "skipped", "queued"];
    const runStatus = Object.fromEntries(FULL.map((step, index) => [step.id, statuses[index % statuses.length]]));
    mount(FULL, { runStatus });
    await waitFor(() => expect(nodeEl("login")).toBeTruthy());
    // login va el primero: corriendo; list, correcto; lost, fallido…
    expect(within(nodeEl("login")).getByTitle("Ejecutando")).toBeTruthy();
    expect(within(nodeEl("list")).getByTitle("Correcto")).toBeTruthy();
    expect(within(nodeEl("lost")).getByTitle("Fallido")).toBeTruthy();
    expect(within(nodeEl("rama")).getByTitle("No ejecutado")).toBeTruthy();
    expect(within(nodeEl("espera")).getByTitle("En cola")).toBeTruthy();
    expect(nodeEl("login").querySelector(".border-sky-400")).toBeTruthy();
    expect(nodeEl("lost").querySelector(".border-rose-400")).toBeTruthy();
    // Todos los tipos llevan el punto.
    for (const step of FULL) expect(nodeEl(step.id).querySelector("[title][class*='rounded-full']")).toBeTruthy();
  });

  test("una espera corriendo cuenta hacia atrás lo que le falta", async () => {
    const startedAt = new Date(Date.now() - 500).toISOString();
    mount(FULL, { runStatus: { espera: "running" }, runStartedAt: { espera: startedAt } });
    await waitFor(() => expect(nodeEl("espera")).toBeTruthy());
    const timer = within(nodeEl("espera")).getByRole("timer");
    expect(timer.textContent).toContain("de 2000 ms");
    expect(timer.getAttribute("title")).toMatch(/^Faltan 1\.\d s de 2000 ms$/);
    // Y avanza sola.
    const first = timer.textContent;
    await waitFor(() => expect(within(nodeEl("espera")).getByRole("timer").textContent).not.toBe(first), { timeout: 1000 });
  });

  test("los reintentos: el intento en curso, la pausa que queda, y cuántos hicieron falta", async () => {
    const now = new Date().toISOString();
    const live: RetryNote = { attempt: 2, attempts: 3, waitMs: 2000, at: now, done: false };
    const runRetries: Record<string, RetryNote> = {
      list: live,
      fetch: { ...live, waitMs: 0 },
      graphql: { attempt: 2, attempts: 20, waitMs: 1000, at: now, done: false },
      login: { attempt: 2, attempts: 3, waitMs: 0, at: now, done: true },
      reintento: { attempt: 4, attempts: 4, waitMs: 0, at: now, done: true },
      sondeo: { ...live },
    };
    mount(FULL, {
      runStatus: { list: "running", fetch: "running", graphql: "running", login: "passed", reintento: "failed", sondeo: "running" },
      runRetries,
    });
    await waitFor(() => expect(nodeEl("list")).toBeTruthy());

    const meter = within(nodeEl("list")).getByRole("status");
    expect(meter.textContent).toContain("Intento 2 de 3");
    expect(meter.textContent).toMatch(/en \d\.\d s/);
    // Una barra por intento: el primero gastado, el segundo en curso.
    expect(meter.querySelectorAll(".bg-rose-400")).toHaveLength(1);
    expect(meter.querySelectorAll(".bg-amber-500")).toHaveLength(2); // el intento y la barra de la pausa
    // Mientras reintenta, el nodo va en ámbar y no en azul.
    expect(nodeEl("list").querySelector(".border-amber-400")).toBeTruthy();

    // Sin pausa pendiente, ya está enviando.
    expect(within(nodeEl("fetch")).getByRole("status").textContent).toContain("enviando…");
    // Con más de doce intentos no se dibuja una barra por cada uno.
    expect(within(nodeEl("graphql")).getByRole("status").querySelectorAll(".bg-amber-100.flex-1")).toHaveLength(0);
    expect(within(nodeEl("sondeo")).getByRole("status").textContent).toContain("Intento 2 de 3");

    // Terminados: cuántos intentos le costó.
    expect(nodeEl("login").textContent).toContain("Pasó en el intento 2 de 3");
    expect(nodeEl("reintento").textContent).toContain("Falló tras 4 de 4 intentos");
  });

  test("la pausa y los puntos de parada se dibujan sobre sus nodos", async () => {
    const { rerender } = mount(FULL, { pausedStepId: "list", breakpoints: ["rama", "valida"] });
    await waitFor(() => expect(screen.getByTestId("paused-node")).toBeTruthy());
    expect(screen.getByRole("status", { name: "" }).textContent).toContain("En pausa");
    expect(screen.getAllByLabelText("Punto de parada")).toHaveLength(2);
    // Un nodo que el flujo no tiene no pinta nada.
    rerender({ pausedStepId: "no-existe", breakpoints: ["tampoco"] });
    await waitFor(() => expect(screen.queryByTestId("paused-node")).toBeNull());
    expect(screen.queryByLabelText("Punto de parada")).toBeNull();
    // Y sin pausa ni marcas, nada.
    rerender({ pausedStepId: null, breakpoints: [] });
    expect(screen.queryByTestId("paused-node")).toBeNull();
  });
});

describe("la paleta", () => {
  test("un control sin nada seleccionado queda suelto, y se abre", async () => {
    const { onChange, onSelect } = mount(FULL.slice(0, 2));
    await waitFor(() => expect(nodeEl("login")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: /If/ }));
    const next = lastSteps(onChange);
    const added = next.at(-1)!;
    expect(added.kind).toBe("branch");
    expect(added.dependsOn).toBeUndefined();
    expect(onSelect).toHaveBeenCalledWith(added.id);
  });

  test("con un nodo seleccionado, el control nuevo cuelga de él", async () => {
    const { onChange, onSelect } = mount(FULL.slice(0, 2));
    await waitFor(() => expect(nodeEl("list")).toBeTruthy());
    fireEvent.click(nodeEl("list"));
    expect(onSelect).toHaveBeenCalledWith("list");
    await waitFor(() => expect(nodeEl("list").classList.contains("selected")).toBe(true));
    fireEvent.click(screen.getByRole("button", { name: /Validación/ }));
    const added = lastSteps(onChange).at(-1)!;
    expect(added.kind).toBe("validate");
    expect(added.dependsOn).toEqual(["list"]);
    expect(added.validate?.from).toBe("list");
  });

  test("Petición y Login abren el catálogo; sin login, el botón se apaga", async () => {
    const { onAddRequest, onAddLogin, rerender } = mount([]);
    fireEvent.click(screen.getByRole("button", { name: /Petición/ }));
    expect(onAddRequest).toHaveBeenCalledWith();
    fireEvent.click(screen.getByRole("button", { name: /Login/ }));
    expect(onAddLogin).toHaveBeenCalledWith();

    rerender({ onAddLogin: undefined });
    const login = screen.getByRole("button", { name: /Login/ }) as HTMLButtonElement;
    expect(login.disabled).toBe(true);
    expect(login.getAttribute("draggable")).toBe("false");
  });

  test("sin onAddRequest el lienzo es de lectura: ni paleta ni menú", async () => {
    const { onSelect } = mount(FULL.slice(0, 2), { onAddRequest: undefined });
    await waitFor(() => expect(nodeEl("login")).toBeTruthy());
    expect(screen.queryByRole("button", { name: /Petición/ })).toBeNull();
    fireEvent.contextMenu(nodeEl("login"));
    expect(onSelect).toHaveBeenCalledWith("login");
    expect(screen.queryByText("Duplicar nodo")).toBeNull();
  });
});

describe("arrastrar de la paleta al lienzo", () => {
  test("el botón lleva su tipo, y el lienzo lo acepta como copia", async () => {
    const { container } = mount([]);
    const data = transfer();
    fireEvent.dragStart(screen.getByRole("button", { name: /Espera/ }), { dataTransfer: data });
    expect(data.getData("application/x-eq-node-kind")).toBe("wait");
    expect(data.effectAllowed).toBe("copy");

    const pane = container.querySelector(".relative.flex-1") as HTMLElement;
    const over = transfer("wait");
    fireEvent.dragOver(pane, { dataTransfer: over });
    expect(over.dropEffect).toBe("copy");
    // Lo que no viene de la paleta no se acepta.
    const foreign = transfer();
    fireEvent.dragOver(pane, { dataTransfer: foreign });
    expect(foreign.dropEffect).toBe("none");
  });

  test("soltar un control lo crea donde cae; una petición o un login abren el catálogo con el sitio", async () => {
    const { container, onChange, onSelect, onAddRequest, onAddLogin } = mount(FULL.slice(0, 1));
    await waitFor(() => expect(nodeEl("login")).toBeTruthy());
    const pane = container.querySelector(".relative.flex-1") as HTMLElement;
    // Hasta que React Flow no se ha iniciado no hay dónde convertir la posición.
    await waitFor(() => {
      fireEvent.drop(pane, { dataTransfer: transfer("merge"), clientX: 400, clientY: 300 });
      expect(onChange).toHaveBeenCalled();
    });
    const added = lastSteps(onChange).at(-1)!;
    expect(added.kind).toBe("merge");
    expect(added.position).toEqual({ x: expect.any(Number), y: expect.any(Number) });
    expect(added.dependsOn).toBeUndefined();
    expect(onSelect).toHaveBeenCalledWith(added.id);

    fireEvent.drop(pane, { dataTransfer: transfer("request"), clientX: 10, clientY: 10 });
    expect(onAddRequest).toHaveBeenCalledWith({ x: expect.any(Number), y: expect.any(Number) });
    fireEvent.drop(pane, { dataTransfer: transfer("login"), clientX: 10, clientY: 10 });
    expect(onAddLogin).toHaveBeenCalledWith({ x: expect.any(Number), y: expect.any(Number) });

    // Un tipo que no existe, o nada, no hace nada.
    const calls = onChange.mock.calls.length;
    fireEvent.drop(pane, { dataTransfer: transfer("inventado") });
    fireEvent.drop(pane, { dataTransfer: transfer() });
    expect(onChange.mock.calls.length).toBe(calls);
  });
});

describe("el menú de un nodo", () => {
  test("clic derecho selecciona y abre; Editar, Duplicar y el punto de parada", async () => {
    const onToggleBreakpoint = vi.fn();
    const { onChange, onSelect, rerender } = mount(FULL.slice(0, 2), { onToggleBreakpoint, breakpoints: [] });
    await waitFor(() => expect(nodeEl("list")).toBeTruthy());

    fireEvent.contextMenu(nodeEl("list"), { clientX: 50, clientY: 60 });
    expect(onSelect).toHaveBeenLastCalledWith("list");
    fireEvent.click(screen.getByText("Editar…"));
    expect(screen.queryByText("Editar…")).toBeNull();

    fireEvent.contextMenu(nodeEl("list"));
    fireEvent.click(screen.getByText("Duplicar nodo"));
    const copy = lastSteps(onChange).at(-1)!;
    expect(copy.id).toBe("list-2");
    expect(copy.dependsOn).toBeUndefined();
    expect(screen.queryByText("Duplicar nodo")).toBeNull();

    fireEvent.contextMenu(nodeEl("list"));
    fireEvent.click(screen.getByText("Detenerse antes de este nodo"));
    expect(onToggleBreakpoint).toHaveBeenCalledWith("list");

    rerender({ onToggleBreakpoint, breakpoints: ["list"] });
    fireEvent.contextMenu(nodeEl("list"));
    expect(screen.getByText("Quitar punto de parada")).toBeTruthy();
    // Un clic en el propio menú no lo cierra; uno fuera, sí.
    fireEvent.click(screen.getByText("Quitar punto de parada").parentElement!);
    expect(screen.getByText("Quitar punto de parada")).toBeTruthy();
    fireEvent.click(document.querySelector(".react-flow__pane")!);
    expect(screen.queryByText("Quitar punto de parada")).toBeNull();
  });

  test("sin onToggleBreakpoint no ofrece el punto de parada", async () => {
    mount(FULL.slice(0, 1));
    await waitFor(() => expect(nodeEl("login")).toBeTruthy());
    fireEvent.contextMenu(nodeEl("login"));
    expect(screen.getByText("Duplicar nodo")).toBeTruthy();
    expect(screen.queryByText("Detenerse antes de este nodo")).toBeNull();
  });

  test("Eliminar pide confirmación, y al confirmar quita el nodo y sus conexiones", async () => {
    const { onChange } = mount(FULL.slice(0, 2));
    await waitFor(() => expect(nodeEl("login")).toBeTruthy());

    fireEvent.contextMenu(nodeEl("login"));
    fireEvent.click(screen.getByText("Eliminar nodo"));
    const dialog = screen.getByRole("dialog");
    expect(dialog.textContent).toContain("Esta acción no borra la petición reutilizable.");
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancelar" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(onChange).not.toHaveBeenCalled();

    fireEvent.contextMenu(nodeEl("login"));
    fireEvent.click(screen.getByText("Eliminar nodo"));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Eliminar" }));
    const next = lastSteps(onChange);
    expect(next.map((step) => step.id)).toEqual(["list"]);
    expect(next[0].dependsOn ?? []).toEqual([]);
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

describe("conectar, cortar y mover", () => {
  test("clic en la salida de un nodo y en la entrada de otro los conecta", async () => {
    const { onChange } = mount([
      { id: "a", kind: "wait", waitMs: 1, position: { x: 0, y: 0 } },
      { id: "b", kind: "wait", waitMs: 1, position: { x: 400, y: 0 } },
    ]);
    await waitFor(() => expect(nodeEl("b")).toBeTruthy());
    const source = nodeEl("a").querySelector(".react-flow__handle.source") as HTMLElement;
    const target = nodeEl("b").querySelector(".react-flow__handle.target") as HTMLElement;
    // jsdom no sabe qué hay bajo el puntero; React Flow lo pregunta para validar la conexión.
    const doc = document as Document & { elementFromPoint: (x: number, y: number) => Element | null };
    const original = doc.elementFromPoint;
    doc.elementFromPoint = () => target;
    try {
      fireEvent.click(source);
      fireEvent.click(target);
      await waitFor(() => expect(onChange).toHaveBeenCalled());
    } finally {
      doc.elementFromPoint = original;
    }
    expect(lastSteps(onChange).find((step) => step.id === "b")?.dependsOn).toEqual(["a"]);
  });

  test("una arista seleccionada se corta con Supr", async () => {
    const { onChange } = mount(FULL.slice(0, 2));
    const edge = await waitFor(() => {
      const found = document.querySelector('.react-flow__edge[data-id]') as HTMLElement;
      expect(found).toBeTruthy();
      return found;
    });
    fireEvent.click(edge);
    await waitFor(() => expect(document.querySelector(".react-flow__edge.selected")).toBeTruthy());
    fireEvent.keyDown(document.body, { key: "Delete", code: "Delete" });
    fireEvent.keyUp(document.body, { key: "Delete", code: "Delete" });
    await waitFor(() => expect(onChange).toHaveBeenCalled());
    expect(lastSteps(onChange).find((step) => step.id === "list")?.dependsOn ?? []).toEqual([]);
  });

  test("mover un nodo con el teclado guarda su nueva posición", async () => {
    const { onChange } = mount(FULL.slice(0, 2));
    await waitFor(() => expect(nodeEl("login")).toBeTruthy());
    fireEvent.click(nodeEl("login"));
    await waitFor(() => expect(nodeEl("login").classList.contains("selected")).toBe(true));
    fireEvent.keyDown(nodeEl("login"), { key: "ArrowRight", code: "ArrowRight" });
    await waitFor(() => expect(onChange).toHaveBeenCalled());
    const moved = lastSteps(onChange).find((step) => step.id === "login")!;
    expect(moved.position!.x).toBeGreaterThan(0);
  });
});

describe("llevar la vista al nodo nuevo", () => {
  test("un nodo añadido mueve la vista hasta él; cambiar de flujo, no", async () => {
    // El panel lateral abierto (un diálogo no modal) recorta la parte visible del lienzo.
    const panel = document.createElement("div");
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-modal", "false");
    document.body.appendChild(panel);
    try {
      const base = FULL.slice(0, 2);
      const { rerender } = mount(base, { flowId: "f1" });
      await waitFor(() => expect(nodeEl("list")).toBeTruthy());
      const viewport = document.querySelector(".react-flow__viewport") as HTMLElement;
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 50));
      });
      const before = viewport.style.transform;

      rerender({ flowId: "f1", steps: [...base, { id: "lejos", kind: "wait", waitMs: 1, position: { x: 5000, y: 5000 } }] });
      await waitFor(() => expect(nodeEl("lejos")).toBeTruthy());
      await waitFor(() => expect(viewport.style.transform).not.toBe(before), { timeout: 2000 });

      // Otro flujo con más nodos no es «un nodo añadido». Primero, que acabe la animación.
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 600));
      });
      const settled = viewport.style.transform;
      rerender({ flowId: "f2", steps: [...base, { id: "otro", kind: "wait", waitMs: 1, position: { x: -5000, y: -5000 } }] });
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 600));
      });
      expect(nodeEl("otro")).toBeTruthy();
      expect(viewport.style.transform).toBe(settled);
    } finally {
      panel.remove();
    }
  });
});

describe("lo que queda de cada nodo", () => {
  test("cualquier nodo, sea del tipo que sea, se resalta al seleccionarlo", async () => {
    const steps = [...FULL, { id: "gancho", kind: "webhook", position: { x: 300, y: 1400 } } as WorkflowStepView];
    const { onSelect } = mount(steps);
    await waitFor(() => expect(nodeEl("gancho")).toBeTruthy());
    for (const step of steps) {
      fireEvent.click(nodeEl(step.id));
      await waitFor(() => expect(nodeEl(step.id).firstElementChild!.className).toContain("border-slate-900"));
      expect(onSelect).toHaveBeenLastCalledWith(step.id);
    }
  });

  test("el webhook dice qué verbo espera, hasta cuándo, y lo que comprueba y captura", async () => {
    mount(
      [
        {
          id: "pago",
          kind: "webhook",
          webhook: { timeoutMs: 120_000, method: "PUT" },
          checks: [check],
          captures: [{ variable: "a" } as never],
          position: { x: 0, y: 0 },
        } as WorkflowStepView,
        { id: "vacio", kind: "webhook", position: { x: 300, y: 0 } } as WorkflowStepView,
      ],
      { runStatus: { pago: "running" } },
    );
    await waitFor(() => expect(nodeEl("vacio")).toBeTruthy());
    expect(nodeEl("pago").textContent).toContain("Webhook · pago");
    expect(nodeEl("pago").textContent).toMatch(/espera un PUT · hasta /);
    expect(nodeEl("pago").textContent).toContain("1 comprob. · 1 capturas");
    expect(within(nodeEl("pago")).getByTitle("Ejecutando")).toBeTruthy();
    expect(nodeEl("vacio").textContent).toContain("espera un POST");
    expect(nodeEl("vacio").textContent).toContain("sin comprobaciones");
    expect(nodeEl("vacio").textContent).not.toContain("capturas");
  });

  test("un subflujo con varias entradas y sin salidas, y un canal de notificación desconocido por su nombre", async () => {
    mount([
      {
        id: "sub",
        kind: "subflow",
        subflow: { workflowId: "w", inputs: [{ variable: "a", value: "1" }, { variable: "b", value: "2" }], outputs: [] },
        position: { x: 0, y: 0 },
      },
      {
        id: "aviso",
        kind: "notify",
        notify: { channel: "discord" as never, urlVariable: "URL", message: "Hola" },
        position: { x: 300, y: 0 },
      },
    ]);
    await waitFor(() => expect(nodeEl("aviso")).toBeTruthy());
    expect(nodeEl("sub").textContent).toContain("2 entradas · 0 salidas");
    expect(nodeEl("aviso").textContent).toContain("discord · URL");
  });

  test("un canal elegido lleva su nombre y protocolo; uno que ya no existe lo avisa", async () => {
    const channels = [{ id: "ch-1", name: "Chat", protocol: "ws" }] as ChannelView[];
    mount(
      [
        { id: "vivo", kind: "channel", channel: { channelId: "ch-1" }, position: { x: 0, y: 0 } },
        { id: "roto", kind: "channel", channel: { channelId: "ch-x" }, position: { x: 300, y: 0 } },
      ],
      { channels },
    );
    await waitFor(() => expect(nodeEl("roto")).toBeTruthy());
    expect(nodeEl("vivo").textContent).toContain("Chat");
    expect(nodeEl("vivo").textContent).toContain("WebSocket");
    expect(within(nodeEl("vivo")).queryByRole("alert")).toBeNull();
    expect(within(nodeEl("roto")).getByRole("alert").textContent).toContain("El canal ya no existe en este proyecto");
    expect(nodeEl("roto").textContent).toContain("Canal · roto");
  });
});

describe("las aristas y la vista, en los bordes", () => {
  test("una arista que se deja de seleccionar ya no se corta con Supr", async () => {
    const { onChange } = mount(FULL.slice(0, 2));
    const edge = await waitFor(() => {
      const found = document.querySelector(".react-flow__edge[data-id]") as HTMLElement;
      expect(found).toBeTruthy();
      return found;
    });
    fireEvent.click(edge);
    await waitFor(() => expect(document.querySelector(".react-flow__edge.selected")).toBeTruthy());
    fireEvent.click(document.querySelector(".react-flow__pane")!);
    await waitFor(() => expect(document.querySelector(".react-flow__edge.selected")).toBeNull());
    fireEvent.keyDown(document.body, { key: "Delete", code: "Delete" });
    fireEvent.keyUp(document.body, { key: "Delete", code: "Delete" });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    expect(onChange).not.toHaveBeenCalled();
  });

  test("un nodo añadido y quitado antes de dibujarse no mueve la vista", async () => {
    const base = FULL.slice(0, 2);
    const { rerender } = mount(base, { flowId: "f1" });
    await waitFor(() => expect(nodeEl("list")).toBeTruthy());
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    const viewport = document.querySelector(".react-flow__viewport") as HTMLElement;
    const before = viewport.style.transform;
    rerender({ flowId: "f1", steps: [...base, { id: "fugaz", kind: "wait", waitMs: 1, position: { x: 5000, y: 5000 } }] });
    rerender({ flowId: "f1", steps: base });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 600));
    });
    expect(nodeEl("fugaz")).toBeNull();
    expect(viewport.style.transform).toBe(before);
  });

  test("el nodo nuevo se centra en la parte del lienzo que el panel lateral deja a la vista", async () => {
    const PANE = { left: 0, right: 1200, top: 0, bottom: 800, width: 1200, height: 800, x: 0, y: 0 };
    /** Dónde acaba la vista según dónde esté el panel: a la derecha, a la izquierda, o de lado a lado. */
    async function landing(panel: { left: number; right: number }) {
      const drawer = document.createElement("div");
      drawer.setAttribute("role", "dialog");
      drawer.setAttribute("aria-modal", "false");
      document.body.appendChild(drawer);
      const original = Element.prototype.getBoundingClientRect;
      const spy = vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
        if (this === drawer) return { ...PANE, ...panel, width: panel.right - panel.left, toJSON() {} } as DOMRect;
        if (this.classList.contains("relative") && this.classList.contains("flex-1")) return { ...PANE, toJSON() {} } as DOMRect;
        return original.call(this);
      });
      try {
        const base = FULL.slice(0, 2);
        const view = mount(base, { flowId: "f1" });
        await waitFor(() => expect(nodeEl("list")).toBeTruthy());
        await act(async () => {
          await new Promise((resolve) => setTimeout(resolve, 50));
        });
        const viewport = document.querySelector(".react-flow__viewport") as HTMLElement;
        const before = viewport.style.transform;
        view.rerender({ flowId: "f1", steps: [...base, { id: "lejos", kind: "wait", waitMs: 1, position: { x: 5000, y: 5000 } }] });
        await waitFor(() => expect(viewport.style.transform).not.toBe(before), { timeout: 2000 });
        await act(async () => {
          await new Promise((resolve) => setTimeout(resolve, 600));
        });
        const after = viewport.style.transform;
        view.container.remove();
        return after;
      } finally {
        spy.mockRestore();
        drawer.remove();
      }
    }

    const right = await landing({ left: 800, right: 1200 });
    const left = await landing({ left: 0, right: 400 });
    const covering = await landing({ left: 100, right: 1200 });
    // Con el panel a la derecha el nodo se va a la izquierda, y al revés; un panel que no está a un
    // lado (lo tapa casi todo) no cuenta, y el nodo se centra sin más.
    expect(right).not.toBe(left);
    expect(covering).not.toBe(right);
    expect(covering).not.toBe(left);
  });
});
