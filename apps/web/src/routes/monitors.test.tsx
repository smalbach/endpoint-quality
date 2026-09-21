/**
 * La pantalla de monitores.
 *
 * Lo que se comprueba es lo que decide algo:
 *
 * - **La racha de fallos se ve aunque no haya canal de aviso**, y se dice que nadie está siendo
 *   avisado. Un monitor en rojo que no avisa a nadie es peor que uno que no existe.
 * - **Sin entornos no se puede crear**, y se dice por qué en vez de dejar un formulario que va a
 *   fallar.
 * - **El aviso pide el nombre de una variable.** Pegar una URL ahí no deja crear: quien tiene una
 *   URL de webhook puede escribir en ese canal.
 * - **El correo, en cambio, pide direcciones y las manda tal cual.** Es la otra cara de lo mismo:
 *   una dirección no autoriza nada. Se valida con la misma expresión y el mismo tope que la API,
 *   para decirlo antes de enviar y no después.
 * - **El horario propone la zona del navegador**, que es la hora que quiere decir quien lo escribe.
 * - **Una vuelta saltada dice por qué**, porque «no corrió» y «corrió y falló» no son lo mismo.
 */
import { describe, expect, test, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";

import { MonitorsPage } from "@/routes/monitors";
import { ToastProvider } from "@/components/toast";
import type { MonitorExecutionView, MonitorListView, MonitorView } from "@/lib/types";

const call = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", async (original) => ({
  ...(await original<object>()),
  api: call,
}));
vi.mock("@/lib/auth", () => ({ useOrganization: () => ({ id: "o", name: "Org" }), useCan: () => true }));

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

const monitor = (patch: Partial<MonitorView & { recent: MonitorExecutionView[] }> = {}) => ({
  id: "m1",
  name: "producción",
  enabled: true,
  schedule: { kind: "interval" as const, minutes: 60 },
  plan: { environmentId: "env-1" },
  alert: null,
  nextRunAt: "2026-03-01T11:00:00.000Z",
  lastRunAt: "2026-03-01T10:00:00.000Z",
  lastOutcome: "passed" as const,
  consecutiveFailures: 0,
  createdAt: "2026-03-01T09:00:00.000Z",
  updatedAt: "2026-03-01T09:00:00.000Z",
  createdBy: "u1",
  scheduleLabel: "cada hora",
  recent: [execution()],
  archivedAt: null,
  deletedAt: null,
  ...patch,
});

/** La pantalla pide tres cosas: los monitores, los entornos y los flujos. */
function answers(
  list: Partial<MonitorListView> = {},
  environments: { id: string; name: string }[] = [{ id: "env-1", name: "producción" }],
) {
  call.mockReset();
  call.mockImplementation((path: string, options?: { method?: string }) => {
    if (options?.method === "POST") return Promise.resolve(monitor());
    // Con estado o sin él: la papelera se pide con `?state=deleted` y contesta la misma lista, que
    // es lo que hace falta para comprobar qué se pide y qué botones salen en cada filtro.
    if (path.includes("/monitors")) return Promise.resolve({ monitors: [monitor()], ...list });
    if (path.endsWith("/environments")) return Promise.resolve(environments);
    if (path.endsWith("/channels"))
      return Promise.resolve({ channels: [{ id: "c1", name: "eco", protocol: "ws", messages: [] }] });
    return Promise.resolve({ workflows: [{ id: "w1", name: "el alta" }], suites: [] });
  });
}

