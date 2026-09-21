/**
 * La pantalla de monitores: los botones de cada tarjeta y los rincones del formulario.
 *
 * - **Pausar, correr ahora y eliminar** mandan su petición y dicen lo que pasó; «correr ahora» que
 *   no lanza nada lo dice con la nota del servidor.
 * - **La tarjeta nombra lo que corre** aunque la lista de flujos o de canales no haya llegado.
 * - **El formulario** manda el horario semanal con sus días, el entorno, la suite o el canal
 *   elegidos, y al editar conserva lo que no enseña del canal si el canal es el mismo.
 */
import { afterEach, describe, expect, test, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";

import { MonitorsPage } from "@/routes/monitors";
import { ToastProvider } from "@/components/toast";
import type { MonitorExecutionView, MonitorListView } from "@/lib/types";

type ListedMonitor = MonitorListView["monitors"][number];

const call = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", async (original) => ({
  ...(await original<object>()),
  api: call,
}));
vi.mock("@/lib/auth", () => ({ useOrganization: () => ({ id: "o", name: "Org" }), useCan: () => true }));

const BASE = "/orgs/o/projects/p1";

const execution = (patch: Partial<MonitorExecutionView> = {}): MonitorExecutionView => ({
  id: `e-${Math.random()}`,
  monitorId: "m1",
  runId: "r1",
  outcome: "passed",
  startedAt: "2026-03-01T10:00:00.000Z",
  finishedAt: "2026-03-01T10:01:00.000Z",
  totals: { cases: 12, passed: 12, failed: 0 },
  note: "",
  ...patch,
});

const monitor = (patch: Partial<ListedMonitor> = {}): ListedMonitor => ({
  id: "m1",
  name: "producción",
  enabled: true,
  schedule: { kind: "interval", minutes: 60 },
  plan: { environmentId: "env-1" },
  alert: null,
  nextRunAt: "2026-03-01T11:00:00.000Z",
  lastRunAt: null,
  lastOutcome: null,
  consecutiveFailures: 0,
  createdAt: "2026-03-01T09:00:00.000Z",
  updatedAt: "2026-03-01T09:00:00.000Z",
  createdBy: "u1",
  scheduleLabel: "cada hora",
  recent: [],
  archivedAt: null,
  deletedAt: null,
  ...patch,
});

const channel = (id: string, name: string, protocol: "ws" | "grpc") => ({ id, name, protocol, messages: [] });

/** Nunca contesta: lo que la pantalla hace mientras una consulta sigue en camino. */
const pending = () => new Promise(() => {});

type Answer = (path: string, options?: { method?: string; body?: unknown }) => unknown;

