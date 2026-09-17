/**
 * El aviso de un monitor: un mensaje al canal donde el equipo ya mira.
 *
 * Las reglas son las del nodo `notify` de un flujo, y se reutilizan tal cual porque el problema es
 * el mismo problema:
 *
 * - **La URL es una credencial.** Quien tiene una URL de webhook entrante puede escribir en ese
 *   canal, así que el monitor guarda **el nombre de la variable** y la URL sale del entorno,
 *   descifrada si es sensible. En la fila del monitor no hay ninguna URL.
 * - **Por `SAFE_FETCH`**, como toda llamada saliente: la URL la eligió una persona, que es
 *   exactamente la petición para la que existe el guardia de SSRF.
 * - **El texto va redactado** contra los secretos de ese entorno antes de salir. Un mensaje que
 *   cita el error de una corrida puede llevar dentro un token que la corrida usó.
 *
 * Y una regla propia: **un aviso que falla no rompe el monitor.** Si el canal está caído o la
 * variable no existe, se anota en la vuelta y el monitor sigue vigilando. Lo contrario —que un
 * webhook mal escrito apague la vigilancia— es el peor de los dos fallos.
 */
import { Inject, Injectable, Logger } from "@nestjs/common";

import { notifyPayload, notifyUrlProblem, redactSecrets, type NotifyChannel } from "@eq/runner-core";

import { SAFE_FETCH, type SafeFetchPort } from "@/shared/http/safe-fetch";
import { SECRET_CIPHER, type SecretCipherPort } from "@/shared/crypto/secret-cipher";
import { resolveVariables } from "@/modules/environments/domain/model";
import { ENVIRONMENT_REPOSITORY, type EnvironmentRepositoryPort } from "@/modules/environments/domain/ports";
import type { Monitor, MonitorOutcome } from "../domain/model";

export type AlertKind = "down" | "up";

/**
 * El cuerpo de cada canal.
 *
 * `slack` y `teams` salen de `notifyPayload`, que ya sabe la forma que acepta cada uno. El webhook
 * genérico lleva el suyo: el de un flujo manda `stepId` y aquí no hay paso ninguno, así que manda
 * lo que sí identifica esto — el monitor, la corrida y si es caída o recuperación— para que quien
 * lo reciba pueda enrutar y no duplicar.
 */
export function alertBody(
  channel: NotifyChannel,
  text: string,
  origin: { monitorId: string; runId: string | null; kind: AlertKind },
): Record<string, unknown> {
  if (channel === "webhook") return { text, monitorId: origin.monitorId, runId: origin.runId, event: origin.kind };
  return notifyPayload(channel, text, { runId: origin.runId ?? "", workflowId: "", stepId: "" });
}

/** El texto. Corto a propósito: se lee en una notificación del teléfono, no en una pantalla. */
export function alertText(input: {
  monitorName: string;
  projectName: string;
  kind: AlertKind;
  outcome: MonitorOutcome;
  failures: number;
  totals: { cases: number; passed: number; failed: number } | null;
  note: string;
}): string {
  if (input.kind === "up") {
    return `✅ «${input.monitorName}» (${input.projectName}) vuelve a estar verde tras ${input.failures} fallo(s) seguidos.`;
  }
  const detail = input.totals
    ? `${input.totals.failed} de ${input.totals.cases} casos en rojo`
    : input.note || "la corrida no llegó a ejecutarse";
  const streak = input.failures > 1 ? ` (${input.failures} seguidos)` : "";
  return `🔴 «${input.monitorName}» (${input.projectName}): ${detail}${streak}.`;
}

@Injectable()
export class MonitorAlerter {
  private readonly logger = new Logger("Monitors");

  constructor(
    @Inject(ENVIRONMENT_REPOSITORY) private readonly environments: EnvironmentRepositoryPort,
    @Inject(SECRET_CIPHER) private readonly cipher: SecretCipherPort,
    @Inject(SAFE_FETCH) private readonly fetch: SafeFetchPort,
  ) {}

  /** Lo que pasó, en una frase, para anotarlo en la vuelta. Nunca lanza. */
  async send(
    monitor: Monitor,
    projectName: string,
    kind: AlertKind,
    context: {
      runId: string | null;
      outcome: MonitorOutcome;
      failures: number;
      totals: { cases: number; passed: number; failed: number } | null;
      note: string;
    },
  ): Promise<string> {
    const alert = monitor.alert;
    if (!alert) return "";
    try {
      const environment = await this.environments.findById(monitor.plan.environmentId);
      if (!environment) return "El aviso no salió: el entorno del monitor ya no existe";

      // Descifrar puede fallar —una clave de cifrado mal puesta en el despliegue— y eso no puede
      // tumbar la vigilancia: se convierte en una nota.
      const variables = resolveVariables(environment.variables, (payload) => this.cipher.decrypt(payload));
      const url = variables[alert.urlVariable];
      const problem = notifyUrlProblem(alert.urlVariable, url);
      if (problem) return `El aviso no salió: ${problem}`;

      const secrets = Object.entries(environment.variables)
        .filter(([, variable]) => variable.sensitive)
        .map(([name]) => variables[name] ?? "")
        .filter(Boolean);
      const text = redactSecrets(
        alertText({
          monitorName: monitor.name,
          projectName,
          kind,
          outcome: context.outcome,
          failures: context.failures,
          totals: context.totals,
          note: context.note,
        }),
        secrets,
      );

      const response = await this.fetch.request(url!.trim(), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(alertBody(alert.channel, text, { monitorId: monitor.id, runId: context.runId, kind })),
      });
      if (response.status < 200 || response.status >= 300) return `El canal contestó ${response.status} al aviso`;
      return kind === "down" ? "Aviso de caída enviado" : "Aviso de recuperación enviado";
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.logger.warn(`El aviso del monitor «${monitor.name}» no salió: ${detail}`);
      // Sin el texto del error dentro de la nota: la excepción de una llamada saliente cita la URL,
      // y la URL es la credencial que este fichero existe para no escribir en ninguna parte.
      return "El aviso no salió: el canal no respondió";
    }
  }
}
