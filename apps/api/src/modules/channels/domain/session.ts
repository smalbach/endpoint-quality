/**
 * Una sesión con un canal: la conversación, más lo que solo sabe quien tiene el reloj.
 *
 * `applyFrame` decide los topes que dependen de la trama que llega —cuántos mensajes, cuántos
 * bytes, a qué hora—. Los otros dos no pueden decidirse al llegar una trama, porque son justo la
 * **ausencia** de tramas: la inactividad y la duración contra un servidor que calla. Esos los
 * decide `onTick`, que quien tiene el socket llama cada poco con la hora. Puro también: el reloj es
 * un argumento, así que un socket colgado se prueba con dos números.
 *
 * Y el segador, que es el fallo que ninguna suite ve. Un proceso que se muere con sesiones abiertas
 * las deja `open` para siempre en la base de datos: el socket se fue con el proceso y no hay nadie
 * más a quien preguntar. Sin `isStale`, el tope de sesiones abiertas —contado de la tabla— sube y no
 * baja, hasta que nadie puede abrir un canal.
 */
import {
  applyFrame,
  blankConversation,
  evaluateConversation,
  type ChannelExpectation,
  type ChannelLimits,
  type Conversation,
  type Evaluation,
  type RawFrame,
  type RedactionRules,
  type StopReason,
} from "@eq/runner-core";

export const SESSION_STATUSES = ["connecting", "open", "closed", "error"] as const;
export type SessionStatus = (typeof SESSION_STATUSES)[number];

export type ChannelSession = {
  id: string;
  channelId: string;
  projectId: string;
  environmentId: string | null;
  status: SessionStatus;
  conversation: Conversation;
  verdict: Evaluation | null;
  stopReason: StopReason | null;
  /** La instancia que tiene el socket. Un socket es un descriptor de un proceso y no se relé. */
  ownerInstance: string;
  heartbeatAt: Date;
  openedAt: Date;
  closedAt: Date | null;
  startedBy: string;
};

/**
 * Cuántos latidos perdidos hacen muerta una sesión.
 *
 * Tres y no uno: un latido que llega tarde porque el proceso estaba ocupado —una recolección de
 * basura, una corrida pesada en el mismo proceso— no es un proceso muerto, y cerrarle la sesión a
 * alguien que la está usando es peor que tardar un poco más en limpiar la de un proceso caído.
 */
export const STALE_AFTER_BEATS = 3;

export function startSession(fields: {
  id: string;
  channelId: string;
  projectId: string;
  environmentId: string | null;
  ownerInstance: string;
  startedBy: string;
  now: Date;
}): ChannelSession {
  return {
    ...fields,
    status: "connecting",
    conversation: blankConversation(),
    verdict: null,
    stopReason: null,
    heartbeatAt: fields.now,
    openedAt: fields.now,
    closedAt: null,
  };
}

/** Una trama, dentro de la sesión. Devuelve el motivo de parada cuando esta trama lo alcanza. */
export function onFrame(
  session: ChannelSession,
  frame: RawFrame,
  limits: ChannelLimits,
  rules: RedactionRules,
): { session: ChannelSession; stop: StopReason | null } {
  if (isFinished(session)) return { session, stop: null };
  const { conversation, stop } = applyFrame(session.conversation, frame, limits, rules);
  return {
    session: { ...session, conversation, status: frame.direction === "open" ? "open" : session.status },
    stop,
  };
}

/**
 * Lo que pasa cuando **no** llega nada: la inactividad y la duración.
 *
 * `nowMs` va desde la apertura, como el `atMs` de los mensajes, para que las dos cuentas usen el
 * mismo origen. La inactividad se mide desde el último mensaje o, si no llegó ninguno, desde la
 * apertura: un servidor que acepta y no dice nada tiene que cortarse igual.
 */
export function onTick(session: ChannelSession, nowMs: number, limits: ChannelLimits): StopReason | null {
  if (isFinished(session)) return null;
  if (nowMs >= limits.maxDurationMs) return "time-cap";
  const messages = session.conversation.messages;
  const lastAt = messages.length ? messages[messages.length - 1].atMs : (session.conversation.openedAtMs ?? 0);
  if (nowMs - lastAt >= limits.idleMs) return "idle-cap";
  return null;
}

/**
 * Cerrar la sesión con su veredicto.
 *
 * El veredicto se calcula **aquí**, una vez y al cerrar, y se guarda con la fila. No al leer: una
 * sesión de marzo tiene que seguir diciendo lo que dijo en marzo aunque luego alguien cambie lo que
 * el canal espera.
 */
export function closeSession(
  session: ChannelSession,
  reason: StopReason,
  expect: ChannelExpectation,
  now: Date,
  openFailure: { kind: "network" | "config"; detail: string } | null = null,
): ChannelSession {
  if (isFinished(session)) return session;
  const verdict = evaluateConversation({ expect, conversation: session.conversation, openFailure });
  const failedToOpen = openFailure !== null || session.conversation.openedAtMs === null;
  return {
    ...session,
    status: failedToOpen ? "error" : "closed",
    stopReason: session.conversation.stopped ?? reason,
    verdict,
    closedAt: now,
  };
}

export const isFinished = (session: ChannelSession): boolean =>
  session.status === "closed" || session.status === "error";

/**
 * Si el proceso dueño de una sesión abierta ya no está.
 *
 * Cualquier instancia puede cerrar una sesión muerta, y hace falta que así sea: la dueña es
 * justamente la que no puede, porque se murió. Pero **solo** si el latido lleva `STALE_AFTER_BEATS`
 * tics sin llegar; una sesión viva de otra instancia no se toca.
 */
export function isStale(session: Pick<ChannelSession, "status" | "heartbeatAt">, now: Date, beatMs: number): boolean {
  if (session.status !== "open" && session.status !== "connecting") return false;
  return now.getTime() - session.heartbeatAt.getTime() > STALE_AFTER_BEATS * beatMs;
}
