import { Inject, Injectable, Optional } from "@nestjs/common";
import { Subject, filter, map, type Observable } from "rxjs";
import type { ChannelMessage } from "@eq/runner-core";

import { INSTANCE_BUS, type InstanceBusPort } from "@/shared/bus/instance-bus";
import { InMemoryInstanceBus } from "@/shared/bus/in-memory-instance-bus";

const CHANNEL_PROGRESS_TOPIC = "channel-session.progress";

/**
 * Lo que sale en vivo de una sesión.
 *
 * `message` lleva el mensaje **ya redactado** —el que devolvió `applyFrame`—, y es la única forma
 * que tiene de llegar aquí: el texto crudo nunca está al alcance de quien publica. Ver la cabecera
 * de `conversation.ts` para por qué eso es estructural y no una nota.
 */
export type ChannelProgressEvent =
  | { sessionId: string; type: "open"; handshake: { status: number; headers: Record<string, string> } | null }
  | { sessionId: string; type: "message"; message: ChannelMessage }
  | { sessionId: string; type: "finished"; status: string; stopReason: string | null };

/**
 * Por el bus entre instancias.
 *
 * El socket de una sesión es un descriptor de **un** proceso y no se puede mover; lo que sí se puede
 * mover es lo que sale de él. La dueña publica cada trama ya redactada y quien sigue la sesión desde
 * otra instancia la recibe igual que si estuviera al lado: antes de esto, eso era un 409.
 */
@Injectable()
export class ChannelProgressStream {
  private readonly events = new Subject<ChannelProgressEvent>();
  private readonly bus: InstanceBusPort;

  constructor(@Optional() @Inject(INSTANCE_BUS) bus: InstanceBusPort | null = null) {
    this.bus = bus ?? new InMemoryInstanceBus();
    this.bus.subscribe<ChannelProgressEvent>(CHANNEL_PROGRESS_TOPIC, (event) => this.events.next(event));
  }

  publish(event: ChannelProgressEvent): void {
    this.bus.publish(CHANNEL_PROGRESS_TOPIC, event);
  }

  forSession(sessionId: string): Observable<{ data: unknown; type: string }> {
    return this.events.asObservable().pipe(
      filter((event) => event.sessionId === sessionId),
      map((event) => ({ type: event.type, data: event })),
    );
  }
}
