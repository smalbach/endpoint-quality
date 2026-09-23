/**
 * El adaptador de Prometheus: un registro **propio de esta instancia**, no el global.
 *
 * El global de la librería es un singleton de módulo, así que dos aplicaciones en el mismo proceso
 * —que es exactamente lo que hace la suite al montar la aplicación de pruebas una vez por
 * fichero— chocarían con «a metric with the name … has already been registered». Un registro por
 * instancia también es lo que permite tirar el objeto y que se vaya con él todo lo que acumuló.
 *
 * Un histograma y no un contador de tiempo medio: la media esconde justo lo que se busca. Una
 * ruta con p50 de 40 ms y p99 de 4 s tiene una media tranquilizadora y un problema real, y los
 * cubos son lo que deja preguntar por el percentil después, sin decidirlo ahora.
 */
import { collectDefaultMetrics, Histogram, Registry } from "@prometheus-io/client";

import type { HttpObservation, MetricsPort } from "./metrics.port";

/**
 * Los cubos, en milisegundos.
 *
 * Elegidos por lo que este producto hace de verdad: una lectura servida de memoria vive por debajo
 * de 25 ms, un `login` paga su KDF por diseño y ronda los cientos, y encolar una corrida cruza la
 * base de datos. El último cubo existe para que «más de diez segundos» sea visible en vez de
 * quedar confundido con el resto de la cola.
 */
const MS_BUCKETS = [5, 10, 25, 50, 100, 250, 500, 1_000, 2_500, 5_000, 10_000];

export class PromMetrics implements MetricsPort {
  private readonly registry = new Registry();
  private readonly httpDuration: Histogram<"method" | "route" | "status" | "outcome">;

  constructor() {
    this.registry.setDefaultLabels({ service: "eq-api" });
    // Memoria del proceso, retardo del bucle de eventos, descriptores, recolector de basura. Es lo
    // que contesta «¿va lenta la API o va lenta la máquina?», y no cuesta nada: se recoge en el
    // momento en que alguien raspa.
    collectDefaultMetrics({ register: this.registry, prefix: "eq_" });
    this.httpDuration = new Histogram({
      name: "eq_http_server_duration_ms",
      help: "Duración de las peticiones atendidas, en milisegundos",
      labelNames: ["method", "route", "status", "outcome"],
      buckets: MS_BUCKETS,
      registers: [this.registry],
    });
  }

  observeHttp({ method, route, status, outcome, ms }: HttpObservation): void {
    this.httpDuration.observe({ method, route, status: String(status), outcome }, ms);
  }

  async render(): Promise<{ body: string; contentType: string }> {
    return { body: await this.registry.metrics(), contentType: this.registry.contentType };
  }
}
