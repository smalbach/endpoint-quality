/**
 * Every error leaves as RFC 9457 Problem Details.
 *
 * A product whose entire job is asserting that other APIs answer Problem Details, with a named
 * `errors[].field` and no stack trace, does not get to answer `{"statusCode":500,"message":
 * "Internal server error"}` itself. That is not tidiness — the dashboard's own contract tests
 * will eventually run against this API, and they would fail.
 *
 * The 500 branch is the one that matters: it logs the cause and returns nothing about it. A
 * stack trace in a response body is a map of the server's filesystem and dependency versions.
 */
import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus, Inject } from "@nestjs/common";
import type { Request, Response } from "express";
import { CLOCK, type ClockPort } from "@/shared/clock/clock.port";
import { withoutHookToken } from "@/shared/http/redact-url";
import { LOGGER, type LoggerPort } from "@/shared/logging/logger.port";
import { operationFields } from "@/shared/logging/operation-fields";
import { currentTrace, elapsedMs } from "@/shared/logging/trace-context";
import { DomainError, type ErrorKind } from "./domain-error";

const STATUS_BY_KIND: Record<ErrorKind, number> = {
  "not-found": HttpStatus.NOT_FOUND,
  conflict: HttpStatus.CONFLICT,
  invalid: HttpStatus.UNPROCESSABLE_ENTITY,
  unauthenticated: HttpStatus.UNAUTHORIZED,
  forbidden: HttpStatus.FORBIDDEN,
  "rate-limited": HttpStatus.TOO_MANY_REQUESTS,
};

const TITLE_BY_STATUS: Record<number, string> = {
  400: "Solicitud inválida",
  401: "No autenticado",
  403: "Sin permiso",
  404: "Recurso no encontrado",
  409: "Conflicto",
  422: "Entidad no procesable",
  413: "Cuerpo demasiado grande",
  415: "Tipo de contenido no soportado",
  429: "Demasiadas solicitudes",
  500: "Error interno",
};

type ProblemDetails = {
  type: string;
  title: string;
  status: number;
  detail: string;
  instance: string;
  errors?: { field: string; detail: string }[];
  /**
   * El identificador de la traza, **en la respuesta a propósito**.
   *
   * Es lo que cierra el bucle entre quien informa de un fallo y el registro: con este número, una
   * búsqueda devuelve la petición entera —el manejador, las llamadas salientes, la pila— en vez de
   * una búsqueda por «hacia las cuatro». No filtra nada: es un número aleatorio por petición, sin
   * relación con la sesión ni con quien llama.
   */
  traceId?: string;
};

@Catch()
export class ProblemDetailsFilter implements ExceptionFilter {
  constructor(
    @Inject(LOGGER) private readonly logger: LoggerPort,
    @Inject(CLOCK) private readonly clock: ClockPort,
  ) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const context = host.switchToHttp();
    const response = context.getResponse<Response>();
    const request = context.getRequest<Request>();
    const url = withoutHookToken(request.url);
    const problem = this.toProblem(exception, url);
    const trace = currentTrace();
    if (trace) problem.traceId = trace.traceId;

    /**
     * La línea de la operación que no terminó bien, y el único sitio donde se escribe.
     *
     * Aquí y no en el interceptor porque por aquí pasa **todo** lo que falla, incluido lo que un
     * guardia niega antes de que ningún interceptor llegue a correr: sin esto, los 401 y los 403
     * —de los que más se pregunta— serían justo los que no dejan rastro.
     *
     * Un 5xx añade la causa completa; un 4xx no la lleva porque no hay ninguna: la causa de un 422
     * es la solicitud, y ya está descrita en `detail`. Y el nivel separa las dos cosas que un 4xx y
     * un 5xx son: «el cliente pidió algo que no se puede» frente a «esto se ha roto».
     */
    const failure = problem.status >= 500;
    this.logger.log(failure ? "error" : "warn", "operación", {
      ...operationFields(request, elapsedMs(this.clock.now().getTime())).log,
      outcome: "error",
      status: problem.status,
      problem: problem.type,
      // La pila, para el operador. Nunca en el cuerpo: eso es un mapa del sistema de ficheros del
      // servidor y de las versiones de sus dependencias.
      ...(failure ? { detail: exception instanceof Error ? exception.stack : String(exception) } : {}),
    });

    response.status(problem.status).type("application/problem+json").json(problem);
  }

  private toProblem(exception: unknown, instance: string): ProblemDetails {
    if (exception instanceof DomainError) {
      const status = STATUS_BY_KIND[exception.kind];
      return {
        type: `https://endpoint-quality.dev/problems/${exception.code ?? exception.kind}`,
        title: TITLE_BY_STATUS[status],
        status,
        detail: exception.message,
        instance,
        ...(exception.fields.length ? { errors: exception.fields } : {}),
      };
    }

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const payload = exception.getResponse();
      // `class-validator` hands the pipe an array of prose messages. They are turned into named
      // fields because "no debe estar vacío" without a field name is not actionable, and naming
      // the field is exactly what the tool asserts of every API it points at.
      const messages =
        typeof payload === "object" && payload !== null && Array.isArray((payload as { message?: unknown }).message)
          ? (payload as { message: string[] }).message
          : [];
      return {
        type: `https://endpoint-quality.dev/problems/${status}`,
        title: TITLE_BY_STATUS[status] ?? exception.name,
        status,
        detail: messages.length ? "La solicitud no supera la validación" : exception.message,
        instance,
        ...(messages.length ? { errors: messages.map(namedField) } : {}),
      };
    }

    // `body-parser` rejects an oversized body with a plain Error carrying `status`, not with a
    // Nest HttpException, so without this branch "your document is too large" arrives as an
    // internal error and the caller has no way to know what to do about it.
    if (isHttpishError(exception)) {
      const status = exception.status;
      return {
        type: `https://endpoint-quality.dev/problems/${status}`,
        title: TITLE_BY_STATUS[status] ?? "Error",
        status,
        detail: status === 413 ? "El cuerpo de la solicitud supera el tamaño máximo" : exception.message,
        instance,
      };
    }

    return {
      type: "https://endpoint-quality.dev/problems/internal",
      title: TITLE_BY_STATUS[500],
      status: 500,
      detail: "La solicitud no pudo completarse",
      instance,
    };
  }
}

/** An error from Express middleware: a plain `Error` with a numeric `status`, which is how
 * `body-parser` reports a payload that is too large or a body that is not valid JSON. */
function isHttpishError(exception: unknown): exception is Error & { status: number } {
  if (!(exception instanceof Error)) return false;
  const status = (exception as { status?: unknown }).status;
  return typeof status === "number" && status >= 400 && status < 500;
}

/** `class-validator` prefixes its message with the property name; that prefix is the field. */
function namedField(message: string): { field: string; detail: string } {
  return { field: message.split(" ")[0], detail: message };
}
