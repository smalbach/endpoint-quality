import { Injectable, Logger, type OnModuleDestroy } from "@nestjs/common";
import { randomUUID } from "node:crypto";

import type { ProgressEvent, ProgressRelayPort } from "../../domain/progress";

/**
 * Progress across instances, over Redis pub/sub.
 *
 * The problem it solves is specific: with `QUEUE_DRIVER=redis` a run is executed by whichever
 * instance picked the job up, while the browser watching it is connected to whichever instance
 * the load balancer chose. Those match by luck. When they do not, the run's events are published
 * into a subject nobody on that instance is listening to, the progress screen sits still, and the
 * only thing that saves it is the polling fallback — which is slower, heavier, and was meant to
 * cover a dropped connection rather than the normal case.
 *
 * **Pub/sub and not a stream.** Progress is worth nothing late: an event that arrives after the
 * run finished tells a follower something they can already read from the run itself. So there is
 * no delivery guarantee here on purpose, and none is needed — the durable record is the database,
 * and a follower who missed an event gets the truth from the next poll. Adding a consumer group
 * would buy replay of data that expires in seconds.
 *
 * Like the queue, `ioredis` is loaded lazily and by name so a `QUEUE_DRIVER=memory` install does
 * not need the dependency present.
 */
@Injectable()
export class RedisProgressRelay implements ProgressRelayPort, OnModuleDestroy {
  private readonly logger = new Logger("RunProgress");
  /** This process, so an event that comes back over the channel can be recognised and dropped. */
  private readonly instanceId = randomUUID();
  private publisher: any;
  private subscriber: any;

  constructor(private readonly redisUrl: string, private readonly channel = "eq:run-progress") {}

  private async redis(): Promise<any> {
    const specifier = "ioredis";
    try {
      const loaded = await import(specifier);
      return loaded.default ?? loaded;
    } catch {
      throw new Error("QUEUE_DRIVER=redis requiere la dependencia ioredis: instálala o usa QUEUE_DRIVER=memory");
    }
  }

  publish(event: ProgressEvent): void {
    // Fire and forget. A relay that made the domain wait on a network write would put Redis in
    // the path of executing a case, so a slow broker would slow the run it is only reporting on.
    void this.send(event).catch((error) => this.logger.warn(`No se pudo retransmitir el progreso: ${error instanceof Error ? error.message : String(error)}`));
  }

  private async send(event: ProgressEvent): Promise<void> {
    const Redis = await this.redis();
    this.publisher ??= new Redis(this.redisUrl);
    await this.publisher.publish(this.channel, JSON.stringify({ ...event, origin: this.instanceId }));
  }

  subscribe(handler: (event: ProgressEvent) => void): void {
    void (async () => {
      try {
        const Redis = await this.redis();
        // A dedicated connection: a client in subscriber mode cannot issue ordinary commands, so
        // sharing one with the publisher would break the publisher.
        this.subscriber = new Redis(this.redisUrl);
        await this.subscriber.subscribe(this.channel);
        this.subscriber.on("message", (_channel: string, raw: string) => {
          try {
            const event = JSON.parse(raw) as ProgressEvent;
            // Our own event, come back around. Delivering it here would show every case twice to
            // every follower on this instance.
            if (event.origin === this.instanceId) return;
            handler(event);
          } catch {
            this.logger.warn("Llegó un evento de progreso que no se pudo leer");
          }
        });
        this.logger.log("Progreso en vivo retransmitido entre instancias por Redis");
      } catch (error) {
        // The run still executes and the screen still polls. A broken relay degrades the live
        // view; it must not take the API down.
        this.logger.warn(`Sin retransmisión de progreso entre instancias: ${error instanceof Error ? error.message : String(error)}`);
      }
    })();
  }

  async onModuleDestroy(): Promise<void> {
    await this.subscriber?.quit?.().catch(() => undefined);
    await this.publisher?.quit?.().catch(() => undefined);
  }
}
