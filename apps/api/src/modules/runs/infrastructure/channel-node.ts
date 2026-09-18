/**
 * El caso que deja un nodo canal: una fila de paso que se lee como la de una petición, con la
 * conversación donde iría la respuesta.
 *
 * Fuera del orquestador por lo mismo que `mock-node.ts`: nada de esto toca el recorrido. Es cómo se
 * traduce el veredicto de una conversación —que ya decidió `evaluateConversation`, en un solo sitio—
 * al modelo de una corrida: pasa o falla, de quién es el fallo, qué se afirmó y qué se ve al abrir el
 * caso.
 *
 * **Dos copias de lo recibido, a propósito.** Lo que se guarda en la fila del paso sale de la
 * transcripción de la sesión, que viene tapada desde `applyFrame`: el informe lo leen personas a las
 * que el botón de revelar dice que no. Lo que leen las capturas y los pasos siguientes es lo recibido
 * sin tapar, que vive en memoria lo que dura la corrida, igual que la respuesta de una petición.
 */
import {
  applyCaptures,
  conversationResponse,
  holds,
  type ActualResponse,
  type Assertion,
  type ChannelMessage,
  type FailureKind,
  type RuntimeVariables,
  type StepChannel,
  type StepRequest,
  type WorkflowStep,
} from "@eq/runner-core";

import type { HeadlessOutcome } from "@/modules/channels/application/headless-session";
import { defaultScript } from "@/modules/channels/application/headless-session";
import type { Channel } from "@/modules/channels/domain/model";
import type { RunCase } from "../domain/model";
import type { ExecutedStep } from "./case-executor";

/** Cuántos mensajes de la transcripción entran en el caso. La sesión entera está en el canal. */
export const TRANSCRIPT_EXCERPT = 40;
/** Y cuánto de cada uno: un informe no es el sitio de una trama de 64 KB. */
const EXCERPT_BODY = 2_000;

const PROTOCOL: Record<Channel["protocol"], { method: string; name: string }> = {
  ws: { method: "WS", name: "WebSocket" },
  mqtt: { method: "MQTT", name: "MQTT" },
  grpc: { method: "GRPC", name: "gRPC" },
};

const STOP_TEXT: Record<string, string> = {
  "closed-by-peer": "el servidor cerró la conexión",
  "closed-by-us": "cerrada al llegar lo esperado",
  "message-cap": "se cortó: tope de mensajes",
  "byte-cap": "se cortó: tope de bytes recibidos",
  "time-cap": "se cortó: tope de duración",
  "idle-cap": "se cortó: demasiado tiempo sin mensajes",
  cancelled: "se canceló",
  "handshake-failed": "no llegó a abrir",
  "transport-error": "la conexión se rompió",
};

