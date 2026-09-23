/**
 * Las métricas: lo mismo que cuentan las líneas del registro, pero agregado por el proceso.
 *
 * Son dos cosas distintas y las dos hacen falta. Una línea responde «qué pasó en **esta**
 * petición» y se lee con su traza; una métrica responde «cómo va el sistema» y se dibuja. Leer
 * un registro para hacer una gráfica es pagar el coste de guardar cada hecho para contestar una
 * pregunta que solo necesita el resumen —y no se puede hacer hacia atrás cuando el registro ya ha
 * rotado.
 *
 * Un puerto, y no `prom-client` metido en el interceptor, por lo de siempre en esta casa: el día
 * que el destino sea OTLP en vez de un `/metrics` que alguien raspa, lo que cambia es el
 * adaptador. Y porque una prueba no debería montar un registro de Prometheus para comprobar que
 * una petición se mide.
 */
export const METRICS = Symbol("METRICS");

export type HttpObservation = {
  method: string;
  /** El patrón de la ruta, **nunca la URL**: ver `UNMATCHED_ROUTE`. */
  route: string;
  status: number;
  outcome: "ok" | "error";
  ms: number;
};

/**
 * La ruta de una petición que no llegó a ningún manejador.
 *
 * En el registro, un 404 conserva la ruta que se pidió, que es lo que hace falta para
 * investigarlo. Aquí no: cada URL distinta sería una serie temporal nueva, y un rastreador
 * pidiendo mil rutas inventadas serían mil series que el proceso guarda en memoria para siempre.
 * Todas las que nadie sirve cuentan juntas.
 */
export const UNMATCHED_ROUTE = "<sin ruta>";

export interface MetricsPort {
  observeHttp(observation: HttpObservation): void;
  /** El texto que se sirve en `/metrics`, con el tipo de contenido que le corresponde. */
  render(): Promise<{ body: string; contentType: string }>;
}

/** Las métricas apagadas, para una prueba que no quiere un registro de Prometheus dentro. */
export class NullMetrics implements MetricsPort {
  observeHttp(_observation: HttpObservation): void {}

  render(): Promise<{ body: string; contentType: string }> {
    return Promise.resolve({ body: "", contentType: "text/plain" });
  }
}
