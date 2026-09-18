/**
 * El nodo `channel`: un canal —WebSocket, MQTT o gRPC— ejecutado como un paso de un flujo.
 *
 * Lo que el nodo guarda es poco a propósito: **qué canal** (por id) y, si quiere, **qué se le manda**.
 * La URL, las cabeceras, la autenticación, los topes y lo que se espera de la conversación son del
 * canal y se leen al correr. Copiarlos al nodo serían dos respuestas a «¿qué espera este socket?» que
 * dejan de coincidir el día que alguien edita una de las dos; y el veredicto de un canal ya se decide
 * en un solo sitio (`evaluateConversation`).
 *
 * El guion es la parte que un flujo sí necesita decidir: una sesión interactiva la conduce alguien
 * pulsando «Enviar», y una corrida no tiene a nadie. Tres acciones y ninguna más:
 *
 * - `send` manda un texto (con `{{variables}}` de la corrida), tras `delayMs` si lo pide. En MQTT
 *   lleva su tema, QoS y `retain`, como un mensaje guardado.
 * - `wait` espera a que lleguen `messages` mensajes **más**, como mucho `timeoutMs`. Es lo que hace
 *   que «manda el login, espera el ok, manda la suscripción» no dependa de la suerte.
 * - `end` termina de mandar sin cerrar: el medio cierre de un stream de cliente gRPC.
 *
 * Y el final: la sesión se cierra cuando llegan `untilMessages` mensajes (por defecto, los que el
 * canal espera), cuando el otro lado cierra, o cuando salta un tope del canal. `idleMs` solo puede
 * **bajar** la inactividad del canal: una corrida no puede pedir más tiempo del que el canal permite.
 */
import { z } from "zod";

import type { ActualResponse } from "./assertions.ts";
import { publishTopicProblem } from "./mqtt-topic.ts";

/** Cuántas acciones lleva un guion. Un flujo que necesita más está describiendo otra cosa. */
export const MAX_CHANNEL_SCRIPT_STEPS = 30;
/** El mismo techo que un mensaje guardado del canal: lo que se manda a mano y lo que manda un flujo. */
export const MAX_CHANNEL_SCRIPT_BODY = 64 * 1024;

export type ChannelScriptSend = {
  action: "send";
  body: string;
  /** Solo MQTT: dónde se publica. Sin comodines, como al publicar a mano. */
  topic?: string;
  qos?: 0 | 1 | 2;
  retain?: boolean;
  /** Pausa antes de mandarlo. */
  delayMs?: number;
};
export type ChannelScriptWait = { action: "wait"; messages: number; timeoutMs: number };
export type ChannelScriptEnd = { action: "end" };
export type ChannelScriptStep = ChannelScriptSend | ChannelScriptWait | ChannelScriptEnd;

export type StepChannel = {
  channelId: string;
  /**
   * Lo que se manda, en orden. **Ausente** es «lo que el canal tiene guardado», en su orden; una
   * lista vacía es «no mandes nada, solo escucha», que no es lo mismo y por eso se distingue.
   */
  messages?: ChannelScriptStep[];
  /** Solo gRPC: la petición de la llamada, en lugar de la guardada en el canal. JSON con `{{variables}}`. */
  request?: string;
  /** Con cuántos mensajes recibidos se da la conversación por terminada. Ausente: el `minMessages` del canal. */
  untilMessages?: number;
  /** La inactividad de esta corrida, **por debajo** de la del canal. */
  idleMs?: number;
};

const sendSchema = z.object({
  action: z.literal("send"),
  body: z.string().max(MAX_CHANNEL_SCRIPT_BODY, "un mensaje tiene como mucho 64 KB"),
  topic: z
    .string()
    .max(1024)
    .optional()
    .superRefine((topic, context) => {
      const problem = topic === undefined ? null : publishTopicProblem(topic);
      if (problem) context.addIssue({ code: "custom", message: problem });
    }),
  qos: z.union([z.literal(0), z.literal(1), z.literal(2)]).optional(),
  retain: z.boolean().optional(),
  delayMs: z.number().int().min(0).max(30_000).optional(),
});

export const stepChannelSchema = z.object({
  channelId: z.string().uuid("elige el canal que ejecuta"),
  messages: z
    .array(
      z.discriminatedUnion("action", [
        sendSchema,
        z.object({
          action: z.literal("wait"),
          messages: z.number().int().min(1).max(1_000),
          timeoutMs: z.number().int().min(1).max(60_000),
        }),
        z.object({ action: z.literal("end") }),
      ]),
    )
    .max(MAX_CHANNEL_SCRIPT_STEPS, `un guion tiene como mucho ${MAX_CHANNEL_SCRIPT_STEPS} acciones`)
    .optional(),
  request: z.string().max(MAX_CHANNEL_SCRIPT_BODY).optional(),
  untilMessages: z.number().int().min(1).max(10_000).optional(),
  idleMs: z.number().int().min(100).max(60_000).optional(),
});

/** Un mensaje recibido tal como lo lee una captura: el texto y, en MQTT, su tema. */
export type ReceivedMessage = { body: string; topic?: string };

/**
 * La conversación, con la forma de una respuesta: lo que leen las capturas, un `If` o un script.
 *
 * Así el nodo no inventa un modelo de captura propio: `from: body, path: last.token` saca el token del
 * último mensaje, `messages.0.id` el del primero, y `regex` busca en todos los recibidos, uno por
 * línea. Cada mensaje entra parseado si es JSON y como texto si no. El estado es el del saludo (101,
 * el 0 de un `CONNACK`) y, cuando la conversación cerró con un código, `closeCode` lo dice.
 *
 * Quien llama decide qué textos entran: para las capturas, los recibidos **sin tapar** —una variable
 * con `••••••••` no le sirve al paso siguiente—, y lo que se guarda en el informe sale siempre de la
 * transcripción, que ya viene tapada.
 */
export function conversationResponse(input: {
  received: ReceivedMessage[];
  handshake: { status: number; headers: Record<string, string> } | null;
  closeCode: number | null;
}): ActualResponse {
  const messages = input.received.map((message) => parsed(message.body));
  return {
    status: input.handshake?.status ?? 0,
    statusText: "",
    contentType: "application/json",
    headers: input.handshake?.headers ?? {},
    body: {
      messages,
      last: messages.length ? messages[messages.length - 1] : null,
      count: messages.length,
      topics: input.received.map((message) => message.topic ?? null),
      closeCode: input.closeCode,
    },
    raw: input.received.map((message) => message.body).join("\n"),
  };
}

function parsed(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
