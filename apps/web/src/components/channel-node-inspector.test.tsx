/**
 * El inspector del nodo canal, montado dentro del inspector de verdad.
 *
 * Lo que decide algo:
 *
 * - **El selector sale de los canales del proyecto**, con su protocolo, y elegir escribe solo el id.
 * - **Sin guion propio se enseña lo que se va a mandar**: los mensajes guardados del canal. Pasar a un
 *   guion propio los copia como punto de partida; volver deja el campo ausente, que no es lo mismo que
 *   una lista vacía («solo escucha»).
 * - **Lo propio del protocolo aparece con él**: tema y QoS en MQTT, la petición y «Terminar envío» en gRPC.
 */
import { useState } from "react";
import { describe, expect, test } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";

import { WorkflowInspector } from "@/components/workflow-inspector";
import type { ChannelView, WorkflowStepView, WorkflowView } from "@/lib/types";

const WS_ID = "00000000-0000-4000-8000-000000000001";
const MQTT_ID = "00000000-0000-4000-8000-000000000002";
const GRPC_ID = "00000000-0000-4000-8000-000000000003";

const channel = (patch: Partial<ChannelView>): ChannelView => ({
  id: WS_ID,
  protocol: "ws",
  name: "chat",
  url: "{{wsBase}}/chat",
  subprotocols: [],
  headers: [],
  auth: null,
  limits: { maxMessages: 200, maxBytes: 1_048_576, maxMessageBytes: 65_536, maxDurationMs: 30_000, idleMs: 10_000 },
  expectations: { minMessages: 2 },
  messages: [{ name: "auth", body: '{"auth":"{{token}}"}' }],
  mqtt: null,
  grpc: null,
  orderIndex: 0,
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
  ...patch,
});

const CHANNELS = [
  channel({}),
  channel({ id: MQTT_ID, protocol: "mqtt", name: "sensores", messages: [] }),
  channel({
    id: GRPC_ID,
    protocol: "grpc",
    name: "tienda",
    messages: [],
    expectations: { status: 0 },
    grpc: {
      source: "proto",
      service: "demo.v1.Shop",
      method: "Upload",
      message: '{"item_id":"1"}',
      deadlineMs: 5000,
    } as ChannelView["grpc"],
  }),
];

/** El inspector con estado de verdad: lo que se edita vuelve a entrar, como en la pantalla. */
function Harness({ initial, onSteps }: { initial: WorkflowStepView; onSteps?: (steps: WorkflowStepView[]) => void }) {
  const [steps, setSteps] = useState<WorkflowStepView[]>([initial]);
  return (
    <WorkflowInspector
      base="/orgs/o/projects/p"
      workflow={
        {
          id: "w1",
          name: "Flujo",
          description: null,
          status: "draft",
          definition: { steps },
        } as unknown as WorkflowView
      }
      steps={steps}
      selectedStep={initial.id}
      templates={[]}
      operations={[]}
      environments={[]}
      environmentId=""
      canEdit
      onEnvironment={() => {}}
      onRunSettings={() => {}}
      runSummary={null}
      onWorkflow={() => {}}
      onSteps={(next) => {
        setSteps(next);
        onSteps?.(next);
      }}
      onTemplate={() => {}}
      templateUsage={() => 0}
      onFork={() => {}}
      forking={false}
      onRun={() => {}}
      onDelete={() => {}}
      running={false}
      channels={CHANNELS}
    />
  );
}

const node = (channel: WorkflowStepView["channel"]): WorkflowStepView => ({ id: "canal", kind: "channel", channel });

