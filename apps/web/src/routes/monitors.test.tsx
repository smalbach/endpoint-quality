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
    if (path.endsWith("/monitors")) return Promise.resolve({ monitors: [monitor()], ...list });
    if (path.endsWith("/environments")) return Promise.resolve(environments);
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

  test("eliminar avisa de que el historial se va y las corridas se quedan", async () => {
    answers();
    draw();
    await waitFor(() => expect(screen.getByText("Eliminar")).toBeTruthy());
    fireEvent.click(screen.getByText("Eliminar"));
    await waitFor(() => expect(screen.getByText(/su historial se va con él/)).toBeTruthy());
    expect(screen.getByText(/se quedan donde están/)).toBeTruthy();
  });
});
