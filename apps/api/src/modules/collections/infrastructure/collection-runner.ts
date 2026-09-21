/**
 * El Runner: la colección corrida de arriba abajo, como la corre Postman.
 *
 * **Una petición detrás de otra, en el orden del árbol.** Ese orden es la mitad de lo que una
 * colección dice —el `Setup · crear producto A` tiene que correr antes que el filtro que lo
 * busca—, y es justo lo que se perdía cuando una colección entraba como un grafo de flujo.
 *
 * **Las variables sobreviven a la petición.** `pm.collectionVariables.set("chk_product_a", id)` en
 * el `Setup` y `pm.collectionVariables.get(...)` doce peticiones después es el patrón de cualquier
 * colección de verdad; el almacén vive aquí, en la corrida, y entra y sale por cada envío. Sin eso
 * cada petición empezaría en blanco y la mitad de la colección no tendría con qué correr.
 *
 * **Enviar es el mismo botón de enviar.** Cada petición sale por `SendEndpointRequestCommand`: la
 * misma guardia SSRF, el mismo `writesAllowed` del entorno, la misma cadena de credenciales, el
 * mismo tarro de cookies y los mismos scripts en un proceso aislado. Un motor propio aquí sería un
 * segundo motor, y el primer día en que los dos discreparan nadie sabría cuál miente.
 *
 * **Los scripts de arriba corren también.** Postman ejecuta el `prerequest` de la colección, luego
 * el de cada carpeta que contiene la petición, y luego el de la petición; los `test`, igual. Se
 * componen en un solo script por fase, cada trozo en su propia función para que un `return` suelto
 * —o un `const` con el mismo nombre en dos de ellos— no rompa al de al lado.
 */
import { Injectable } from "@nestjs/common";
import { CommandBus } from "@nestjs/cqrs";
import { Inject } from "@nestjs/common";

import { CLOCK, type ClockPort } from "@/shared/clock/clock.port";
import {
  SendEndpointRequestCommand,
  type SentRequestView,
} from "@/modules/endpoints/application/commands/send-endpoint-request";
import type { SendInput } from "@/modules/endpoints/domain/send-request";
import {
  COLLECTION_REPOSITORY,
  COLLECTION_RUN_QUEUE,
  COLLECTION_RUN_REPOSITORY,
  type CollectionRepositoryPort,
  type CollectionRunQueuePort,
  type CollectionRunRepositoryPort,
} from "../domain/ports";
import {
  EMPTY_TOTALS,
  RUN_DETAIL_BUDGET,
  clipBody,
  detailSize,
  findItem,
  requestsOf,
  resolveItemAuth,
  trailName,
  withoutBodies,
  type CollectionDocument,
  type CollectionItem,
  type CollectionRun,
  type CollectionRunResult,
  type CollectionRunTotals,
  type FlatItem,
} from "../domain/model";
import { CollectionProgressStream } from "./collection-progress.stream";

/** Un trozo de script con la etiqueta de dónde salió, para que un error diga cuál falló. */
type ScriptPart = { label: string; code: string };

/**
 * Los trozos, compuestos en un script.
 *
 * Cada uno dentro de su propia función: en Postman son ejecuciones distintas que comparten el
 * estado de `pm`, así que un `const token = …` en el de la colección y otro en el de la petición
 * conviven, y un `return` temprano corta el suyo y no los demás. Concatenarlos a pelo rompía las
 * dos cosas.
 */
export function composeScript(parts: ScriptPart[]): string {
  const real = parts.filter((part) => part.code.trim());
  if (!real.length) return "";
  return real.map((part) => `// ${part.label}\n(function () {\n${part.code}\n})();`).join("\n");
}

@Injectable()
export class CollectionRunner {
  constructor(
    private readonly commandBus: CommandBus,
    @Inject(COLLECTION_REPOSITORY) private readonly collections: CollectionRepositoryPort,
    @Inject(COLLECTION_RUN_REPOSITORY) private readonly runs: CollectionRunRepositoryPort,
    @Inject(COLLECTION_RUN_QUEUE) private readonly queue: CollectionRunQueuePort,
    @Inject(CLOCK) private readonly clock: ClockPort,
    private readonly progress: CollectionProgressStream,
  ) {}

  listen(): void {
    this.queue.process((runId) => this.execute(runId));
  }