describe("el inspector del nodo canal", () => {
  test("elige el canal de la lista y dice cuándo cierra y qué espera", () => {
    let last: WorkflowStepView[] = [];
    render(<Harness initial={node({ channelId: "" })} onSteps={(steps) => (last = steps)} />);
    expect(screen.getByText(/no tiene elegido el canal/)).toBeTruthy();

    fireEvent.change(screen.getByLabelText("Canal que ejecuta"), { target: { value: WS_ID } });
    expect(last[0]!.channel).toEqual({ channelId: WS_ID });
    expect(screen.getByText(/cierra al recibir 2 mensajes/)).toBeTruthy();
    expect(screen.queryByLabelText("Petición gRPC")).toBeNull();
  });

  test("sin guion propio enseña los mensajes guardados; con guion propio los copia y se editan", () => {
    let last: WorkflowStepView[] = [];
    render(<Harness initial={node({ channelId: WS_ID })} onSteps={(steps) => (last = steps)} />);
    fireEvent.click(screen.getByRole("tab", { name: /Guion/ }));
    expect(screen.getByText(/\{"auth":"\{\{token\}\}"\}/)).toBeTruthy();

    fireEvent.click(screen.getByLabelText(/Mandar los mensajes guardados del canal/));
    expect(last[0]!.channel!.messages).toEqual([{ action: "send", body: '{"auth":"{{token}}"}' }]);

    fireEvent.click(screen.getByRole("button", { name: "+ Esperar mensajes" }));
    fireEvent.change(screen.getByLabelText("Tiempo máximo 2"), { target: { value: "2000" } });
    expect(last[0]!.channel!.messages![1]).toEqual({ action: "wait", messages: 1, timeoutMs: 2000 });

    fireEvent.click(screen.getByRole("button", { name: "Quitar la acción 1" }));
    expect(last[0]!.channel!.messages).toEqual([{ action: "wait", messages: 1, timeoutMs: 2000 }]);
    // Sin tema ni «Terminar envío»: eso es de MQTT y de gRPC.
    expect(screen.queryByRole("button", { name: "+ Terminar envío" })).toBeNull();

    // Volver a los mensajes del canal deja el campo ausente, no una lista vacía.
    fireEvent.click(screen.getByLabelText(/Mandar los mensajes guardados del canal/));
    expect("messages" in last[0]!.channel!).toBe(false);
  });

  test("en MQTT cada mensaje lleva su tema y su QoS, y sin tema se avisa", () => {
    let last: WorkflowStepView[] = [];
    render(<Harness initial={node({ channelId: MQTT_ID, messages: [] })} onSteps={(steps) => (last = steps)} />);
    fireEvent.click(screen.getByRole("tab", { name: /Guion/ }));
    fireEvent.click(screen.getByRole("button", { name: "+ Enviar" }));
    const action = screen.getByRole("listitem", { name: "Acción 1" });
    fireEvent.change(within(action).getByLabelText("Mensaje 1"), { target: { value: '{"t":21}' } });
    fireEvent.click(screen.getByRole("tab", { name: /Canal/ }));
    expect(screen.getByText(/no tiene tema/)).toBeTruthy();

    fireEvent.click(screen.getByRole("tab", { name: /Guion/ }));
    fireEvent.change(screen.getByLabelText("Tema 1"), { target: { value: "casa/salon/temp" } });
    fireEvent.change(screen.getByLabelText("QoS 1"), { target: { value: "1" } });
    expect(last[0]!.channel!.messages).toEqual([
      { action: "send", body: '{"t":21}', topic: "casa/salon/temp", qos: 1 },
    ]);
  });

  test("en gRPC la petición del nodo sustituye a la guardada, y el guion puede terminar el envío", () => {
    let last: WorkflowStepView[] = [];
    render(<Harness initial={node({ channelId: GRPC_ID, messages: [] })} onSteps={(steps) => (last = steps)} />);
    const request = screen.getByLabelText("Petición gRPC") as HTMLTextAreaElement;
    expect(request.placeholder).toBe('{"item_id":"1"}');
    fireEvent.change(request, { target: { value: '{"item_id":"{{itemId}}"}' } });
    expect(last[0]!.channel!.request).toBe('{"item_id":"{{itemId}}"}');
    expect(screen.getByText(/cierra cuando termina la llamada/)).toBeTruthy();

    fireEvent.click(screen.getByRole("tab", { name: /Guion/ }));
    fireEvent.click(screen.getByRole("button", { name: "+ Terminar envío" }));
    expect(last[0]!.channel!.messages).toEqual([{ action: "end" }]);
  });
});
