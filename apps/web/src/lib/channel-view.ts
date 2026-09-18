/**
 * Cómo se lee una conversación en la pantalla. Puro, para probarlo sin montar nada.
 *
 * Tres decisiones de lectura, y ninguna es de estilo:
 *
 * - **Huecos y no relojes.** Cada mensaje dice `+12 ms` desde el anterior. Una conversación se lee
 *   por sus pausas —«contestó al instante, y luego tres segundos de nada»— y una columna de horas
 *   con milisegundos no dice eso a nadie.
 * - **El motivo de parada en palabras.** «Se cortó: tope de 200 mensajes» se entiende; `message-cap`
 *   en la pantalla manda a leer el código.
 * - **Cada mensaje una sola vez.** La instantánea y el stream pueden solaparse en el borde, y el
 *   servidor ya descarta por `seq`; aquí se vuelve a descartar, porque una lista con un mensaje
 *   repetido es una conversación que no pasó.
 */
import type { ChannelMessageView, ChannelSessionView } from "@/lib/types";

const STOP_TEXT: Record<string, string> = {
  "closed-by-peer": "el servidor cerró la conexión",
  "closed-by-us": "cerrada desde aquí",
  "message-cap": "se cortó: tope de mensajes",
  "byte-cap": "se cortó: tope de bytes recibidos",
  "time-cap": "se cortó: tope de duración",
  "idle-cap": "se cortó: demasiado tiempo sin mensajes",
  cancelled: "se canceló (la API se reinició)",
  "handshake-failed": "no llegó a abrir",
  "transport-error": "la conexión se rompió",
};

export function stopText(reason: string | null, limits?: { maxMessages: number } | null): string {
  if (!reason) return "";
  if (reason === "message-cap" && limits) return `se cortó: tope de ${limits.maxMessages} mensajes`;
  return STOP_TEXT[reason] ?? reason;
}

/** `+12 ms`, `+3,2 s`: el hueco desde el mensaje anterior, que es lo que se lee. */
export function gap(atMs: number, previousAtMs: number | null): string {
  const delta = previousAtMs === null ? atMs : atMs - previousAtMs;
  if (delta < 1000) return `+${Math.max(0, Math.round(delta))} ms`;
  return `+${(delta / 1000).toLocaleString("es", { maximumFractionDigits: 1 })} s`;
}

/** El cuerpo, sangrado si es JSON: legible en la pantalla, sin tocar lo que se guardó. */
export function prettyBody(body: string): string {
  const trimmed = body.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return body;
  try {
    return JSON.stringify(JSON.parse(trimmed), null, 2);
  } catch {
    return body;
  }
}

/** Un mensaje más, sin repetir ninguno y en orden de `seq`. */
export function mergeMessage(messages: ChannelMessageView[], message: ChannelMessageView): ChannelMessageView[] {
  if (messages.some((existing) => existing.seq === message.seq)) return messages;
  return [...messages, message].sort((a, b) => a.seq - b.seq);
}

export const isOver = (session: Pick<ChannelSessionView, "status"> | null | undefined): boolean =>
  session?.status === "closed" || session?.status === "error";

/** Las filas que se enseñan: los mensajes, sin la apertura ni el cierre, que van en la cabecera. */
export function visibleMessages(messages: ChannelMessageView[]): ChannelMessageView[] {
  return messages.filter(
    (message) => message.direction === "in" || message.direction === "out" || message.direction === "error",
  );
}