  async execute(runId: string): Promise<void> {
    const run = await this.runs.findById(runId);
    if (!run || run.status !== "running") return;
    const collection = await this.collections.find(run.projectId, run.collectionId);
    if (!collection) {
      await this.finish(run, "error", "La colección se borró antes de que la corrida empezara");
      return;
    }

    const root: CollectionItem[] = run.folderId
      ? (findItem(collection.document.items, run.folderId)?.item.items ?? [])
      : collection.document.items;
    const plan = requestsOf(root);
    if (!plan.length) {
      await this.finish(run, "error", "No hay ninguna petición que correr");
      return;
    }

    // Las variables de la colección son el estado de la corrida: entran con su valor guardado y
    // salen con lo que los scripts hayan escrito, vuelta tras vuelta.
    const variables: Record<string, string> = {};
    for (const variable of collection.document.variables) if (variable.enabled) variables[variable.key] = variable.value;

    let totals: CollectionRunTotals = { ...EMPTY_TOTALS };
    const results: CollectionRunResult[] = [];
    const total = plan.length * run.iterations;
    let stopped = false;
    // Lo que llevan ocupado los cuerpos guardados. La fila se reescribe entera en cada petición,
    // así que lo que crece sin freno se paga en cada una de las que quedan.
    let detail = 0;

    for (let iteration = 1; iteration <= run.iterations && !stopped; iteration += 1) {
      for (const entry of plan) {
        if (this.queue.isCancelled(run.id)) {
          await this.finish({ ...run, totals, results }, "cancelled", null);
          return;
        }
        const sent = await this.send(run, collection.document, entry, iteration, variables);
        const result = detail + detailSize(sent) > RUN_DETAIL_BUDGET ? withoutBodies(sent) : sent;
        detail += detailSize(result);
        results.push(result);
        totals = add(totals, result);
        await this.runs.save({ ...run, totals, results });
        this.progress.publish({
          runId: run.id,
          type: "result",
          status: "running",
          totals,
          result,
          progress: { done: results.length, total },
        });
        if (run.stopOnFailure && failed(result)) {
          stopped = true;
          break;
        }
        if (run.delayMs) await wait(run.delayMs);
      }
    }

    await this.finish({ ...run, totals, results }, totals.failed ? "failed" : "passed", null);
  }

