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
import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus, Logger } from "@nestjs/common";
import type { Request, Response } from "express";
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
};

@Catch()
export class ProblemDetailsFilter implements ExceptionFilter {
  private readonly logger = new Logger(ProblemDetailsFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const context = host.switchToHttp();
    const response = context.getResponse<Response>();
    const request = context.getRequest<Request>();
    const problem = this.toProblem(exception, request.url);

    if (problem.status >= 500) {
      // Logged in full here and described in one line there. The operator gets the cause; the
      // caller gets nothing that describes the inside of the process.
      this.logger.error(`${request.method} ${request.url} → 500`, exception instanceof Error ? exception.stack : String(exception));
    }
    response.status(problem.status).type("application/problem+json").json(problem);
  }

  private toProblem(exception: unknown, instance: string): ProblemDetails {
    if (exception instanceof DomainError) {
      const status = STATUS_BY_KIND[exception.kind];
      return {
        type: `https://endpoint-quality.dev/problems/${exception.code ?? exception.kind}`,
        title: TITLE_BY_STATUS[status] ?? "Error",
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
      const messages = typeof payload === "object" && payload !== null && Array.isArray((payload as { message?: unknown }).message)
        ? ((payload as { message: string[] }).message)
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

    return {
      type: "https://endpoint-quality.dev/problems/internal",
      title: TITLE_BY_STATUS[500],
      status: 500,
      detail: "La solicitud no pudo completarse",
      instance,
    };
  }
}

/** `class-validator` prefixes its message with the property name; that prefix is the field. */
function namedField(message: string): { field: string; detail: string } {
  const [first] = message.split(" ");
  return { field: first ?? "body", detail: message };
}
