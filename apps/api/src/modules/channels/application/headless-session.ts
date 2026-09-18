/**
 * Una sesión sin pantalla: lo que hace un nodo canal de un flujo, o un monitor que lo contiene.
 *
 * Abrir, mandar un guion, esperar y cerrar, **sin nadie delante**. Es el mismo registro y la misma
 * apertura que la sesión interactiva —`ChannelSessionOpener` y `ChannelSessionRegistry`—, y no una
 * copia: la guarda de red, los topes, la redacción dentro de `applyFrame`, los secretos, el entorno
 * sin escrituras y los métodos gRPC sin efectos se aplican porque esto pasa por ellos, no porque se
 * haya acordado de repetirlos. La sesión queda además en el historial del canal, con su
 * transcripción tapada, como cualquier otra.
 *
 * Lo que sí es propio de no tener a nadie:
 *
 * - **El guion.** Sin él, los mensajes guardados del canal en su orden (WebSocket y MQTT); un canal
 *   gRPC ya manda su petición con la llamada.
 * - **Cuándo se acaba.** Cuando llegan los mensajes que se esperan (`untilMessages`, o el
 *   `minMessages` del canal), cuando el otro lado cierra o cuando salta un tope del canal. Nunca más
 *   tarde que la duración del canal y un margen: el reloj del registro corta, y esto espera como
 *   mucho eso por si el reloj no llegara.
 * - **Lo que se rechaza antes de abrir** —un canal borrado, una variable sin valor, un método gRPC
 *   con efectos en un entorno sin escrituras— vuelve como `refused`, con el mismo texto que vería
 *   quien pulsa «Conectar». Una corrida lo cuenta como un rojo de configuración: nadie llegó a llamar.
 */
import { Inject, Injectable } from "@nestjs/common";
import type { ChannelScriptStep, ReceivedMessage, StepChannel } from "@eq/runner-core";

import { DomainError } from "@/shared/errors/domain-error";
import { MAX_SAVED_MESSAGE_BYTES, type Channel } from "../domain/model";
import type { MqttPublish } from "../domain/mqtt";
import {
  CHANNEL_REPOSITORY,
  CHANNEL_SESSION_REPOSITORY,
  type ChannelRepositoryPort,
  type ChannelSessionRepositoryPort,
} from "../domain/ports";
import type { ChannelSession } from "../domain/session";
import { ChannelSessionRegistry } from "../infrastructure/session-registry";
import { ChannelSessionOpener } from "./commands/manage-sessions";

/** Cada cuánto se mira la sesión mientras se espera. Lo bastante corto para no alargar un caso. */
const POLL_MS = 15;
/** Lo que se espera por encima de la duración del canal antes de cerrar desde aquí. */
const GRACE_MS = 2_000;

export type HeadlessInput = {
  projectId: string;
  channelId: string;
  environmentId: string | null;
  /** Quién consta como quien abrió la sesión: el que lanzó la corrida, o el monitor. */
  actorId: string;
  node: StepChannel;
  /** Las variables de la corrida, encima del entorno. */
  variables: Record<string, string>;
  /** Lo que además hay que tapar: los secretos de la corrida y la sesión de un login. */
  secrets: string[];
};

export type HeadlessOutcome =
  | { kind: "refused"; detail: string; channel: Channel | null }
  | {
      kind: "session";
      channel: Channel;
      /** Cerrada, con su veredicto y su transcripción tapada. */
      session: ChannelSession;
      /** Lo recibido **sin tapar**, solo en memoria: para las capturas y los pasos que lo lean. */
      received: ReceivedMessage[];
      /** Lo que el guion no pudo hacer: un envío rechazado, una variable sin valor. */
      problems: string[];
    };

@Injectable()
export class HeadlessChannelRunner {
  constructor(
    @Inject(CHANNEL_REPOSITORY) private readonly channels: ChannelRepositoryPort,
    @Inject(CHANNEL_SESSION_REPOSITORY) private readonly sessions: ChannelSessionRepositoryPort,
    private readonly opener: ChannelSessionOpener,
    private readonly registry: ChannelSessionRegistry,
  ) {}

  async run(input: HeadlessInput): Promise<HeadlessOutcome> {
    const channel = await this.channels.findById(input.projectId, input.channelId);
    if (!channel) return { kind: "refused", detail: "El canal ya no existe en este proyecto", channel: null };

    const script = input.node.messages ?? defaultScript(channel);
    const scriptProblem = problemOf(script, channel);
    if (scriptProblem) return { kind: "refused", detail: scriptProblem, channel };

    const received: ReceivedMessage[] = [];
    let session: ChannelSession;
    try {
      session = await this.opener.open({
        projectId: input.projectId,
        channel,
        environmentId: input.environmentId,
        actorId: input.actorId,
        overlay: { variables: input.variables, secrets: input.secrets },
        ...(input.node.request !== undefined ? { grpcRequest: input.node.request } : {}),
        ...(input.node.idleMs ? { idleMs: input.node.idleMs } : {}),
        onReceived: (frame) =>
          received.push({ body: frame.body ?? "", ...(frame.topic !== undefined ? { topic: frame.topic } : {}) }),
      });
    } catch (error) {
      if (error instanceof DomainError) return { kind: "refused", detail: describe(error), channel };
      throw error;
    }

    const problems: string[] = [];
    const deadline = Date.now() + channel.limits.maxDurationMs + GRACE_MS;
    if (this.registry.current(session.id)) {
      await this.play(session.id, channel, script, problems, deadline);
      await this.settle(session.id, input.node.untilMessages ?? channel.expectations.minMessages, deadline);
    }
    return { kind: "session", channel, session: await this.closed(session), received, problems };
  }

