import { Inject, Injectable, Optional } from "@nestjs/common";
import { Observable, Subject, filter, map } from "rxjs";

import { INSTANCE_BUS, type InstanceBusPort } from "@/shared/bus/instance-bus";
import { InMemoryInstanceBus } from "@/shared/bus/in-memory-instance-bus";
import type { CollectionRunResult, CollectionRunStatus, CollectionRunTotals } from "../domain/model";

const COLLECTION_PROGRESS_TOPIC = "collection-run.progress";

/** Lo que recibe quien mira una corrida: una petición según acaba, y un final que cierra el flujo. */
export type CollectionProgressEvent = {
  runId: string;
  type: "result" | "finished";
  status: CollectionRunStatus;
  totals: CollectionRunTotals;
  /** La petición que acaba de terminar. Ausente en el evento final. */
  result?: CollectionRunResult;
  /** Cuántas van de cuántas, para la barra. */
  progress: { done: number; total: number };
};

/**
 * La corrida en vivo, como un sujeto caliente filtrado por corrida.
 *
 * El mismo diseño que la de carga y la de seguridad: un sujeto por proceso, `forRun` lo estrecha a
 * una corrida y le da la forma que `@Sse` manda. Se publica **una petición por evento** y no la
 * corrida entera, que es lo que permite que la lista crezca fila a fila sin volver a mandar las
 * ochenta anteriores en cada paso.
 *
 * Por el bus de instancias, para que quien mira desde otra réplica vea la misma lista; sin
 * `REDIS_URL` el bus es de memoria y esto es el sujeto de siempre.
 */
@Injectable()
export class CollectionProgressStream {
  private readonly events = new Subject<CollectionProgressEvent>();
  private readonly bus: InstanceBusPort;

  constructor(@Optional() @Inject(INSTANCE_BUS) bus: InstanceBusPort | null = null) {
    this.bus = bus ?? new InMemoryInstanceBus();
    this.bus.subscribe<CollectionProgressEvent>(COLLECTION_PROGRESS_TOPIC, (event) => this.events.next(event));
  }

  publish(event: CollectionProgressEvent): void {
    this.bus.publish(COLLECTION_PROGRESS_TOPIC, event);
  }

  forRun(runId: string): Observable<{ data: unknown; type: string }> {
    return this.events.asObservable().pipe(
      filter((event) => event.runId === runId),
      map((event) => ({ type: event.type, data: event })),
    );
  }
}
