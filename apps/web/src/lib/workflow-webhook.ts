/**
 * La mitad web del nodo webhook: los límites que el editor comprueba antes que el servidor, y qué
 * esperas enseña la pantalla de la corrida.
 *
 * La URL sale de la corrida (`hooks`), que la API calcula en cada lectura mientras el nodo espera: el
 * token no está guardado en ninguna parte, así que una página abierta a media espera la ve igual, y
 * en cuanto la espera termina deja de venir.
 */
import type { RunHookWaitView } from "@eq/contracts";

/** Los límites del servidor (`webhook.timeoutMs`), en milisegundos. */
export const WEBHOOK_TIMEOUT_MS = { min: 1_000, max: 600_000, initial: 60_000 } as const;

/** Por qué no se puede guardar la espera de un nodo webhook, o null. */
export function webhookTimeoutProblem(timeoutMs: number | undefined): string | null {
  if (timeoutMs === undefined || !Number.isInteger(timeoutMs)) return "falta cuánto esperar.";
  if (timeoutMs < WEBHOOK_TIMEOUT_MS.min || timeoutMs > WEBHOOK_TIMEOUT_MS.max)
    return "la espera tiene que estar entre 1 s y 10 min.";
  return null;
}

/** Una espera como se lee: «45 s», «2 min», «1 min 30 s». */
export function formatWait(timeoutMs: number): string {
  const seconds = Math.round(timeoutMs / 1000);
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return rest ? `${minutes} min ${rest} s` : `${minutes} min`;
}

/**
 * Las esperas que siguen abiertas según lo último que se sabe de sus casos.
 *
 * La corrida pedida trae las URL, y el stream va cambiando el estado de los casos sin volver a
 * pedirla: un caso que ya terminó según el stream no enseña su URL aunque la última foto la tuviera.
 */
export function openHooks(
  hooks: RunHookWaitView[] | undefined,
  statusOf: (caseId: string) => string | undefined,
): RunHookWaitView[] {
  return (hooks ?? []).filter((hook) => {
    const status = statusOf(hook.caseId);
    return status === undefined || status === "running" || status === "queued";
  });
}