function draw() {
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

describe("la pantalla de monitores", () => {
  test("enseña el estado, el horario y cuándo le toca", async () => {
    answers();
    draw();
    await waitFor(() => expect(screen.getByText("producción")).toBeTruthy());
    expect(screen.getByText("verde")).toBeTruthy();
    expect(screen.getByText("cada hora")).toBeTruthy();
    expect(screen.getByText(/Le toca el/)).toBeTruthy();
  });

  test("la tarjeta dice qué corre: el canal con su protocolo, el flujo por su nombre o la matriz", async () => {
    answers({
      monitors: [
        monitor({ id: "m1", name: "socket", plan: { environmentId: "env-1", channel: { channelId: "c1" } } }),
        monitor({ id: "m2", name: "alta", plan: { environmentId: "env-1", workflowId: "w1" } }),
        monitor({ id: "m3", name: "todo", plan: { environmentId: "env-1" } }),
        monitor({ id: "m4", name: "huérfano", plan: { environmentId: "env-1", channel: { channelId: "borrado" } } }),
      ],
    });
    draw();
    await waitFor(() => expect(screen.getByText(/Corre el canal «eco» · WebSocket/)).toBeTruthy());
    expect(screen.getByText(/Corre el flujo «el alta»/)).toBeTruthy();
    expect(screen.getByText(/Corre la matriz del contrato/)).toBeTruthy();
    expect(screen.getByText(/Corre un canal que ya no existe/)).toBeTruthy();
  });

  test("un monitor pausado no le toca nunca, y lo dice así", async () => {
    answers({ monitors: [monitor({ enabled: false, nextRunAt: null })] });
    draw();
    await waitFor(() => expect(screen.getByText("pausado")).toBeTruthy());
    expect(screen.getByText(/no le toca nunca/)).toBeTruthy();
  });

  test("la racha de fallos sale aunque no haya canal, y se dice que nadie recibe el aviso", async () => {
    answers({
      monitors: [
        monitor({
          consecutiveFailures: 4,
          lastOutcome: "failed",
          alert: null,
          recent: [execution({ outcome: "failed", totals: { cases: 12, passed: 8, failed: 4 } })],
        }),
      ],
    });
    draw();
    await waitFor(() => expect(screen.getByText("4 fallos seguidos")).toBeTruthy());
    // Un monitor en rojo que no avisa a nadie es peor que uno que no existe.
    expect(screen.getByText(/no avisa a nadie/)).toBeTruthy();
  });

  test("una vuelta saltada dice por qué: «no corrió» no es «corrió y falló»", async () => {
    answers({
      monitors: [
        monitor({
          recent: [
            execution({
              outcome: "skipped",
              totals: null,
              note: "La corrida anterior de este monitor seguía en marcha",
            }),
          ],
        }),
      ],
    });
    draw();
    await waitFor(() => expect(screen.getByText(/seguía en marcha/)).toBeTruthy());
  });

  test("sin entornos no se puede crear, y se dice por qué", async () => {
    answers({ monitors: [] }, []);
    draw();
    await waitFor(() => expect(screen.getByText(/no tiene ningún entorno/)).toBeTruthy());
    // Y no se ofrece un formulario que iba a fallar.
    expect(screen.queryByText("Crear un monitor")).toBeNull();
  });

  test("el horario diario propone la zona del navegador y lo dice", async () => {
    answers({ monitors: [] });
    draw();
    await waitFor(() => expect(screen.getByText("Crear un monitor")).toBeTruthy());
    fireEvent.click(screen.getByText("Crear un monitor"));
    const dialog = within(await screen.findByRole("dialog"));

    fireEvent.change(dialog.getByLabelText("Tipo de horario"), { target: { value: "daily" } });
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
    // Guardarlo en UTC dejaría el monitor una hora corrido media año.
    expect(dialog.getByText(new RegExp(`En tu zona: ${zone}`))).toBeTruthy();
  });

  test("una URL pegada en el campo del aviso no deja crear", async () => {
    answers({ monitors: [] });
    draw();
    await waitFor(() => expect(screen.getByText("Crear un monitor")).toBeTruthy());
    fireEvent.click(screen.getByText("Crear un monitor"));
    const dialog = within(await screen.findByRole("dialog"));

    fireEvent.change(dialog.getByLabelText(/Nombre/), { target: { value: "con aviso" } });
    fireEvent.click(dialog.getByLabelText("Avisar cuando se ponga en rojo"));
    fireEvent.change(dialog.getByLabelText(/Variable del entorno/), {
      target: { value: "https://hooks.slack.test/xyz" },
    });

    expect(dialog.getByRole("button", { name: "Crear" }).hasAttribute("disabled")).toBe(true);
    expect(dialog.getByText(/nombre de variable/)).toBeTruthy();

    fireEvent.change(dialog.getByLabelText(/Variable del entorno/), { target: { value: "SLACK_WEBHOOK" } });
    expect(dialog.getByRole("button", { name: "Crear" }).hasAttribute("disabled")).toBe(false);
  });

  test("la tarjeta dice a quién avisa, con las direcciones enteras", async () => {
    answers({
      monitors: [
        monitor({
          alert: { channel: "email", recipients: ["guardia@ejemplo.com", "jefa@ejemplo.com"], afterFailures: 2 },
        }),
      ],
    });
    draw();
    // Esconder la dirección desmontaría el argumento para guardarla en claro: se guarda así
    // precisamente para poder ver a quién se está despertando.
    await waitFor(() => expect(screen.getByText(/guardia@ejemplo.com, jefa@ejemplo.com/)).toBeTruthy());
    expect(screen.getByText(/tras 2 fallos seguidos/)).toBeTruthy();
  });

  test("el canal correo cambia el campo: direcciones en claro, y ningún nombre de variable", async () => {
    answers({ monitors: [] });
    draw();
    await waitFor(() => expect(screen.getByText("Crear un monitor")).toBeTruthy());
    fireEvent.click(screen.getByText("Crear un monitor"));
    const dialog = within(await screen.findByRole("dialog"));

    fireEvent.change(dialog.getByLabelText(/Nombre/), { target: { value: "por correo" } });
    fireEvent.click(dialog.getByLabelText("Avisar cuando se ponga en rojo"));
    fireEvent.change(dialog.getByLabelText("Canal"), { target: { value: "email" } });

    // El campo del otro canal desaparece: pedir el nombre de una variable para un correo sería
    // pedir algo que nadie va a leer.
    expect(dialog.queryByLabelText(/Variable del entorno/)).toBeNull();
    expect(dialog.getByRole("button", { name: "Crear" }).hasAttribute("disabled")).toBe(true);

    fireEvent.change(dialog.getByLabelText(/Destinatarios/), { target: { value: "no-es-un-correo" } });
    expect(dialog.getByText(/no es una dirección de correo/)).toBeTruthy();
    expect(dialog.getByRole("button", { name: "Crear" }).hasAttribute("disabled")).toBe(true);

    // Separadas por comas, que es como vienen pegadas de un chat.
    fireEvent.change(dialog.getByLabelText(/Destinatarios/), {
      target: { value: "guardia@ejemplo.com, jefa@ejemplo.com" },
    });
    expect(dialog.getByRole("button", { name: "Crear" }).hasAttribute("disabled")).toBe(false);

    fireEvent.click(dialog.getByRole("button", { name: "Crear" }));
    await waitFor(() => {
      const post = call.mock.calls.find(([, options]) => options?.method === "POST");
      expect(post).toBeTruthy();
      expect(post![1].body.alert).toEqual({
        channel: "email",
        recipients: ["guardia@ejemplo.com", "jefa@ejemplo.com"],
        afterFailures: 1,
      });
    });
  });

  test("seis destinatarios no son un aviso: son una lista de distribución", async () => {
    answers({ monitors: [] });
    draw();
    await waitFor(() => expect(screen.getByText("Crear un monitor")).toBeTruthy());
    fireEvent.click(screen.getByText("Crear un monitor"));
    const dialog = within(await screen.findByRole("dialog"));

    fireEvent.change(dialog.getByLabelText(/Nombre/), { target: { value: "demasiados" } });
    fireEvent.click(dialog.getByLabelText("Avisar cuando se ponga en rojo"));
    fireEvent.change(dialog.getByLabelText("Canal"), { target: { value: "email" } });
    fireEvent.change(dialog.getByLabelText(/Destinatarios/), {
      target: { value: Array.from({ length: 6 }, (_, index) => `p${index}@ejemplo.com`).join(", ") },
    });

    // El mismo tope que la API: una lista más larga se hace en el servidor de correo, donde
    // alguien puede darse de baja.
    expect(dialog.getByText(/Como mucho 5 destinatarios/)).toBeTruthy();
    expect(dialog.getByRole("button", { name: "Crear" }).hasAttribute("disabled")).toBe(true);
  });

  test("elegir un flujo sin decir cuál no deja crear", async () => {
    answers({ monitors: [] });
    draw();
    await waitFor(() => expect(screen.getByText("Crear un monitor")).toBeTruthy());
    fireEvent.click(screen.getByText("Crear un monitor"));
    const dialog = within(await screen.findByRole("dialog"));

    fireEvent.change(dialog.getByLabelText(/Nombre/), { target: { value: "un flujo" } });
    fireEvent.change(dialog.getByLabelText("Qué corre"), { target: { value: "flow" } });
    expect(dialog.getByRole("button", { name: "Crear" }).hasAttribute("disabled")).toBe(true);

    fireEvent.change(dialog.getByLabelText("Flujo"), { target: { value: "w1" } });
    expect(dialog.getByRole("button", { name: "Crear" }).hasAttribute("disabled")).toBe(false);
  });

  test("un monitor puede vigilar un canal sin flujo, con su guion o con los mensajes guardados", async () => {
    answers({ monitors: [] });
    draw();
    await waitFor(() => expect(screen.getByText("Crear un monitor")).toBeTruthy());
    fireEvent.click(screen.getByText("Crear un monitor"));
    const dialog = within(await screen.findByRole("dialog"));

    fireEvent.change(dialog.getByLabelText(/Nombre/), { target: { value: "el socket" } });
    fireEvent.change(dialog.getByLabelText("Qué corre"), { target: { value: "channel" } });
    expect(dialog.getByRole("button", { name: "Crear" }).hasAttribute("disabled")).toBe(true);
    await waitFor(() => expect(dialog.getByRole("option", { name: "eco · WebSocket" })).toBeTruthy());
    fireEvent.change(dialog.getByLabelText("Canal"), { target: { value: "c1" } });
    expect(dialog.getByLabelText("Mandar los mensajes guardados del canal, en orden")).toBeTruthy();
    fireEvent.click(dialog.getByRole("button", { name: "Crear" }));

    await waitFor(() => {
      const post = call.mock.calls.find(([, options]) => options?.method === "POST");
      expect(post).toBeTruthy();
      expect(post![1].body.plan).toEqual({ environmentId: "env-1", channel: { channelId: "c1" } });
    });
  });

  test("crear manda el horario y el plan que se eligieron", async () => {
    answers({ monitors: [] });
    draw();
    await waitFor(() => expect(screen.getByText("Crear un monitor")).toBeTruthy());
    fireEvent.click(screen.getByText("Crear un monitor"));
    const dialog = within(await screen.findByRole("dialog"));

    fireEvent.change(dialog.getByLabelText(/Nombre/), { target: { value: "cada 15" } });
    fireEvent.change(dialog.getByLabelText("Intervalo"), { target: { value: "15" } });
    fireEvent.click(dialog.getByRole("button", { name: "Crear" }));

    await waitFor(() => {
      const post = call.mock.calls.find(([, options]) => options?.method === "POST");
      expect(post).toBeTruthy();
      expect(post![1].body).toEqual({
        name: "cada 15",
        schedule: { kind: "interval", minutes: 15 },
        plan: { environmentId: "env-1" },
      });
    });
  });

  test("editar abre el formulario relleno y guarda con PATCH sin tocar el horario ni el resto del plan", async () => {
    answers({
      monitors: [
        monitor({
          plan: { environmentId: "env-1", workflowId: "w1", datasetId: "d1", labels: ["humo"] },
          alert: { channel: "slack", urlVariable: "SLACK_WEBHOOK", afterFailures: 2 },
        }),
      ],
    });
    draw();
    await waitFor(() => expect(screen.getByText("Editar")).toBeTruthy());
    fireEvent.click(screen.getByText("Editar"));
    const dialog = within(await screen.findByRole("dialog"));

    expect((dialog.getByLabelText(/Nombre/) as HTMLInputElement).value).toBe("producción");
    expect((dialog.getByLabelText("Intervalo") as HTMLSelectElement).value).toBe("60");
    expect((dialog.getByLabelText("Flujo") as HTMLSelectElement).value).toBe("w1");
    expect((dialog.getByLabelText(/Variable del entorno/) as HTMLInputElement).value).toBe("SLACK_WEBHOOK");

    fireEvent.change(dialog.getByLabelText(/Nombre/), { target: { value: "producción nueva" } });
    fireEvent.click(dialog.getByRole("button", { name: "Guardar" }));

    await waitFor(() => {
      const patch = call.mock.calls.find(([, options]) => options?.method === "PATCH");
      expect(patch).toBeTruthy();
      expect(patch![0]).toMatch(/\/monitors\/m1$/);
      // Sin `schedule`: la API recalcula el turno cuando lo recibe, y aquí no cambió.
      expect(patch![1].body).toEqual({
        name: "producción nueva",
        plan: { environmentId: "env-1", workflowId: "w1", datasetId: "d1", labels: ["humo"] },
        alert: { channel: "slack", urlVariable: "SLACK_WEBHOOK", afterFailures: 2 },
      });
    });
  });

  test("al editar, un horario cambiado viaja con la zona del monitor, y quitar el aviso manda null", async () => {
    answers({
      monitors: [
        monitor({
          schedule: { kind: "daily", hour: 9, minute: 0, timeZone: "Europe/Madrid" },
          alert: { channel: "email", recipients: ["guardia@ejemplo.com"], afterFailures: 1 },
        }),
      ],
    });
    draw();
    await waitFor(() => expect(screen.getByText("Editar")).toBeTruthy());
    fireEvent.click(screen.getByText("Editar"));
    const dialog = within(await screen.findByRole("dialog"));

    // La zona es la del monitor, no la del navegador de quien lo abre.
    expect(dialog.getByText(/En tu zona: Europe\/Madrid/)).toBeTruthy();
    fireEvent.change(dialog.getByLabelText("Hora"), { target: { value: "7" } });
    fireEvent.click(dialog.getByLabelText("Avisar cuando se ponga en rojo"));
    fireEvent.click(dialog.getByRole("button", { name: "Guardar" }));

    await waitFor(() => {
      const patch = call.mock.calls.find(([, options]) => options?.method === "PATCH");
      expect(patch![1].body).toEqual({
        name: "producción",
        schedule: { kind: "daily", hour: 7, minute: 0, timeZone: "Europe/Madrid" },
        plan: { environmentId: "env-1" },
        alert: null,
      });
    });
  });

  test("eliminar avisa de que el horario y el historial se guardan, y ofrece archivar", async () => {
    answers();
    draw();
    await waitFor(() => expect(screen.getByText("Eliminar")).toBeTruthy());
    fireEvent.click(screen.getByText("Eliminar"));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/deja de correr en el acto/)).toBeTruthy();
    expect(within(dialog).getByText(/al restaurarlo vuelve con los dos/)).toBeTruthy();
    expect(within(dialog).getByText(/Se puede restaurar desde el filtro/)).toBeTruthy();
    expect(within(dialog).getByRole("button", { name: "Archivar" })).toBeTruthy();
  });

  test("el filtro pide la papelera al servidor, y desde ahí se restaura", async () => {
    answers();
    draw();
    await waitFor(() => expect(screen.getByText("producción")).toBeTruthy());
    fireEvent.click(screen.getByRole("tab", { name: /Eliminados/ }));
    await waitFor(() =>
      expect(call.mock.calls.some(([path]) => String(path).includes("/monitors?state=deleted"))).toBe(true),
    );
    // El doble de la API contesta la misma lista para cualquier estado, así que la fila sigue ahí
    // y lo que se comprueba es que la papelera se pide y que «Restaurar» llama a su ruta.
    fireEvent.click((await screen.findAllByRole("button", { name: "Restaurar" }))[0]);
    await waitFor(() =>
      expect(call.mock.calls.some(([path]) => String(path).endsWith("/monitors/m1/restore"))).toBe(true),
    );
  });
});
