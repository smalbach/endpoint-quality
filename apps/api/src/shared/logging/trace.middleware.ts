/**
 * Lo primero que toca una petición: darle su identificador, apuntar la hora y devolver el número.
 *
 * Middleware de Express y no interceptor de Nest a propósito. Un interceptor corre **dentro** del
 * ciclo de Nest, así que lo que pasa antes —el cuerpo rechazado por tamaño, un preflight, el
 * guardia que niega el acceso— quedaría fuera de la traza, y esas son justo las peticiones de las
 * que alguien viene a preguntar.
 *
 * `next` se ejecuta **dentro** del contexto, no al lado: todo lo que la petición haga después,
 * incluidas las promesas que arranque, hereda el identificador sin pasárselo a nadie.
 */
import type { Request, RequestHandler, Response } from "express";

import type { ClockPort } from "@/shared/clock/clock.port";
import { runWithTrace, traceIdFrom, TRACE_HEADER, TRACE_HEADER_OUT } from "./trace-context";

export function traceMiddleware(clock: ClockPort): RequestHandler {
  return (request: Request, response: Response, next: () => void) => {
    const traceId = traceIdFrom(request.headers[TRACE_HEADER]);
    // Antes de seguir: la cabecera tiene que ir puesta aunque la respuesta la escriba un
    // middleware de más abajo que nunca llegue a Nest.
    response.setHeader(TRACE_HEADER_OUT, traceId);
    runWithTrace(traceId, clock.now().getTime(), next);
  };
}
