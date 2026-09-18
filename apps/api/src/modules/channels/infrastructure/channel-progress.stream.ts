import { Injectable } from "@nestjs/common";
import { Subject, filter, map, type Observable } from "rxjs";
import type { ChannelMessage } from "@eq/runner-core";

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
 * Por proceso, y sin relé a propósito.
 *
 * Una corrida sobrevive a caer en otra instancia porque su estado está en Postgres; el socket de una
 * sesión es un descriptor de **este** proceso y no se puede relevar. Quien sigue una sesión desde
 * otra instancia recibe un 409 que nombra la dueña, en vez de una vista en vivo que no vuelve a
 * emitir nunca.
 */
@Injectable()
export class ChannelProgressStream {
  private readonly events = new Subject<ChannelProgressEvent>();

  publish(event: ChannelProgressEvent): void {
    this.events.next(event);
  }

  forSession(sessionId: string): Observable<{ data: unknown; type: string }> {
    return this.events.asObservable().pipe(
      filter((event) => event.sessionId === sessionId),
      map((event) => ({ type: event.type, data: event })),
    );
  }
}