  /**
   * Una petición de la corrida.
   *
   * Todo lo que puede salir mal aquí es **un resultado rojo y no una excepción**: una variable sin
   * valor, un entorno que no permite escrituras, un destino que no contesta. Una colección de
   * ochenta peticiones donde la tercera no resuelve una variable tiene que correr las setenta y
   * siete restantes y decir qué pasó con la tercera; tirar la corrida entera sería perder el
   * informe por el que alguien la lanzó.
   */
  private async send(
    run: CollectionRun,
    document: CollectionDocument,
    entry: FlatItem,
    iteration: number,
    variables: Record<string, string>,
  ): Promise<CollectionRunResult> {
    const { item, trail } = entry;
    // Un nodo de esta lista siempre es una petición: `requestsOf` filtra por `kind`.
    const request = item.request!;
    const base = {
      iteration,
      itemId: item.id,
      name: item.name,
      folder: trailName(trail),
      method: request.method,
      url: request.url,
    };
    /** Lo que las variables valían antes: lo que esta petición escriba es la diferencia. */
    const before = { ...variables };

    const input: SendInput & { environmentId: string | null } = {
      environmentId: run.environmentId,
      method: request.method,
      path: request.url,
      pathParameters: request.pathParameters.map((parameter) => ({ name: parameter.name, value: parameter.value })),
      query: request.query.map((row) => ({ name: row.name, value: row.value, enabled: row.enabled })),
      headers: request.headers,
      body: request.body,
      auth: resolveItemAuth(request.auth, trail, document.auth),
      // Postman corre el script de la colección antes que el de cada carpeta, y el de la carpeta
      // antes que el de la petición. Los `test`, en el mismo orden.
      preRequestScript: composeScript([
        { label: "Colección", code: document.preRequestScript },
        ...trail.map((folder) => ({ label: `Carpeta ${folder.name}`, code: folder.preRequestScript })),
        { label: item.name, code: item.preRequestScript },
      ]),
      postResponseScript: composeScript([
        { label: "Colección", code: document.postResponseScript },
        ...trail.map((folder) => ({ label: `Carpeta ${folder.name}`, code: folder.postResponseScript })),
        { label: item.name, code: item.postResponseScript },
      ]),
      variables,
    };

    let sent: SentRequestView;
    try {
      sent = await this.commandBus.execute<SendEndpointRequestCommand, SentRequestView>(
        new SendEndpointRequestCommand(run.organizationId, run.projectId, JSON.stringify(input), [], run.startedBy),
      );
    } catch (error) {
      // El comando rechaza antes de salir: una variable sin valor, un entorno de solo lectura, un
      // parámetro de ruta vacío. No hubo petición, así que no hay nada que enseñar de ella.
      return {
        ...base,
        status: null,
        durationMs: 0,
        sizeBytes: 0,
        tests: [],
        error: error instanceof Error ? error.message : "La petición no se pudo enviar",
        logs: [],
        sent: null,
        received: null,
        auth: "No se envió",
        cookies: { sent: [], stored: [], rejected: [] },
        writes: [],
        scripts: { pre: null, post: null },
      };
    }

    // Lo que los scripts escribieron viaja a la petición siguiente. Es el estado de la corrida.
    Object.assign(variables, sent.variables);

    const tests = [...(sent.scripts.pre?.tests ?? []), ...(sent.scripts.post?.tests ?? [])];
    const logs = [...(sent.scripts.pre?.logs ?? []), ...(sent.scripts.post?.logs ?? [])];
    const requestBody = sent.request.body === null ? null : clipBody(sent.request.body);
    const responseBody = sent.response ? clipBody(sent.response.body) : null;
    return {
      ...base,
      url: sent.request.url || request.url,
      status: sent.response?.status ?? null,
      durationMs: sent.response?.durationMs ?? 0,
      sizeBytes: sent.response?.sizeBytes ?? 0,
      tests,
      error: sent.error ?? sent.scripts.post?.error ?? sent.scripts.pre?.error ?? null,
      logs,
      sent: {
        method: sent.request.method,
        url: sent.request.url,
        headers: sent.request.headers,
        body: requestBody?.text ?? null,
        bodyTruncated: requestBody?.truncated ?? false,
      },
      received:
        sent.response && responseBody
          ? {
              status: sent.response.status,
              headers: sent.response.headers,
              body: responseBody.text,
              bodyTruncated: responseBody.truncated,
              sizeBytes: sent.response.sizeBytes,
              durationMs: sent.response.durationMs,
              timing: sent.response.timing,
            }
          : null,
      auth: sent.auth,
      cookies: sent.cookies,
      // Solo lo que esta petición cambió: el almacén entero son las variables de la colección más
      // todo lo que llevan escrito las anteriores, y repetirlo en cada fila no dice quién lo puso.
      writes: Object.entries(sent.variables)
        .filter(([key, value]) => before[key] !== value)
        .map(([key, value]) => ({ key, value })),
      scripts: {
        pre: sent.scripts.pre ? { error: sent.scripts.pre.error, durationMs: sent.scripts.pre.durationMs } : null,
        post: sent.scripts.post ? { error: sent.scripts.post.error, durationMs: sent.scripts.post.durationMs } : null,
      },
    };
  }

  private async finish(run: CollectionRun, status: CollectionRun["status"], error: string | null): Promise<void> {
    const finished: CollectionRun = { ...run, status, error, finishedAt: this.clock.now() };
    await this.runs.save(finished);
    this.progress.publish({
      runId: run.id,
      type: "finished",
      status,
      totals: finished.totals,
      progress: { done: finished.results.length, total: finished.results.length },
    });
  }
}

/** Una petición cuenta como roja si no hubo respuesta, si un script falló o si un test salió rojo. */
export const failed = (result: CollectionRunResult): boolean =>
  result.status === null || Boolean(result.error) || result.tests.some((test) => !test.passed);

const add = (totals: CollectionRunTotals, result: CollectionRunResult): CollectionRunTotals => ({
  requests: totals.requests + 1,
  failed: totals.failed + (failed(result) ? 1 : 0),
  tests: totals.tests + result.tests.length,
  testsPassed: totals.testsPassed + result.tests.filter((test) => test.passed).length,
  testsFailed: totals.testsFailed + result.tests.filter((test) => !test.passed).length,
});

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
