/**
 * La ruta pública del mock: `/mock/<publicId>/lo-que-sea`.
 *
 * Es el único controlador `@Public()` de este producto que contesta con datos de un proyecto, y por
 * eso lo que hace está deliberadamente reducido a lo mínimo: **lee dos tablas, escribe la respuesta,
 * y anota una fila diciendo qué contestó.** No manda nada a ninguna parte y no sabe quién llama.
 *
 * ## La bitácora va después de la respuesta, y no puede tumbarla
 *
 * La fila se escribe **cuando la respuesta ya salió**, y dentro de un `try` que se lo traga todo.
 * Esta ruta recibe tráfico de verdad, y un mock que se cayera porque su bitácora se cayó es peor que
 * un mock sin bitácora. De la petición no se anota nada de lo que trae dentro —ni cabeceras, ni
 * cuerpo, ni la cadena de consulta—: el por qué está en `mock-call.ts`, y lo que lo sostiene es que
 * el comando no recibe la petición, así que no puede escribirla aunque se le olvide a alguien.
 *
 * ## Las cabeceras de la respuesta vienen de una respuesta ajena
 *
 * Eso es una inyección de cabeceras esperando a pasar: el valor lo grabó otro servidor, o lo trajo
 * un HAR, y termina en una respuesta que lee un navegador. Un salto de línea dentro partiría la
 * respuesta en dos. Así que el nombre tiene que ser un `token` de HTTP y del valor se van los
 * caracteres de control antes de escribirlo — y aun así cada escritura va protegida, porque lo que
 * decide qué es una cabecera válida es Node y no esta lista.
 *
 * ## Por qué `@Res()` y no un `return`
 *
 * Un mock tiene que poder contestar 204 sin cuerpo, 304, un `text/xml`, y las cabeceras exactas del
 * ejemplo. Eso no sale de un objeto serializado por el pipeline: es escribir la respuesta.
 */
import { All, Controller, HttpCode, Options, Param, Req, Res } from "@nestjs/common";
import { CommandBus, QueryBus } from "@nestjs/cqrs";
import type { Request, Response } from "express";

import { Public } from "@/modules/auth/infrastructure/guards/auth.guard";
import { RecordMockCallCommand } from "../application/commands/record-mock-call";
import { AnswerMockQuery, type MockAnswer } from "../application/queries/answer-mock";
import { MOCK_PATH_PREFIX } from "../domain/model";
import type { MockRequest } from "../domain/serve-mock";
import { applyMockCors } from "./mock-cors";

// eslint-disable-next-line no-control-regex -- los caracteres de control son justo lo que se quita
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/g;

/**
 * Lo que se puede escribir en el valor de una cabecera: ASCII imprimible y nada más.
 *
 * El valor de una cabecera HTTP no lleva UTF-8. Node escribe los bytes y el cliente los lee como
 * latin-1, así que un nombre de ejemplo con tilde llega partido. Lo de fuera se codifica en
 * porcentaje —igual que en una URL— y lo que ya es ASCII se queda legible, que es para lo que sirve
 * una cabecera de diagnóstico.
 */
function headerSafe(text: string): string {
  // Con `u`, un carácter fuera del plano básico es uno solo y no dos mitades sueltas.
  return text.replace(/[^\x20-\x7e]/gu, (character) =>
    [...new TextEncoder().encode(character)]
      .map((byte) => `%${byte.toString(16).toUpperCase().padStart(2, "0")}`)
      .join(""),
  );
}

/** Un cuerpo en estas respuestas es ilegal, y algunos clientes lo leen como la respuesta siguiente. */
const NEVER_HAS_BODY = new Set([204, 205, 304]);

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Una cabecera de entrada puede llegar repetida; se comparan en minúsculas y se unen con coma. */
function incomingHeaders(request: Request): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(request.headers)) {
    if (value === undefined) continue;
    headers[name.toLowerCase()] = Array.isArray(value) ? value.join(", ") : value;
  }
  return headers;
}

/** Un `%2F` en la URL es parte del segmento y no un separador, así que se decodifica por segmento. */
function decodePath(path: string): string {
  return path
    .split("/")
    .map((segment) => {
      try {
        return decodeURIComponent(segment);
      } catch {
        // Un `%` suelto no es un error del que quejarse: es un segmento que no encajará con nada.
        return segment;
      }
    })
    .join("/");
}

@Controller(`${MOCK_PATH_PREFIX}/:publicId`)
export class MockServeController {
  constructor(
    private readonly queryBus: QueryBus,
    private readonly commandBus: CommandBus,
  ) {}