export function channelStep(
  step: WorkflowStep,
  runCase: RunCase,
  outcome: HeadlessOutcome,
  variables: RuntimeVariables,
): {
  executed: ExecutedStep;
  /** La conversación sin tapar, para los pasos siguientes. `null` si no llegó a abrirse. */
  actual: ActualResponse | null;
  caseFields: Pick<RunCase, "method" | "path">;
} {
  const node = step.channel as StepChannel;
  const channel = outcome.channel;
  const caseFields = channel
    ? { method: PROTOCOL[channel.protocol].method, path: `«${channel.name}»` }
    : { method: runCase.method, path: runCase.path };
  const request: StepRequest = {
    index: 0,
    purpose: "act",
    label: "Canal",
    operationId: "",
    method: caseFields.method,
    operationPath: caseFields.path,
    requestPath: "",
    expectedStatus: 0,
    expectedShape: "",
    auth: "none",
    samples: 1,
  };
  // El guion tal como se escribió, con sus `{{variables}}` sin resolver: un valor sacado del entorno
  // puede ser un secreto, y lo que viajó de verdad —ya tapado— está en la transcripción.
  const sent: ExecutedStep["sent"] = {
    method: caseFields.method,
    url: channel?.name ?? node.channelId,
    headers: {},
    body: {
      messages: node.messages ?? (channel ? defaultScript(channel) : []),
      ...(node.request !== undefined ? { request: node.request } : {}),
    },
  };
  const base = { request, sent, latency: { samples: [], budgetMs: null } };

  if (outcome.kind === "refused") {
    return {
      executed: {
        ...base,
        ok: false,
        // Nadie llegó a llamar: el canal, el entorno o el guion no dejan abrir.
        failure: "config",
        actual: null,
        durationMs: 0,
        assertions: [{ label: "Sesión de canal", pass: false, detail: outcome.detail }],
      },
      actual: null,
      caseFields,
    };
  }

  const { session, received, problems } = outcome;
  const conversation = session.conversation;
  const verdict = session.verdict;
  const durationMs = conversation.closedAtMs ?? conversation.messages.at(-1)?.atMs ?? 0;
  const actual = conversationResponse({
    received,
    handshake: conversation.handshake,
    closeCode: conversation.closeCode,
  });

  const assertions: Assertion[] = [
    {
      label: "Sesión de canal",
      pass: true,
      detail: `«${outcome.channel.name}» (${PROTOCOL[outcome.channel.protocol].name}) · sesión ${session.id} · ${
        STOP_TEXT[session.stopReason ?? ""] ?? session.stopReason ?? "cerrada"
      } · ${conversation.counters.sent} enviados, ${conversation.counters.received} recibidos`,
    },
    ...(verdict?.assertions ?? []),
    ...problems.map((detail) => ({ label: "Guion", pass: false, detail })),
  ];
  let captured = true;
  if (step.captures?.length) {
    const capture = applyCaptures(step.captures, actual, variables, step.id);
    captured = capture.missing.length === 0;
    assertions.push({
      label: "Variables capturadas",
      pass: captured,
      detail: captured ? capture.captured.join(", ") : `No se encontraron: ${capture.missing.join(", ")}`,
    });
  }
  const ok = holds(assertions);
  // De quién es el rojo: el del veredicto cuando lo hay —conexión, comprobación, latencia—; un guion
  // que no se pudo mandar es de configuración; una captura sin nada que leer, del flujo.
  const failure: FailureKind | null = ok
    ? null
    : verdict && !verdict.ok
      ? (verdict.failure ?? "check")
      : problems.length
        ? "config"
        : captured
          ? "check"
          : "flow";

  return {
    executed: {
      ...base,
      ok,
      failure,
      durationMs,
      actual: stored(conversation.messages, conversation.handshake, conversation.closeCode, session.id),
      assertions,
    },
    actual,
    caseFields,
  };
}

/**
 * La copia del informe: la misma forma que leen las capturas, pero hecha de la transcripción tapada,
 * más un extracto de la conversación entera —enviados, recibidos y el cierre— para leer el caso sin
 * ir al canal. La sesión completa sigue en su historial, con su id.
 */
function stored(
  messages: ChannelMessage[],
  handshake: { status: number; headers: Record<string, string> } | null,
  closeCode: number | null,
  sessionId: string,
): ActualResponse {
  const shaped = conversationResponse({
    received: messages
      .filter((message) => message.direction === "in")
      .map((message) => ({ body: message.body, ...(message.topic !== undefined ? { topic: message.topic } : {}) })),
    handshake,
    closeCode,
  });
  const transcript = messages.slice(0, TRANSCRIPT_EXCERPT).map((message) => ({
    seq: message.seq,
    direction: message.direction,
    atMs: message.atMs,
    body: message.body.length > EXCERPT_BODY ? `${message.body.slice(0, EXCERPT_BODY)}…` : message.body,
    bytes: message.bytes,
    ...(message.topic !== undefined ? { topic: message.topic } : {}),
  }));
  return {
    ...shaped,
    body: {
      ...(shaped.body as Record<string, unknown>),
      sessionId,
      transcript,
      ...(messages.length > TRANSCRIPT_EXCERPT ? { omitted: messages.length - TRANSCRIPT_EXCERPT } : {}),
    },
  };
}
