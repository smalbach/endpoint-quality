/**
 * La mitad del editor del nodo canal: con qué aterriza, qué dice el lienzo de él y lo que el servidor
 * rechazaría, dicho antes de guardar.
 *
 * Las reglas son las del motor (`stepChannelSchema` en runner-core) y las del ejecutor (un mensaje de
 * MQTT sin tema, un tema en un WebSocket), escritas otra vez porque la web no carga ese paquete en
 * ejecución. Lo que depende del canal —su protocolo, sus mensajes guardados, lo que espera— se lee
 * del canal elegido: el nodo solo guarda su id y, si quiere, su guion.
 */
import type { ChannelView, WorkflowStepView } from "@/lib/types";

export type ChannelNodeView = NonNullable<WorkflowStepView["channel"]>;
export type ScriptStepView = NonNullable<ChannelNodeView["messages"]>[number];
export type ScriptAction = ScriptStepView["action"];

/** El mismo techo que el motor: un guion más largo está describiendo otra cosa. */
export const MAX_SCRIPT_STEPS = 30;

export const PROTOCOL_LABEL: Record<ChannelView["protocol"], string> = {
  ws: "WebSocket",
  mqtt: "MQTT",
  grpc: "gRPC",
  socketio: "Socket.IO",
};

/** Un nodo canal recién soltado: sin canal, que el inspector elige y `channelNodeProblems` pide. */
export const defaultChannelNode = (): ChannelNodeView => ({ channelId: "" });

/** Una acción nueva del guion, con lo mínimo para ser válida en el protocolo del canal. */
export function newScriptStep(action: ScriptAction, protocol: ChannelView["protocol"] | undefined): ScriptStepView {
  if (action === "wait") return { action: "wait", messages: 1, timeoutMs: 5_000 };
  if (action === "end") return { action: "end" };
  if (protocol === "socketio") return { action: "send", body: "", event: "" };
  return protocol === "mqtt" ? { action: "send", body: "", topic: "", qos: 0 } : { action: "send", body: "" };
}

/**
 * El guion que corre de verdad: el escrito, o —sin guion— los mensajes guardados del canal en orden.
 * En gRPC, sin guion, nada más que la petición de la llamada. Es lo que el inspector enseña cuando el
 * nodo no escribe el suyo, para que «qué se manda» no sea una sorpresa.
 */
export function effectiveScript(node: ChannelNodeView, channel: ChannelView | undefined): ScriptStepView[] {
  if (node.messages) return node.messages;
  if (!channel || channel.protocol === "grpc") return [];
  return channel.messages.map((message) => ({
    action: "send" as const,
    body: message.body,
    ...(message.topic !== undefined ? { topic: message.topic } : {}),
    ...(message.qos !== undefined ? { qos: message.qos } : {}),
    ...(message.retain !== undefined ? { retain: message.retain } : {}),
    ...(message.event !== undefined ? { event: message.event } : {}),
  }));
}

/** Cuándo se da por terminada la conversación, en palabras: lo que el lienzo y el inspector dicen. */
export function untilText(node: ChannelNodeView, channel: ChannelView | undefined): string {
  const until = node.untilMessages ?? channel?.expectations.minMessages;
  if (until !== undefined) return `cierra al recibir ${until} mensaje${until === 1 ? "" : "s"}`;
  return channel?.protocol === "grpc"
    ? "cierra cuando termina la llamada"
    : "cierra por inactividad o al cerrar el otro lado";
}

/** Por qué no se puede guardar o no va a correr, en frases que nombran el nodo. */
export function channelNodeProblems(step: WorkflowStepView, channels?: ChannelView[]): string[] {
  const problems: string[] = [];
  const node = step.channel;
  if (!node?.channelId) return [`El nodo canal «${step.id}» no tiene elegido el canal que ejecuta.`];
  const channel = channels?.find((item) => item.id === node.channelId);
  if (channels && !channel) problems.push(`El nodo canal «${step.id}» apunta a un canal que ya no existe.`);
  if (step.checks?.length)
    problems.push(`El nodo canal «${step.id}» usa las comprobaciones del propio canal: escríbelas en el canal.`);
  const script = node.messages ?? [];
  if (script.length > MAX_SCRIPT_STEPS)
    problems.push(`El guion de «${step.id}» tiene más de ${MAX_SCRIPT_STEPS} acciones.`);
  script.forEach((action, index) => {
    const where = `La acción ${index + 1} de «${step.id}»`;
    if (action.action === "send") {
      if (channel?.protocol === "mqtt" && !action.topic?.trim())
        problems.push(`${where} no tiene tema: en MQTT se publica en uno.`);
      if (channel && channel.protocol !== "mqtt" && action.topic)
        problems.push(`${where} lleva tema, y solo MQTT publica en uno.`);
      if (action.topic && /[+#]/.test(action.topic)) problems.push(`${where} publica en un tema con comodines.`);
      if (channel?.protocol === "socketio" && !action.event?.trim())
        problems.push(`${where} no tiene evento: en Socket.IO se emite uno.`);
      if (channel && channel.protocol !== "socketio" && (action.event !== undefined || action.ack !== undefined))
        problems.push(`${where} emite un evento, y solo Socket.IO los emite.`);
      if (action.delayMs !== undefined && (action.delayMs < 0 || action.delayMs > 30_000))
        problems.push(`${where} espera más de 30 000 ms antes de mandar.`);
    }
    if (action.action === "wait") {
      if (!(action.messages >= 1)) problems.push(`${where} espera a cero mensajes.`);
      if (!(action.timeoutMs >= 1 && action.timeoutMs <= 60_000)) problems.push(`${where} espera entre 1 y 60 000 ms.`);
    }
  });
  if (node.request !== undefined && channel && channel.protocol !== "grpc")
    problems.push(`«${step.id}» lleva una petición gRPC, y el canal no es gRPC.`);
  if (node.idleMs !== undefined && (node.idleMs < 100 || node.idleMs > 60_000))
    problems.push(`La inactividad de «${step.id}» va de 100 a 60 000 ms.`);
  return problems;
}

/**
 * Lo que las capturas pueden leer antes de que el nodo corra: la forma de la conversación con un
 * mensaje de ejemplo —el último guardado del canal, si es JSON— para que las sugerencias ofrezcan
 * `last.campo` como en cualquier otro nodo.
 */
export function channelSampleBody(channel: ChannelView | undefined): unknown {
  const sample = channel?.messages.at(-1)?.body;
  let parsed: unknown = null;
  if (sample) {
    try {
      parsed = JSON.parse(sample);
    } catch {
      parsed = null;
    }
  }
  return { messages: parsed === null ? [] : [parsed], last: parsed, count: parsed === null ? 0 : 1, closeCode: null };
}
