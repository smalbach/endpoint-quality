/**
 * El registro: la traza, la línea JSON, el puente con Nest y las dos piezas que miden una
 * operación.
 *
 * Lo que se comprueba aquí es lo que hace que estas líneas sirvan para medir y no solo para leer:
 * que la traza cruza sin que nadie la pase de argumento, que los campos se llaman igual cuando la
 * operación termina y cuando falla, que una duración ausente se queda ausente en vez de salir como
 * cero, y que ninguna de las dos escribe un cuerpo ni un token.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { of, throwError } from "rxjs";
import type { ArgumentsHost, CallHandler, ExecutionContext } from "@nestjs/common";
import { BadRequestException } from "@nestjs/common";

import { FixedClock } from "@/shared/clock/clock.port";
import { NullLogger, RecordingLogger, type LogFields } from "@/shared/logging/logger.port";
import { JsonLogger } from "@/shared/logging/json-logger";
import { currentTrace, elapsedMs, runWithTrace, traceIdFrom, TRACE_HEADER_OUT } from "@/shared/logging/trace-context";
import { traceMiddleware } from "@/shared/logging/trace.middleware";
import { NestLoggerBridge } from "@/shared/logging/nest-logger.bridge";
import { operationFields } from "@/shared/logging/operation-fields";
import { OperationLogInterceptor } from "@/shared/logging/operation.interceptor";
import { ProblemDetailsFilter } from "@/shared/errors/problem-details.filter";
import { NotFoundError } from "@/shared/errors/domain-error";
import { withoutHookToken } from "@/shared/http/redact-url";

const noon = new Date(Date.UTC(2026, 8, 21, 12, 0, 0, 500));

describe("la traza de una petición", () => {
  test("un identificador con forma de identificador se acepta, y cualquier otra cosa da uno nuevo", () => {
    assert.equal(traceIdFrom("abc12345"), "abc12345");
    assert.equal(traceIdFrom("con-guiones_y_68_caracteres".repeat(1)), "con-guiones_y_68_caracteres");
    // Corto, con espacios, con salto de línea —el que inventaría entradas enteras en el registro—
    // o directamente ausente: todos dan uno nuevo, y nunca el mismo.
    for (const header of ["corto", "con espacio", "abc12345\nlevel=error", undefined, ["abc12345"], 7]) {
      const traceId = traceIdFrom(header);
      assert.notEqual(traceId, header);
      assert.match(traceId, /^[0-9a-f-]{36}$/);
    }
  });

  test("fuera de una petición no hay traza ni duración, que es lo correcto", () => {
    assert.equal(currentTrace(), undefined);
    assert.equal(elapsedMs(Date.now()), undefined);
  });

  test("dentro, la traza cruza sin pasarla y la duración se cuenta desde la entrada", () => {
    runWithTrace("t-1234567", 1_000, () => {
      assert.deepEqual(currentTrace(), { traceId: "t-1234567", startedAt: 1_000 });
      assert.equal(elapsedMs(1_412), 412);
    });
  });

  test("el middleware devuelve el identificador en la cabecera y corre lo siguiente dentro de la traza", () => {
    const headers: Record<string, string> = {};
    let seen: string | undefined;
    const middleware = traceMiddleware(new FixedClock(noon));
    middleware(
      { headers: { "x-trace-id": "de-fuera-1" } } as never,
      { setHeader: (name: string, value: string) => void (headers[name] = value) } as never,
      () => {
        seen = currentTrace()?.traceId;
        assert.equal(currentTrace()?.startedAt, noon.getTime());
      },
    );
    assert.equal(headers[TRACE_HEADER_OUT], "de-fuera-1");
    assert.equal(seen, "de-fuera-1");
  });
});

describe("la línea JSON", () => {
  const lines: string[] = [];
  const logger = (level: Parameters<JsonLogger["log"]>[0], fields?: LogFields) => {
    lines.length = 0;
    new JsonLogger({ level: "info", format: "json", clock: new FixedClock(noon) }, (line) => void lines.push(line)).log(
      level,
      "operación",
      fields,
    );
    return lines;
  };

  test("lleva la hora del reloj, el nivel, el mensaje y los campos tal cual", () => {
    assert.deepEqual(JSON.parse(logger("info", { op: "GET /health", ms: 3 })[0]), {
      ts: "2026-09-21T12:00:00.500Z",
      level: "info",
      msg: "operación",
      op: "GET /health",
      ms: 3,
    });
  });

  test("sin campos sale igual, y por debajo del nivel no sale nada", () => {
    assert.equal(JSON.parse(logger("info")[0]).msg, "operación");
    assert.deepEqual(logger("debug", { op: "x" }), []);
  });

  test("`silent` no escribe ni los errores", () => {
    const written: string[] = [];
    new JsonLogger(
      { level: "silent", format: "json", clock: new FixedClock(noon) },
      (line) => void written.push(line),
    ).log("error", "se ha roto");
    assert.deepEqual(written, []);
  });

  test("dentro de una petición, cada línea cita su traza", () => {
    runWithTrace("t-abcdefgh", noon.getTime(), () => {
      assert.equal(JSON.parse(logger("warn", { status: 404 })[0]).traceId, "t-abcdefgh");
    });
  });

  test("un campo que no se puede escribir degrada a una línea que lo dice, y no rompe la petición", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    assert.deepEqual(JSON.parse(logger("error", { detail: circular })[0]), {
      ts: "2026-09-21T12:00:00.500Z",
      level: "error",
      msg: "operación",
      fieldsError: "no serializable",
    });
  });

  test("en desarrollo sale como texto: la hora, el nivel, el mensaje y los campos detrás", () => {
    const written: string[] = [];
    const dev = new JsonLogger(
      { level: "info", format: "text", clock: new FixedClock(noon) },
      (line) => void written.push(line),
    );
    dev.log("info", "operación", { op: "GET /health", ms: 3 });
    dev.log("info", "sin campos");
    assert.deepEqual(written, [
      '12:00:00.500 info  operación · op="GET /health" ms=3',
      "12:00:00.500 info  sin campos",
    ]);
  });

  test("sin destino explícito, la línea va a la salida estándar y a ningún fichero", () => {
    const written: string[] = [];
    const original = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string) => {
      written.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    try {
      new JsonLogger({ level: "info", format: "json", clock: new FixedClock(noon) }).log("info", "a stdout");
    } finally {
      process.stdout.write = original;
    }
    assert.deepEqual(written, ['{"ts":"2026-09-21T12:00:00.500Z","level":"info","msg":"a stdout"}\n']);
  });

  test("el registro apagado y el recogido cumplen el mismo puerto", () => {
    new NullLogger().log("info", "nada");
    const recording = new RecordingLogger();
    recording.log("warn", "algo", { op: "GET /x" });
    recording.log("warn", "algo más");
    assert.deepEqual(recording.entries, [
      { level: "warn", message: "algo", fields: { op: "GET /x" } },
      { level: "warn", message: "algo más", fields: {} },
    ]);
  });
});

describe("lo que ya escribe Nest", () => {
  const bridge = () => {
    const logger = new RecordingLogger();
    return { logger, nest: new NestLoggerBridge(logger) };
  };

  test("cada nivel de Nest cae en el de aquí, y el contexto es un campo", () => {
    const { logger, nest } = bridge();
    nest.log("arrancando", "Bootstrap");
    nest.warn("sin Redis", "Bus");
    nest.error("se ha roto", "Runs");
    nest.debug("detalle", "Queue");
    nest.verbose("más detalle", "Queue");
    nest.fatal("adiós");
    assert.deepEqual(
      logger.entries.map((entry) => [entry.level, entry.message, entry.fields]),
      [
        ["info", "arrancando", { source: "nest", context: "Bootstrap" }],
        ["warn", "sin Redis", { source: "nest", context: "Bus" }],
        ["error", "se ha roto", { source: "nest", context: "Runs" }],
        ["debug", "detalle", { source: "nest", context: "Queue" }],
        ["debug", "más detalle", { source: "nest", context: "Queue" }],
        ["error", "adiós", { source: "nest", fatal: true }],
      ],
    );
  });

  test("la pila va a un campo aparte, y un mensaje que no es texto se conserva como texto", () => {
    const { logger, nest } = bridge();
    const error = new Error("falló");
    error.stack = "Error: falló\n    at algo";
    nest.error("500 en POST /runs", error.stack, "Errors");
    nest.error(error);
    nest.log({ plan: 3 });
    nest.log("suelto");

    const sinPila = new Error("sin pila");
    sinPila.stack = undefined;
    nest.error(sinPila);

    const circular: Record<string, unknown> = {};
    circular.self = circular;
    nest.log(circular);

    assert.deepEqual(
      logger.entries.map((entry) => [entry.message, entry.fields]),
      [
        ["500 en POST /runs", { source: "nest", context: "Errors", detail: "Error: falló\n    at algo" }],
        ["Error: falló\n    at algo", { source: "nest" }],
        ['{"plan":3}', { source: "nest" }],
        ["suelto", { source: "nest" }],
        ["sin pila", { source: "nest" }],
        ["[object Object]", { source: "nest" }],
      ],
    );
  });

  test("un contexto que no es texto también se conserva, como detalle", () => {
    const { logger, nest } = bridge();
    nest.log("con destino raro", { instancia: 2 });
    assert.deepEqual(logger.entries[0].fields, { source: "nest", detail: '{"instancia":2}' });
    nest.log("sin nada más", undefined);
    assert.deepEqual(logger.entries[1].fields, { source: "nest", detail: "undefined" });
  });
});

describe("los campos de una operación", () => {
  test("el patrón de la ruta es lo que agrupa, no la URL con sus identificadores", () => {
    const fields = operationFields(
      { method: "GET", url: "/orgs/o1/dashboard?x=1", route: { path: "/orgs/:organizationId/dashboard" } },
      12,
    );
    assert.equal(fields.route, "/orgs/:organizationId/dashboard");
    assert.deepEqual(fields.log, { op: "GET /orgs/:organizationId/dashboard", ms: 12 });
  });

  test("sin manejador que la resuelva —un 404— queda la ruta sin la cadena de consulta", () => {
    assert.deepEqual(operationFields({ method: "POST", url: "/no/existe?x=1" }, 1).log, {
      op: "POST /no/existe",
      ms: 1,
    });
  });

  test("el token de un webhook no se repite en el registro", () => {
    assert.equal(withoutHookToken("/hooks/flows/tok-secreto?x=1"), "/hooks/flows/[token-redactado]?x=1");
    assert.equal(
      operationFields({ method: "POST", url: "/hooks/flows/tok-secreto" }, 1).log.op,
      "POST /hooks/flows/[token-redactado]",
    );
  });

  test("una duración ausente se queda ausente, y un método ausente no inventa uno", () => {
    assert.deepEqual(operationFields({ url: "/x" }, undefined).log, { op: "? /x" });
    assert.deepEqual(operationFields({}, undefined).log, { op: "? " });
  });

  test("de quien llama se anota su identificador: el usuario, o la organización del token de CI", () => {
    const user = { method: "GET", url: "/x", principal: { kind: "user", userId: "u1", email: "a@b.c" } };
    assert.deepEqual(operationFields(user, 1).log.userId, "u1");
    const token = { method: "GET", url: "/x", principal: { kind: "api-token", tokenId: "k1", organizationId: "o1" } };
    assert.deepEqual(operationFields(token, 1).log, { op: "GET /x", ms: 1, tokenId: "k1", organizationId: "o1" });
  });
});

describe("la operación que termina bien", () => {
  const httpContext = (request: unknown, statusCode?: number, type = "http") =>
    ({
      getType: () => type,
      switchToHttp: () => ({ getRequest: () => request, getResponse: () => ({ statusCode }) }),
    }) as unknown as ExecutionContext;
  const handler = (value: unknown = "ok"): CallHandler => ({ handle: () => of(value) });

  const interceptor = (logger: RecordingLogger) => new OperationLogInterceptor(logger, new FixedClock(new Date(2_000)));

  test("una línea con la operación, su duración, su estado y quién llamaba", () => {
    const logger = new RecordingLogger();
    runWithTrace("t-abcdefgh", 1_500, () => {
      interceptor(logger)
        .intercept(
          httpContext(
            {
              method: "GET",
              url: "/orgs/o1/x",
              route: { path: "/orgs/:id/x" },
              principal: { kind: "user", userId: "u1" },
            },
            200,
          ),
          handler(),
        )
        .subscribe();
    });
    assert.deepEqual(logger.entries, [
      {
        level: "info",
        message: "operación",
        fields: { op: "GET /orgs/:id/x", ms: 500, userId: "u1", outcome: "ok", status: 200 },
      },
    ]);
  });

  test("el healthcheck del contenedor se registra en `debug`, y una respuesta sin estado no lo inventa", () => {
    const logger = new RecordingLogger();
    interceptor(logger)
      .intercept(httpContext({ method: "GET", url: "/health", route: { path: "/health" } }), handler())
      .subscribe();
    assert.equal(logger.entries[0].level, "debug");
    assert.equal("status" in logger.entries[0].fields, false);
    // Sin traza —fuera de una petición— no hay duración que contar.
    assert.equal("ms" in logger.entries[0].fields, false);
  });

  test("lo que no es una petición HTTP pasa de largo sin línea", () => {
    const logger = new RecordingLogger();
    const values: unknown[] = [];
    interceptor(logger)
      .intercept(httpContext({}, 200, "ws"), handler("mensaje"))
      .subscribe((value) => values.push(value));
    assert.deepEqual(values, ["mensaje"]);
    assert.deepEqual(logger.entries, []);
  });

  test("lo que falla no se registra aquí: lo escribe el filtro, y así no salen dos líneas", () => {
    const logger = new RecordingLogger();
    let failed: unknown;
    interceptor(logger)
      .intercept(httpContext({ method: "GET", url: "/x" }, 200), {
        handle: () => throwError(() => new NotFoundError("no está")),
      })
      .subscribe({ error: (error: unknown) => void (failed = error) });
    assert.ok(failed instanceof NotFoundError);
    assert.deepEqual(logger.entries, []);
  });
});

describe("la operación que no termina bien", () => {
  function run(exception: unknown, logger: RecordingLogger, url = "/orgs/o1/x") {
    const sent: { body?: Record<string, unknown> } = {};
    const response = {
      status: () => response,
      type: () => response,
      json: (body: Record<string, unknown>) => void (sent.body = body),
    };
    const host = {
      switchToHttp: () => ({
        getResponse: () => response,
        getRequest: () => ({ url, method: "POST", route: { path: "/orgs/:id/x" } }),
      }),
    } as unknown as ArgumentsHost;
    new ProblemDetailsFilter(logger, new FixedClock(new Date(2_000))).catch(exception, host);
    return sent;
  }

  test("un 4xx es un aviso con su estado y su tipo, y sin pila: no hay ninguna que contar", () => {
    const logger = new RecordingLogger();
    run(new BadRequestException("mal"), logger);
    assert.deepEqual(logger.entries, [
      {
        level: "warn",
        message: "operación",
        fields: {
          op: "POST /orgs/:id/x",
          outcome: "error",
          status: 400,
          problem: "https://endpoint-quality.dev/problems/400",
        },
      },
    ]);
  });

  test("un 5xx es un error y lleva la causa completa, que nunca sale en el cuerpo", () => {
    const logger = new RecordingLogger();
    const roto = new Error("se ha roto");
    roto.stack = "Error: se ha roto\n    at dentro";
    const sent = run(roto, logger);
    assert.equal(logger.entries[0].level, "error");
    assert.equal(logger.entries[0].fields.detail, "Error: se ha roto\n    at dentro");
    assert.equal(logger.entries[0].fields.status, 500);
    assert.equal("detail" in (sent.body ?? {}) && sent.body?.detail, "La solicitud no pudo completarse");

    // Lo que no es un `Error` también deja constancia de lo que era.
    run("una cadena", logger);
    assert.equal(logger.entries[1].fields.detail, "una cadena");
  });

  test("dentro de una petición, la respuesta lleva la traza y la línea su duración", () => {
    const logger = new RecordingLogger();
    const sent = runWithTrace("t-abcdefgh", 1_400, () => run(new NotFoundError("no está"), logger));
    assert.equal(sent.body?.traceId, "t-abcdefgh");
    assert.equal(logger.entries[0].fields.ms, 600);
  });

  test("fuera de una petición, el cuerpo no inventa una traza", () => {
    const sent = run(new NotFoundError("no está"), new RecordingLogger());
    assert.equal("traceId" in (sent.body ?? {}), false);
  });
});
