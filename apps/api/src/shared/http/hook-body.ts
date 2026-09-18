/**
 * The body reader of the webhook route, mounted on its prefix before the global JSON parser.
 *
 * Two reasons it cannot be the global one. That parser takes 8 MB, which is the contract upload's
 * number and is too generous for a route anyone on the internet may call; and it only reads JSON,
 * while a provider may post XML, a form or plain text. This one reads any content type as bytes up
 * to 1 MB and leaves the interpreting to the handler. A request whose body it has read is finished,
 * so every body parser after it — the JSON one, Nest's urlencoded one — skips it.
 *
 * **Past the cap the connection is cut, not drained.** A declared `Content-Length` over it is refused
 * before a byte is read, and a chunked body is refused the moment it passes. Either way the 413 goes
 * out with `Connection: close`, reading stops, and the socket is destroyed once the answer is
 * flushed. Draining the rest would let whoever sends it keep an upload of any size going against a
 * public route for as long as they like. A client that respects `Content-Length` and reads before it
 * finishes sending — which is what a caller of a size-capped endpoint should do — still gets the
 * 413; one that insists on writing the rest sees the connection close under it.
 *
 * Written against the request stream rather than `express.raw`, because the API does not depend on
 * `express` itself — only Nest's adapter does. Its failures are answered here as Problem Details,
 * because middleware errors never reach the Nest filter. `instance` is the prefix and never the
 * request URL: the URL carries the token.
 */
import type { NextFunction, Request, RequestHandler, Response } from "express";

import { FLOW_HOOK_PATH, MAX_HOOK_BODY_BYTES } from "@/modules/runs/domain/flow-hooks";

export { FLOW_HOOK_PATH };

export function flowHookBodyParser(): RequestHandler {
  return (request: Request, response: Response, next: NextFunction) => {
    const declared = Number(request.headers["content-length"]);
    if (Number.isFinite(declared) && declared > MAX_HOOK_BODY_BYTES) return cut(request, response, 413);
    const hasBody = request.headers["transfer-encoding"] !== undefined || (Number.isFinite(declared) && declared > 0);
    if (!hasBody) return next();

    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const onData = (chunk: Buffer) => {
      size += chunk.length;
      if (size <= MAX_HOOK_BODY_BYTES) return void chunks.push(chunk);
      chunks.length = 0;
      settle(() => cut(request, response, 413));
    };
    const onEnd = () =>
      settle(() => {
        (request as Request & { body?: unknown }).body = Buffer.concat(chunks);
        next();
      });
    const onError = () => settle(() => cut(request, response, 400));
    function settle(then: () => void) {
      if (settled) return;
      settled = true;
      request.off("data", onData);
      request.off("end", onEnd);
      then();
    }
    request.on("data", onData);
    request.on("end", onEnd);
    request.on("error", onError);
  };
}

/** Answers and hangs up: nothing more of this request is read. */
function cut(request: Request, response: Response, status: 400 | 413): void {
  // Stop pulling bytes off the socket; whatever else the client sends is never parsed or kept.
  request.pause();
  if (response.headersSent) return void request.socket.destroy();
  response.setHeader("Connection", "close");
  response.on("finish", () => request.socket.destroy());
  const tooLarge = status === 413;
  response
    .status(status)
    .type("application/problem+json")
    .json({
      type: `https://endpoint-quality.dev/problems/${tooLarge ? "flow-hook-body-too-large" : "flow-hook-body-unreadable"}`,
      title: tooLarge ? "Cuerpo demasiado grande" : "Solicitud inválida",
      status,
      detail: tooLarge
        ? `El cuerpo de un webhook no puede pasar de ${MAX_HOOK_BODY_BYTES} bytes`
        : "No se pudo leer el cuerpo",
      instance: FLOW_HOOK_PATH,
    });
}
