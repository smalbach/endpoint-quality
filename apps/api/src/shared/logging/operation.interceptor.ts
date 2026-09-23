/**
 * Una línea por operación atendida, con lo que ha costado.
 *
 * Es la pieza de la que sale toda la medición: `op` y `ms` por cada petición, agrupables después
 * sin tocar la aplicación —un p95 por operación es un `jq` sobre la salida, o una consulta en lo
 * que recoja el JSON—. Por eso `op` es **el patrón de la ruta** (`GET /orgs/:organizationId/
 * dashboard`) y no la URL: con la URL, cada identificador sería una operación distinta y no
 * quedaría nada que agrupar.
 *
 * Solo el camino que termina bien. Lo que lanza —lo lance el manejador, un guardia o la
 * validación— sale por `ProblemDetailsFilter`, y es **él** quien escribe su línea: un interceptor
 * ni siquiera llega a correr cuando un guardia niega el acceso, y las dos piezas registrando lo
 * mismo darían dos líneas para una petición y ninguna para las negadas.
 *
 * Lo que no hace: no toca cuerpos ni cabeceras. Un registro que copia el cuerpo de la petición es
 * un registro que acaba guardando las credenciales que este producto redacta por todas partes. De
 * quien llama se anota su identificador, nunca su token.
 */
import { Inject, Injectable, type CallHandler, type ExecutionContext, type NestInterceptor } from "@nestjs/common";
import { tap, type Observable } from "rxjs";

import { CLOCK, type ClockPort } from "@/shared/clock/clock.port";
import { LOGGER, type LoggerPort } from "./logger.port";
import { elapsedMs } from "./trace-context";
import { operationFields, type ObservedRequest } from "./operation-fields";

/**
 * Rutas que se registran en `debug`.
 *
 * `/health` lo pide el healthcheck del contenedor cada tres segundos. A `info` serían veintiocho
 * mil líneas al día diciendo que la base contesta, y un registro que hay que filtrar para poder
 * leerlo es un registro que nadie lee.
 */
const QUIET_ROUTES = new Set(["/health"]);

@Injectable()
export class OperationLogInterceptor implements NestInterceptor {
  constructor(
    @Inject(LOGGER) private readonly logger: LoggerPort,
    @Inject(CLOCK) private readonly clock: ClockPort,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    // Un socket o un mensaje de cola pasan por aquí sin ser una petición HTTP: no tienen ni ruta
    // ni estado que contar.
    if (context.getType() !== "http") return next.handle();

    const http = context.switchToHttp();
    const request = http.getRequest<ObservedRequest>();

    return next.handle().pipe(
      tap({
        next: () => {
          const fields = operationFields(request, elapsedMs(this.clock.now().getTime()));
          const status = http.getResponse<{ statusCode?: number }>().statusCode;
          this.logger.log(QUIET_ROUTES.has(fields.route) ? "debug" : "info", "operación", {
            ...fields.log,
            outcome: "ok",
            ...(status === undefined ? {} : { status }),
          });
        },
      }),
    );
  }
}