  /** El guion, acción a acción, mientras la sesión siga abierta. El primer rechazo lo para. */
  private async play(
    sessionId: string,
    channel: Channel,
    script: ChannelScriptStep[],
    problems: string[],
    deadline: number,
  ): Promise<void> {
    for (const [index, step] of script.entries()) {
      if (!this.registry.current(sessionId)) return;
      try {
        if (step.action === "send") {
          if (step.delayMs) await sleep(Math.min(step.delayMs, Math.max(0, deadline - Date.now())));
          if (!this.registry.current(sessionId)) return;
          await this.registry.send(sessionId, step.body, publishOf(step, channel));
        } else if (step.action === "wait") {
          const until = Math.min(Date.now() + step.timeoutMs, deadline);
          const target = this.received(sessionId) + step.messages;
          while (Date.now() < until && this.registry.current(sessionId) && this.received(sessionId) < target)
            await sleep(POLL_MS);
        } else {
          this.registry.end(sessionId);
        }
      } catch (error) {
        // El mismo rechazo que en la pantalla —el entorno sin escrituras, una variable sin valor, un
        // mensaje que no encaja con el tipo gRPC—, con el número de la acción para encontrarla.
        problems.push(`Acción ${index + 1} (${step.action}): ${error instanceof Error ? describe(error) : error}`);
        return;
      }
    }
    // Un stream de cliente gRPC contesta cuando se termina de mandar. Sin nadie que pulse
    // «Terminar envío», se termina aquí; un método que no recibe stream lo dice y no pasa nada.
    if (channel.protocol === "grpc" && !script.some((step) => step.action === "end")) {
      try {
        if (this.registry.current(sessionId)) this.registry.end(sessionId);
      } catch {
        // No es un stream de cliente: su petición ya viajó con la llamada.
      }
    }
  }

  /**
   * Esperar al final: los mensajes que se esperan, el cierre del otro lado o un tope del canal.
   * Sin número esperado, deciden el cierre y los topes —la inactividad, casi siempre—.
   */
  private async settle(sessionId: string, until: number | undefined, deadline: number): Promise<void> {
    while (this.registry.current(sessionId)) {
      if (until !== undefined && this.received(sessionId) >= until) return;
      if (Date.now() >= deadline) return;
      await sleep(POLL_MS);
    }
  }

  private received(sessionId: string): number {
    return this.registry.current(sessionId)?.conversation.counters.received ?? 0;
  }

  /**
   * La sesión cerrada, con sus mensajes. Si sigue viva la cierra esta función; si la cerró el otro
   * lado o un tope, `close` espera a que ese cierre termine de guardar. Y si ya había terminado del
   * todo, se lee de la base de datos, que es donde quedó.
   */
  private async closed(session: ChannelSession): Promise<ChannelSession> {
    try {
      return await this.registry.close(session.id);
    } catch (error) {
      if (!(error instanceof DomainError)) throw error;
      const stored = (await this.sessions.findById(session.projectId, session.id)) ?? session;
      const messages = await this.sessions.listMessages(session.id);
      return { ...stored, conversation: { ...stored.conversation, messages } };
    }
  }
}

/**
 * Lo que manda un nodo sin guion: los mensajes guardados del canal, en orden. En gRPC, nada más que
 * la petición de la llamada: los mensajes guardados de un canal gRPC son para un stream, y mandarlos
 * a un método unario sería un rechazo por algo que nadie pidió.
 */
export function defaultScript(channel: Channel): ChannelScriptStep[] {
  if (channel.protocol === "grpc") return [];
  return channel.messages.map((message) => ({
    action: "send" as const,
    body: message.body,
    ...(message.topic !== undefined ? { topic: message.topic } : {}),
    ...(message.qos !== undefined ? { qos: message.qos } : {}),
    ...(message.retain !== undefined ? { retain: message.retain } : {}),
  }));
}

/** Lo que el guion tiene mal para **este** canal, antes de abrir nada. */
function problemOf(script: ChannelScriptStep[], channel: Channel): string | null {
  for (const [index, step] of script.entries()) {
    if (step.action !== "send") continue;
    if (Buffer.byteLength(step.body, "utf8") > MAX_SAVED_MESSAGE_BYTES)
      return `Acción ${index + 1}: un mensaje tiene como mucho ${MAX_SAVED_MESSAGE_BYTES / 1024} KB`;
    if (channel.protocol === "mqtt" && !step.topic) return `Acción ${index + 1}: en MQTT se publica en un tema`;
    if (channel.protocol !== "mqtt" && step.topic) return `Acción ${index + 1}: solo MQTT publica en un tema`;
  }
  return null;
}

function publishOf(step: Extract<ChannelScriptStep, { action: "send" }>, channel: Channel): MqttPublish | undefined {
  if (channel.protocol !== "mqtt" || !step.topic) return undefined;
  return { topic: step.topic, qos: step.qos ?? 0, retain: step.retain ?? false };
}

/** El texto de un rechazo, con el detalle de sus campos cuando lo trae y el mensaje no lo dice ya. */
function describe(error: Error): string {
  const fields = error instanceof DomainError ? error.fields.map((field) => field.detail) : [];
  const extra = fields.filter((detail) => !error.message.includes(detail));
  return extra.length ? `${error.message}: ${extra.join("; ")}` : error.message;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