function draw({
  monitors = [] as ListedMonitor[],
  environments = (() => [{ id: "env-1", name: "producción", variables: { HOST: "x" } }]) as () => unknown,
  flows = (() => ({
    workflows: [{ id: "w1", name: "el alta" }],
    suites: [{ id: "s1", name: "humo" }],
  })) as () => unknown,
  channels = (() => ({ channels: [channel("c1", "eco", "ws"), channel("g1", "pedidos", "grpc")] })) as () => unknown,
  mutate = (() => monitor()) as Answer,
} = {}) {
  call.mockReset();
  call.mockImplementation((path: string, options?: { method?: string; body?: unknown }) => {
    if (options?.method) return Promise.resolve().then(() => mutate(path, options));
    if (path.endsWith("/monitors")) return Promise.resolve({ monitors });
    if (path.endsWith("/environments")) return Promise.resolve().then(environments);
    if (path.endsWith("/channels")) return Promise.resolve().then(channels);
    return Promise.resolve().then(flows);
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <ToastProvider>
        <MemoryRouter initialEntries={["/p/p1/monitors"]}>
          <Routes>
            <Route path="/p/:projectId/monitors" element={<MonitorsPage />} />
          </Routes>
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

const sent = (method: string) => call.mock.calls.find(([, options]) => options?.method === method);

async function openCreate() {
  fireEvent.click(await screen.findByRole("button", { name: "Crear un monitor" }));
  return within(await screen.findByRole("dialog"));
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("los botones de la tarjeta", () => {
  test("pausar y activar mandan lo contrario de lo que hay, y lo dicen", async () => {
    draw({ monitors: [monitor(), monitor({ id: "m2", name: "staging", enabled: false, nextRunAt: null })] });
    fireEvent.click(await screen.findByRole("button", { name: "Pausar" }));
    await waitFor(() =>
      expect(call).toHaveBeenCalledWith(`${BASE}/monitors/m1`, { method: "PATCH", body: { enabled: false } }),
    );
    expect(await screen.findByText("«producción» pausado")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Activar" }));
    await waitFor(() =>
      expect(call).toHaveBeenCalledWith(`${BASE}/monitors/m2`, { method: "PATCH", body: { enabled: true } }),
    );
    expect(await screen.findByText("«staging» activo")).toBeTruthy();
  });

  test("un fallo al pausar se dice", async () => {
    draw({
      monitors: [monitor()],
      mutate: () => {
        throw new Error("Sin permiso");
      },
    });
    fireEvent.click(await screen.findByRole("button", { name: "Pausar" }));
    expect(await screen.findByText("Sin permiso")).toBeTruthy();
  });

  test("correr ahora: lanzada, saltada con su nota, saltada sin nota, y un fallo", async () => {
    const answers: (() => unknown)[] = [
      () => ({ runId: "r9", outcome: "running", note: "" }),
      () => ({ runId: null, outcome: "skipped", note: "La anterior sigue en marcha" }),
      () => ({ runId: null, outcome: "skipped", note: "" }),
      () => {
        throw new Error("El entorno ya no existe");
      },
    ];
    draw({ monitors: [monitor()], mutate: () => answers.shift()!() });
    const run = await screen.findByRole("button", { name: "Correr ahora" });

    fireEvent.click(run);
    await waitFor(() => expect(call).toHaveBeenCalledWith(`${BASE}/monitors/m1/runs`, { method: "POST", body: {} }));
    expect(await screen.findByText("Corrida lanzada")).toBeTruthy();
    await waitFor(() => expect((run as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(run);
    expect(await screen.findByText("La anterior sigue en marcha")).toBeTruthy();
    await waitFor(() => expect((run as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(run);
    expect(await screen.findByText("No se pudo lanzar")).toBeTruthy();
    await waitFor(() => expect((run as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(run);
    expect(await screen.findByText("El entorno ya no existe")).toBeTruthy();
  });

  test("eliminar: cancelar no borra; confirmar borra y lo dice; un fallo se dice", async () => {
    let fail = false;
    draw({
      monitors: [monitor()],
      mutate: () => {
        if (fail) throw new Error("No se pudo eliminar");
        return undefined;
      },
    });
    fireEvent.click(await screen.findByRole("button", { name: "Eliminar" }));
    fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Cancelar" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(sent("DELETE")).toBeUndefined();

    fireEvent.click(screen.getByRole("button", { name: "Eliminar" }));
    fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Eliminar" }));
    await waitFor(() => expect(call).toHaveBeenCalledWith(`${BASE}/monitors/m1`, { method: "DELETE" }));
    expect(await screen.findByText("«producción» eliminado")).toBeTruthy();

    fail = true;
    fireEvent.click(screen.getByRole("button", { name: "Eliminar" }));
    fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Eliminar" }));
    expect(await screen.findByText("No se pudo eliminar")).toBeTruthy();
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

describe("lo que dice la tarjeta", () => {
  test("nombra la suite, y dice «un flujo» o «una suite» si ya no están", async () => {
    draw({
      monitors: [
        monitor({ id: "a", name: "la suite", plan: { environmentId: "env-1", suiteId: "s1" } }),
        monitor({ id: "b", name: "suite perdida", plan: { environmentId: "env-1", suiteId: "s-borrada" } }),
        monitor({ id: "c", name: "flujo perdido", plan: { environmentId: "env-1", workflowId: "w-borrado" } }),
      ],
    });
    expect(await screen.findByText(/Corre la suite «humo»/)).toBeTruthy();
    expect(screen.getByText(/Corre una suite/)).toBeTruthy();
    expect(screen.getByText(/Corre un flujo/)).toBeTruthy();
  });

  test("mientras los canales no llegan dice «un canal», sin darlo por borrado", async () => {
    draw({
      monitors: [monitor({ plan: { environmentId: "env-1", channel: { channelId: "c1" } } })],
      channels: pending,
    });
    expect(await screen.findByText(/Corre un canal/)).toBeTruthy();
    expect(screen.queryByText(/ya no existe/)).toBeNull();
  });

  test("un fallo seguido va en singular; el aviso por webhook nombra su variable", async () => {
    draw({
      monitors: [
        monitor({
          consecutiveFailures: 1,
          lastOutcome: "failed",
          alert: { channel: "webhook", urlVariable: "HOOK_URL", afterFailures: 1 },
          recent: [execution({ outcome: "error", totals: null, note: "No contestó" })],
        }),
      ],
    });
    expect(await screen.findByText("1 fallo seguido")).toBeTruthy();
    expect(screen.getByText(/Avisa por webhook, con la URL de HOOK_URL, al primer fallo\./)).toBeTruthy();
    // Una vuelta sin totales dice su resultado, y su nota se lee debajo y en el título.
    const chip = screen.getByText("error", { selector: "span[title]" });
    expect(chip.getAttribute("title")).toMatch(/· No contestó$/);
    expect(screen.getByText("No contestó", { selector: "p" })).toBeTruthy();
  });

  test("un aviso por correo sin destinatarios guardados no rompe la tarjeta", async () => {
    draw({ monitors: [monitor({ alert: { channel: "email", afterFailures: 3 } })] });
    expect(await screen.findByText(/Avisa por correo a\s+tras 3 fallos seguidos\./)).toBeTruthy();
  });
});

describe("el formulario", () => {
  test("semanal: los días se marcan y desmarcan, sin ninguno no deja crear, y viaja con su zona", async () => {
    draw();
    const dialog = await openCreate();
    fireEvent.change(dialog.getByLabelText(/Nombre/), { target: { value: "los martes" } });
    fireEvent.change(dialog.getByLabelText("Tipo de horario"), { target: { value: "weekly" } });
    expect(dialog.getByRole("button", { name: "lun" }).getAttribute("aria-pressed")).toBe("true");

    fireEvent.click(dialog.getByRole("button", { name: "lun" }));
    expect(dialog.getByRole("button", { name: "lun" }).getAttribute("aria-pressed")).toBe("false");
    expect(dialog.getByRole("button", { name: "Crear" }).hasAttribute("disabled")).toBe(true);

    fireEvent.click(dialog.getByRole("button", { name: "mar" }));
    fireEvent.change(dialog.getByLabelText("Hora"), { target: { value: "no" } });
    fireEvent.change(dialog.getByLabelText("Minuto"), { target: { value: "30" } });
    fireEvent.click(dialog.getByRole("button", { name: "Crear" }));

    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
    await waitFor(() =>
      expect(sent("POST")![1].body.schedule).toEqual({
        kind: "weekly",
        weekdays: [2],
        hour: 0,
        minute: 30,
        timeZone: zone,
      }),
    );
  });

  test("un minuto que no es un número se queda en cero", async () => {
    draw();
    const dialog = await openCreate();
    fireEvent.change(dialog.getByLabelText("Tipo de horario"), { target: { value: "daily" } });
    fireEvent.change(dialog.getByLabelText("Minuto"), { target: { value: "xx" } });
    expect((dialog.getByLabelText("Minuto") as HTMLInputElement).value).toBe("0");
  });

  test("si el navegador no da su zona, se propone UTC", async () => {
    draw();
    await screen.findByRole("button", { name: "Crear un monitor" });
    vi.spyOn(Intl, "DateTimeFormat").mockImplementation(() => {
      throw new RangeError("sin Intl");
    });
    const dialog = await openCreate();
    fireEvent.change(dialog.getByLabelText("Tipo de horario"), { target: { value: "daily" } });
    expect(dialog.getByText(/En tu zona: UTC\./)).toBeTruthy();
  });

  test("si el navegador da una zona vacía, también UTC", async () => {
    draw();
    await screen.findByRole("button", { name: "Crear un monitor" });
    vi.spyOn(Intl, "DateTimeFormat").mockImplementation(
      () => ({ resolvedOptions: () => ({ timeZone: "" }) }) as unknown as Intl.DateTimeFormat,
    );
    const dialog = await openCreate();
    fireEvent.change(dialog.getByLabelText("Tipo de horario"), { target: { value: "daily" } });
    expect(dialog.getByText(/En tu zona: UTC\./)).toBeTruthy();
  });

  test("manda el entorno, la suite y el umbral del aviso elegidos; mientras crea lo dice", async () => {
    let finish: (value: unknown) => void = () => {};
    draw({
      environments: () => [
        { id: "env-1", name: "producción", variables: {} },
        { id: "env-2", name: "staging", variables: {} },
      ],
      mutate: () => new Promise((resolve) => (finish = resolve)),
    });
    const dialog = await openCreate();
    fireEvent.change(dialog.getByLabelText(/Nombre/), { target: { value: " humo " } });
    fireEvent.change(dialog.getByLabelText("Entorno"), { target: { value: "env-2" } });
    fireEvent.change(dialog.getByLabelText("Qué corre"), { target: { value: "suite" } });
    fireEvent.change(dialog.getByLabelText("Suite"), { target: { value: "s1" } });
    fireEvent.click(dialog.getByLabelText("Avisar cuando se ponga en rojo"));
    fireEvent.change(dialog.getByLabelText(/Variable del entorno/), { target: { value: "SLACK" } });
    fireEvent.change(dialog.getByLabelText("Avisar tras"), { target: { value: "3" } });
    fireEvent.click(dialog.getByRole("button", { name: "Crear" }));

    expect(await dialog.findByRole("button", { name: "Creando…" })).toBeTruthy();
    expect(sent("POST")![1].body).toEqual({
      name: "humo",
      schedule: { kind: "interval", minutes: 60 },
      plan: { environmentId: "env-2", suiteId: "s1" },
      alert: { channel: "slack", urlVariable: "SLACK", afterFailures: 3 },
    });
    finish(monitor({ name: "humo" }));
    expect(await screen.findByText("«humo» creado")).toBeTruthy();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  test("un fallo al crear se enseña en el formulario, y cancelar lo cierra sin mandar más", async () => {
    draw({
      mutate: () => {
        throw new Error("Ese nombre ya existe");
      },
    });
    const dialog = await openCreate();
    fireEvent.change(dialog.getByLabelText(/Nombre/), { target: { value: "repetido" } });
    fireEvent.click(dialog.getByRole("button", { name: "Crear" }));
    expect(await dialog.findByText("Ese nombre ya existe")).toBeTruthy();
    fireEvent.click(dialog.getByRole("button", { name: "Cancelar" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(call.mock.calls.filter(([, options]) => options?.method).length).toBe(1);
  });

  test("abierto antes de que lleguen entornos, flujos y canales, no deja crear ni ofrece nada", async () => {
    draw({ environments: pending, flows: pending, channels: pending });
    const dialog = await openCreate();
    fireEvent.change(dialog.getByLabelText(/Nombre/), { target: { value: "pronto" } });
    expect(dialog.getByRole("button", { name: "Crear" }).hasAttribute("disabled")).toBe(true);
    fireEvent.change(dialog.getByLabelText("Qué corre"), { target: { value: "flow" } });
    expect(within(dialog.getByLabelText("Flujo")).getAllByRole("option").length).toBe(1);
    fireEvent.change(dialog.getByLabelText("Qué corre"), { target: { value: "suite" } });
    expect(within(dialog.getByLabelText("Suite")).getAllByRole("option").length).toBe(1);
    fireEvent.change(dialog.getByLabelText("Qué corre"), { target: { value: "channel" } });
    expect(within(dialog.getByLabelText("Canal")).getAllByRole("option").length).toBe(1);
  });

  test("un canal gRPC ofrece correr solo su petición, y un guion propio vacío viaja vacío", async () => {
    draw();
    const dialog = await openCreate();
    fireEvent.change(dialog.getByLabelText(/Nombre/), { target: { value: "grpc" } });
    fireEvent.change(dialog.getByLabelText("Qué corre"), { target: { value: "channel" } });
    await waitFor(() => expect(dialog.getByRole("option", { name: "pedidos · gRPC" })).toBeTruthy());
    fireEvent.change(dialog.getByLabelText("Canal"), { target: { value: "g1" } });
    const own = dialog.getByLabelText("Sin guion propio: solo la petición de la llamada") as HTMLInputElement;
    expect(own.checked).toBe(true);
    fireEvent.click(own);
    expect(own.checked).toBe(false);
    // Volver a marcarla quita el guion propio; desmarcarla de nuevo lo abre vacío.
    fireEvent.click(own);
    expect(own.checked).toBe(true);
    fireEvent.click(own);
    fireEvent.click(dialog.getByRole("button", { name: "Crear" }));
    await waitFor(() =>
      expect(sent("POST")![1].body.plan).toEqual({
        environmentId: "env-1",
        channel: { channelId: "g1", messages: [] },
      }),
    );
  });
});

describe("editar", () => {
  test("uno semanal de una suite abre con sus días y su suite; cancelar lo cierra", async () => {
    draw({
      monitors: [
        monitor({
          schedule: { kind: "weekly", weekdays: [3, 5], hour: 8, minute: 15, timeZone: "America/Bogota" },
          plan: { environmentId: "env-1", suiteId: "s1" },
        }),
      ],
    });
    fireEvent.click(await screen.findByRole("button", { name: "Editar" }));
    const dialog = within(await screen.findByRole("dialog"));
    expect(dialog.getByRole("button", { name: "mié" }).getAttribute("aria-pressed")).toBe("true");
    expect(dialog.getByRole("button", { name: "vie" }).getAttribute("aria-pressed")).toBe("true");
    expect(dialog.getByRole("button", { name: "lun" }).getAttribute("aria-pressed")).toBe("false");
    expect(dialog.getByText(/En tu zona: America\/Bogota/)).toBeTruthy();
    await waitFor(() => expect((dialog.getByLabelText("Suite") as HTMLSelectElement).value).toBe("s1"));
    fireEvent.click(dialog.getByRole("button", { name: "Cancelar" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  test("el mismo canal conserva lo que el formulario no enseña; mientras guarda lo dice", async () => {
    let finish: (value: unknown) => void = () => {};
    draw({
      monitors: [
        monitor({
          plan: {
            environmentId: "env-1",
            channel: { channelId: "c1", messages: [{ action: "send", body: "hola" }], idleMs: 500 },
          },
        }),
      ],
      mutate: () => new Promise((resolve) => (finish = resolve)),
    });
    fireEvent.click(await screen.findByRole("button", { name: "Editar" }));
    const dialog = within(await screen.findByRole("dialog"));
    // Con guion propio, el editor sale abierto con sus mensajes.
    expect(((await dialog.findByLabelText("Mensaje 1")) as HTMLTextAreaElement).value).toBe("hola");
    fireEvent.click(dialog.getByRole("button", { name: "Guardar" }));
    expect(await dialog.findByRole("button", { name: "Guardando…" })).toBeTruthy();
    expect(sent("PATCH")![1].body.plan).toEqual({
      environmentId: "env-1",
      channel: { channelId: "c1", messages: [{ action: "send", body: "hola" }], idleMs: 500 },
    });
    finish(monitor());
    expect(await screen.findByText("«producción» guardado")).toBeTruthy();
  });

  test("cambiar de canal tira lo que era del otro", async () => {
    draw({
      monitors: [
        monitor({ plan: { environmentId: "env-1", channel: { channelId: "g1", request: '{"id":1}', idleMs: 500 } } }),
      ],
    });
    fireEvent.click(await screen.findByRole("button", { name: "Editar" }));
    const dialog = within(await screen.findByRole("dialog"));
    await waitFor(() => expect((dialog.getByLabelText("Canal") as HTMLSelectElement).value).toBe("g1"));
    fireEvent.change(dialog.getByLabelText("Canal"), { target: { value: "c1" } });
    fireEvent.click(dialog.getByRole("button", { name: "Guardar" }));
    await waitFor(() =>
      expect(sent("PATCH")![1].body.plan).toEqual({ environmentId: "env-1", channel: { channelId: "c1" } }),
    );
  });

  test("editar antes de que lleguen entornos y canales abre igual, con lo que ya tenía el monitor", async () => {
    draw({
      monitors: [monitor({ plan: { environmentId: "env-1", channel: { channelId: "c1" } } })],
      environments: pending,
      channels: pending,
    });
    fireEvent.click(await screen.findByRole("button", { name: "Editar" }));
    const dialog = within(await screen.findByRole("dialog"));
    expect((dialog.getByLabelText(/Nombre/) as HTMLInputElement).value).toBe("producción");
    expect(within(dialog.getByLabelText("Canal")).getAllByRole("option").length).toBe(1);
  });
});