  /**
   * El preflight del navegador, para cuando este proceso corre sin el middleware de delante.
   *
   * No se puede contestar con `@All` a secas porque un proyecto puede tener declarado un `OPTIONS`
   * propio, y entonces el preflight y la petición de verdad son la misma ruta con dos significados.
   * Lo que los separa es `Access-Control-Request-Method`, y eso se mira aquí dentro.
   */
  @Options(["", "*rest"])
  @Public()
  @HttpCode(204)
  preflight(@Req() request: Request, @Res() response: Response): Promise<void> | void {
    applyMockCors(response);
    if (request.headers["access-control-request-method"]) {
      response.status(204).end();
      return;
    }
    return this.serve(String(request.params.publicId ?? ""), request, response);
  }

  @All(["", "*rest"])
  @Public()
  async serve(@Param("publicId") publicId: string, @Req() request: Request, @Res() response: Response): Promise<void> {
    const startedAt = Date.now();
    // La ruta se saca de la URL cruda y no del parámetro comodín: Express 5 lo entrega troceado y ya
    // decodificado, y volver a juntarlo perdería un `%2F` que sí importa.
    const url = request.originalUrl || request.url;
    const mark = url.indexOf("?");
    const pathname = mark < 0 ? url : url.slice(0, mark);
    const prefix = `/${MOCK_PATH_PREFIX}/${publicId}`;
    const rest = pathname.startsWith(prefix) ? pathname.slice(prefix.length) : "/";

    const mockRequest: MockRequest = {
      method: request.method,
      path: decodePath(rest || "/"),
      query: mark < 0 ? [] : [...new URLSearchParams(url.slice(mark + 1))],
      headers: incomingHeaders(request),
      // Solo el JSON que el parser de la aplicación ya leyó. Un cuerpo de otro tipo no se mira, y
      // eso solo significa que no puede desempatar dos ejemplos.
      body: request.body,
    };

    const answer: MockAnswer = await this.queryBus.execute(new AnswerMockQuery(publicId, mockRequest));
    if (answer.delayMs > 0) await sleep(answer.delayMs);

    applyMockCors(response);

    if (answer.outcome.kind === "problem") {
      const { status, code, title, detail, allow } = answer.outcome;
      if (allow) response.setHeader("allow", allow.join(", "));
      response
        .status(status)
        .type("application/problem+json")
        .json({
          type: `https://endpoint-quality.dev/problems/${code}`,
          title,
          status,
          detail,
          instance: request.originalUrl || request.url,
        });
      await this.record(answer, mockRequest, startedAt);
      return;
    }

    const { status, headers, body, trace } = answer.outcome;
    for (const header of headers) {
      try {
        // `responseHeaders` ya descartó los nombres que no son un `token` y quitó los caracteres de
        // control. El `try` es la última red: lo que decide qué es una cabecera legal es Node, y una
        // respuesta que alguien grabó hace un mes no vale un 500.
        response.setHeader(header.name.trim(), header.value);
      } catch {
        /* se salta esa cabecera y la respuesta sigue */
      }
    }
    // Qué eligió el mock y por qué. Sin esto, «me contesta 200 y esperaba el 404» no se puede
    // depurar más que a ciegas, y es la queja número uno de cualquier mock.
    response.setHeader("x-eq-mock-endpoint", headerSafe(trace.endpointRoute));
    response.setHeader("x-eq-mock-example", headerSafe(trace.exampleName.replace(CONTROL_CHARS, "")));
    // El motivo ya es un código ASCII: se decide en el dominio, no se traduce aquí.
    response.setHeader("x-eq-mock-reason", trace.reason);

    response.status(status);
    if (NEVER_HAS_BODY.has(status) || !body) response.end();
    else response.send(body);

    await this.record(answer, mockRequest, startedAt);
  }

  /**
   * La fila de la bitácora, con la respuesta ya escrita.
   *
   * Se traga cualquier fallo a propósito: la petición ya se contestó, así que un error aquí no puede
   * arreglar nada y sí puede estropear lo que ya salió bien — el filtro de errores intentaría
   * escribir un 500 sobre una respuesta ya enviada, y lo que quedaría en el registro sería eso en
   * vez de la base de datos que se fue.
   *
   * Del tiempo se descuenta el retardo simulado. Es lo único que se puede descontar con sentido: el
   * retardo es un número de la configuración que ya se ve en la misma pantalla, y dejarlo dentro
   * taparía la única parte que varía —encontrar la ruta y elegir el ejemplo—, que es para lo que se
   * mira esta columna.
   */
  private async record(answer: MockAnswer, request: MockRequest, startedAt: number): Promise<void> {
    if (!answer.mockServerId) return;
    try {
      await this.commandBus.execute(
        new RecordMockCallCommand(
          answer.mockServerId,
          request.method,
          request.path,
          answer.outcome,
          Date.now() - startedAt - answer.delayMs,
        ),
      );
    } catch {
      /* un mock que se cae porque su bitácora se cayó es peor que un mock sin bitácora */
    }
  }
}
