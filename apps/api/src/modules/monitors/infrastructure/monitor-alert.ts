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
 * El correo es el cuarto canal y se sale de la primera regla a propósito: **las direcciones van en
 * claro en la fila del monitor**, porque un destinatario no autoriza nada —el argumento entero está
 * en `MonitorAlert`— y porque hay que poder ver a quién se despierta. De las otras dos reglas no se
 * sale: el correo pasa por la misma redacción antes de salir, y el puerto de correo es el `MAILER`
 * de siempre, que en una instalación por omisión escribe en el log y no llama a nadie.
 *
 * Y una regla propia: **un aviso que falla no rompe el monitor.** Si el canal está caído o la
 * variable no existe, se anota en la vuelta y el monitor sigue vigilando. Lo contrario —que un
 * webhook mal escrito apague la vigilancia— es el peor de los dos fallos. La nota tampoco cita la
 * dirección: acaba en el historial, que lo ve todo el proyecto.
 */
import { Inject, Injectable, Logger } from "@nestjs/common";

import { notifyPayload, notifyUrlProblem, redactSecrets, type NotifyChannel } from "@eq/runner-core";

import { ENV, type Env } from "@/shared/config/env";
import { SAFE_FETCH, type SafeFetchPort } from "@/shared/http/safe-fetch";
import { SECRET_CIPHER, type SecretCipherPort } from "@/shared/crypto/secret-cipher";
import { MAILER, monitorAlertMail, type MailerPort } from "@/shared/mail/mailer";
import { resolveVariables } from "@/modules/environments/domain/model";
import { ENVIRONMENT_REPOSITORY, type EnvironmentRepositoryPort } from "@/modules/environments/domain/ports";
import { isWebhookChannel, type Monitor, type MonitorOutcome } from "../domain/model";
import { describeSchedule } from "../domain/schedule";

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

/**
 * Lo que se cuenta de una vuelta, ya redactado. Es lo único que sale por cualquier canal.
 *
 * Nada de valores de variables, cabeceras ni cuerpos: el proyecto, el monitor, qué le pasa y
 * cuántos casos. El detalle se mira en la corrida, donde hay sesión y permisos.
 */
export type AlertFacts = {
  monitorName: string;
  projectName: string;
  kind: AlertKind;
  outcome: MonitorOutcome;
  failures: number;
  totals: { cases: number; passed: number; failed: number } | null;
  note: string;
};

/** El texto. Corto a propósito: se lee en una notificación del teléfono, no en una pantalla. */
export function alertText(input: AlertFacts): string {
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
    @Inject(MAILER) private readonly mailer: MailerPort,
    @Inject(ENV) private readonly env: Env,
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
      // El entorno hace falta para **todos** los canales, y no solo para sacar la URL del webhook:
      // de aquí sale la lista de secretos contra la que se redacta el texto. Sin ella no se puede
      // garantizar que el aviso no lleve un token dentro, y no mandar es mejor que mandar eso.
      const environment = await this.environments.findById(monitor.plan.environmentId);
      if (!environment) return "El aviso no salió: el entorno del monitor ya no existe";

      // Descifrar puede fallar —una clave de cifrado mal puesta en el despliegue— y eso no puede
      // tumbar la vigilancia: se convierte en una nota.
      const variables = resolveVariables(environment.variables, (payload) => this.cipher.decrypt(payload));
      const secrets = Object.entries(environment.variables)
        .filter(([, variable]) => variable.sensitive)
        .map(([name]) => variables[name] ?? "")
        .filter(Boolean);

      // Se redacta **cada dato por separado** y se compone después, en vez de redactar el mensaje
      // ya armado de un canal: así los cuatro canales salen redactados del mismo sitio y el
      // siguiente que se añada no puede olvidarse de hacerlo.
      const redact = (value: string) => redactSecrets(value, secrets);
      const facts: AlertFacts = {
        monitorName: redact(monitor.name),
        projectName: redact(projectName),
        kind,
        outcome: context.outcome,
        failures: context.failures,
        totals: context.totals,
        note: redact(context.note),
      };

      if (!isWebhookChannel(alert.channel))
        return await this.mail(monitor, alert.recipients ?? [], facts, context.runId);

      const urlVariable = alert.urlVariable ?? "";
      const url = variables[urlVariable];
      const problem = notifyUrlProblem(urlVariable, url);
      if (problem) return `El aviso no salió: ${problem}`;

      const text = alertText(facts);

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

  /**
   * El aviso por correo: un envío por destinatario, y la cuenta de los que salieron.
   *
   * Uno por uno y con su propio `try`, porque el puerto manda a una dirección: una que el servidor
   * rechaza —un buzón que ya no existe, alguien que se fue— no se puede llevar por delante el aviso
   * de los otros cuatro, que es justo la noche en la que hace falta.
   *
   * La nota no dice **a quién** ni **cuál** falló, solo cuántos: se guarda en el historial de la
   * vuelta, que ve todo el proyecto, y el destinatario de un aviso no tiene por qué aparecer ahí
   * cada vez que su servidor de correo tiene un mal día. Para saber cuál falló está el log.
   */
  private async mail(monitor: Monitor, recipients: string[], facts: AlertFacts, runId: string | null): Promise<string> {
    if (!recipients.length) return "El aviso no salió: el monitor no tiene ningún destinatario";
    const mail = monitorAlertMail({
      monitorName: facts.monitorName,
      projectName: facts.projectName,
      kind: facts.kind,
      schedule: describeSchedule(monitor.schedule),
      failures: facts.failures,
      totals: facts.totals,
      note: facts.note,
      runId,
      // A la pantalla del monitor, que es donde está lo que el correo no lleva.
      link: `${this.env.APP_URL.replace(/\/+$/, "")}/p/${monitor.projectId}/monitors`,
    });

    let delivered = 0;
    for (const to of recipients) {
      try {
        await this.mailer.send({ to, ...mail });
        delivered += 1;
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        this.logger.warn(`El aviso por correo del monitor «${monitor.name}» no salió para uno: ${detail}`);
      }
    }

    if (!delivered) return "El aviso no salió: el correo no se pudo entregar";
    const what = facts.kind === "down" ? "Aviso de caída" : "Aviso de recuperación";
    if (delivered < recipients.length) return `${what} enviado por correo a ${delivered} de ${recipients.length}`;
    return `${what} enviado por correo a ${delivered} destinatario${delivered === 1 ? "" : "s"}`;
  }
}
