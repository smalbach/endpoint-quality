/**
 * Piezas compartidas, cada una por el borde que el resto de la suite no pisa: el entorno que se niega
 * a arrancar, el bus en memoria cuando nadie contesta, el hash de verdad ante un resumen raro, el
 * cifrador sin clave, el lector del webhook cuando el socket falla, el contrato derivado de reglas
 * poco comunes y el contador de límites cuando se llena.
 */
import { EventEmitter } from "node:events";
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { Logger, type LoggerService } from "@nestjs/common";
import { Allow, ArrayMinSize, IsNumber, IsOptional, IsPositive } from "class-validator";
import type { OpenAPIObject } from "@nestjs/swagger";

import { loadEnv } from "@/shared/config/env";
import { InMemoryBusHub, InMemoryInstanceBus } from "@/shared/bus/in-memory-instance-bus";
import { fromWireError, InstanceUnreachableError, toWireError } from "@/shared/bus/instance-bus";
import { DomainError } from "@/shared/errors/domain-error";
import { ScryptPasswordHasher } from "@/shared/crypto/password-hasher";
import { SecretCipherProvider } from "@/shared/crypto/secret-cipher.provider";
import { flowHookBodyParser, FLOW_HOOK_PATH } from "@/shared/http/hook-body";
import { describeBodies, schemaForClass } from "@/shared/openapi/describe-bodies";
import { describeErrors } from "@/shared/openapi/describe-errors";
import { InMemoryRateLimitStore } from "@/shared/rate-limit/rate-limit-store";
import type { Env } from "@/shared/config/env";

const base = {
  DATABASE_URL: "postgres://unused/unused",
  JWT_ACCESS_SECRET: "a".repeat(48),
  JWT_REFRESH_SECRET: "b".repeat(48),
};

/** Lo que registra Nest, recogido en vez de impreso. */
function captureLogs(): { warnings: string[]; restore: () => void } {
  const warnings: string[] = [];
  const sink: LoggerService = {
    log: () => undefined,
    error: () => undefined,
    warn: (message: unknown) => void warnings.push(String(message)),
  };
  Logger.overrideLogger(sink);
  return { warnings, restore: () => Logger.overrideLogger(false) };
}

describe("loadEnv", () => {
  test("un booleano que ya lo es se toma tal cual, y el texto se interpreta", () => {
    const env = loadEnv({ ...base, ALLOW_PRIVATE_TARGETS: true } as unknown as NodeJS.ProcessEnv);
    assert.equal(env.ALLOW_PRIVATE_TARGETS, true);
    assert.equal(loadEnv({ ...base, ALLOW_PRIVATE_TARGETS: "YES" }).ALLOW_PRIVATE_TARGETS, true);
    assert.equal(loadEnv({ ...base, ALLOW_PRIVATE_TARGETS: "no" }).ALLOW_PRIVATE_TARGETS, false);
  });

  test("un CAPTURE_PROXY_PORT vacío deja el proxy apagado en vez de abrirlo en un puerto cualquiera", () => {
    assert.equal(loadEnv({ ...base, CAPTURE_PROXY_PORT: "" }).CAPTURE_PROXY_PORT, undefined);
    assert.equal(loadEnv({ ...base, CAPTURE_PROXY_PORT: "   " }).CAPTURE_PROXY_PORT, undefined);
    assert.equal(loadEnv({ ...base, CAPTURE_PROXY_PORT: "0" }).CAPTURE_PROXY_PORT, 0);
    assert.equal(loadEnv({ ...base }).CAPTURE_PROXY_PORT, undefined);
  });

  test("MAIL_DRIVER=brevo sin clave no arranca, y con clave sí", () => {
    assert.throws(
      () => loadEnv({ ...base, MAIL_DRIVER: "brevo" }),
      (error: Error) => /BREVO_API_KEY: requerida con MAIL_DRIVER=brevo/.test(error.message),
    );
    assert.equal(loadEnv({ ...base, MAIL_DRIVER: "brevo", BREVO_API_KEY: "xkeysib-1" }).MAIL_DRIVER, "brevo");
  });

  test("un fallo que no es de ninguna variable se nombra como de la raíz", () => {
    assert.throws(
      () => loadEnv(null as unknown as NodeJS.ProcessEnv),
      (error: Error) => error.message.startsWith("Configuración de entorno inválida:\n  (raíz): "),
    );
  });
});

describe("el bus en memoria", () => {
  test("una orden sin cuerpo llega como null, no como undefined", async () => {
    const hub = new InMemoryBusHub();
    const a = new InMemoryInstanceBus(hub, "a");
    const b = new InMemoryInstanceBus(hub, "b");
    let received: unknown = "sin llamar";
    b.handle("eco", (message) => {
      received = message;
      return { ok: true };
    });
    assert.deepEqual(await a.request("b", "eco", undefined), { ok: true });
    assert.equal(received, null);
  });

  test("una instancia que no atiende el tema contesta que no llega", async () => {
    const hub = new InMemoryBusHub();
    const a = new InMemoryInstanceBus(hub, "a");
    new InMemoryInstanceBus(hub, "b");
    await assert.rejects(a.request("b", "nadie-lo-atiende", {}), (error: unknown) => {
      assert.ok(error instanceof InstanceUnreachableError);
      assert.equal(error.instanceId, "b");
      assert.match(error.message, /no atiende nadie-lo-atiende/);
      return true;
    });
  });

  test("un oyente que lanza algo que no es un Error no tumba a los demás, y se registra", () => {
    const logs = captureLogs();
    try {
      const bus = new InMemoryInstanceBus();
      const seen: unknown[] = [];
      bus.subscribe("t", () => {
        throw "texto suelto";
      });
      bus.subscribe("t", (message) => void seen.push(message));
      bus.publish("t", { n: 1 });
      assert.deepEqual(seen, [{ n: 1 }]);
      assert.deepEqual(logs.warnings, ["Un oyente de t falló: texto suelto"]);
    } finally {
      logs.restore();
    }
  });
});

describe("los errores por el cable", () => {
  test("lo que no es un Error viaja como su texto", () => {
    assert.deepEqual(toWireError(42), { message: "42" });
    const back = fromWireError(toWireError(42));
    assert.ok(!(back instanceof DomainError));
    assert.equal(back.message, "42");
  });

  test("un error de dominio sin campos llega con la lista vacía y su código", () => {
    const back = fromWireError({ kind: "conflict", message: "ocupado", code: "ya-existe" });
    assert.ok(back instanceof DomainError);
    assert.equal(back.kind, "conflict");
    assert.deepEqual(back.fields, []);
    assert.equal(back.code, "ya-existe");
  });
});

describe("el hash de contraseñas de producción", () => {
  test("un resumen que no es scrypt no verifica, sin gastar el KDF", async () => {
    const hasher = new ScryptPasswordHasher();
    assert.equal(await hasher.verify("lo-que-sea", "bcrypt$2b$10$abc"), false);
    assert.equal(await hasher.verify("lo-que-sea", "scrypt$131072$8$1$$"), false);
  });

  test("unos parámetros imposibles en el resumen rechazan en vez de dar por buena la clave", async () => {
    const hasher = new ScryptPasswordHasher();
    await assert.rejects(hasher.verify("lo-que-sea", "scrypt$3$8$1$c2FsdA==$ZGlnZXN0"), {
      code: "ERR_CRYPTO_INVALID_SCRYPT_PARAMS",
    });
  });
});

describe("el cifrador de secretos del entorno", () => {
  test("con SECRETS_KEY cifra y descifra", () => {
    const cipher = new SecretCipherProvider({ SECRETS_KEY: Buffer.alloc(32, 3).toString("base64") } as Env);
    const sealed = cipher.encrypt("s3creto");
    assert.notEqual(sealed, "s3creto");
    assert.equal(cipher.decrypt(sealed), "s3creto");
  });

  test("sin SECRETS_KEY se niega también a descifrar", () => {
    const cipher = new SecretCipherProvider({} as Env);
    assert.throws(() => cipher.decrypt("v1.x.y.z"), /SECRETS_KEY no está configurada/);
  });
});

/** Una petición y una respuesta de Express con lo justo para el lector del webhook. */
function exchange(headers: Record<string, string>, headersSent = false) {
  const socket = { destroyed: 0, destroy() { this.destroyed += 1; } };
  const request = Object.assign(new EventEmitter(), {
    headers,
    socket,
    paused: false,
    pause() {
      this.paused = true;
    },
  });
  const sent: { status?: number; type?: string; body?: Record<string, unknown>; headers: Record<string, string> } = {
    headers: {},
  };
  const response = Object.assign(new EventEmitter(), {
    headersSent,
    setHeader: (name: string, value: string) => void (sent.headers[name] = value),
    status(code: number) {
      sent.status = code;
      return this;
    },
    type(value: string) {
      sent.type = value;
      return this;
    },
    json(body: Record<string, unknown>) {
      sent.body = body;
      return this;
    },
  });
  let nextCalls = 0;
  const run = () =>
    flowHookBodyParser()(request as never, response as never, () => {
      nextCalls += 1;
    });
  return { request, response, socket, sent, run, nexts: () => nextCalls };
}

describe("el lector del cuerpo del webhook", () => {
  test("sin cuerpo pasa de largo sin leer nada", () => {
    const hook = exchange({});
    hook.run();
    assert.equal(hook.nexts(), 1);
    assert.equal((hook.request as unknown as { body?: unknown }).body, undefined);
    assert.equal(hook.request.listenerCount("data"), 0);
  });

  test("un error del socket a medio leer es un 400 en Problem Details y se cuelga", () => {
    const hook = exchange({ "content-length": "10" });
    hook.run();
    hook.request.emit("data", Buffer.from("abc"));
    hook.request.emit("error", new Error("ECONNRESET"));
    assert.equal(hook.nexts(), 0);
    assert.equal(hook.sent.status, 400);
    assert.equal(hook.sent.type, "application/problem+json");
    assert.equal(hook.sent.headers.Connection, "close");
    assert.deepEqual(hook.sent.body, {
      type: "https://endpoint-quality.dev/problems/flow-hook-body-unreadable",
      title: "Solicitud inválida",
      status: 400,
      detail: "No se pudo leer el cuerpo",
      instance: FLOW_HOOK_PATH,
    });
    assert.ok(hook.request.paused);
    assert.equal(hook.socket.destroyed, 0, "se cortó antes de mandar la respuesta");
    hook.response.emit("finish");
    assert.equal(hook.socket.destroyed, 1);
  });

  test("lo que llega después de cortar no contesta dos veces", () => {
    const hook = exchange({ "transfer-encoding": "chunked" });
    hook.run();
    hook.request.emit("data", Buffer.alloc(1_048_577));
    assert.equal(hook.sent.status, 413);
    hook.sent.status = undefined;
    hook.request.emit("error", new Error("tarde"));
    assert.equal(hook.sent.status, undefined);
    assert.equal(hook.nexts(), 0);
  });

  test("con la respuesta ya enviada solo queda colgar", () => {
    const hook = exchange({ "content-length": String(2 * 1_048_576) }, true);
    hook.run();
    assert.equal(hook.sent.status, undefined);
    assert.equal(hook.socket.destroyed, 1);
    assert.ok(hook.request.paused);
  });
});

describe("el contrato derivado de la validación", () => {
  class Numbers {
    @IsNumber() amount: number;
    @IsPositive() count: number;
    @ArrayMinSize(2) tags: string[];
    @Allow() anything: unknown;
  }

  class OnlyOptional {
    @IsOptional() maybe?: string;
  }

  test("isNumber, isPositive y arrayMinSize se escriben como su palabra de JSON Schema", () => {
    assert.deepEqual(schemaForClass(Numbers), {
      type: "object",
      required: ["amount", "count", "tags", "anything"],
      properties: {
        amount: { type: "number" },
        count: { type: "number", exclusiveMinimum: 0 },
        tags: { type: "array", minItems: 2 },
        // Una regla sin nombre ni restricciones declara la propiedad y no inventa su tipo.
        anything: {},
      },
    });
  });

  test("una clase que solo dice qué es opcional no tiene esquema que ofrecer", () => {
    assert.equal(schemaForClass(OnlyOptional), null);
  });

  test("rellena un esquema vacío aunque no traiga `properties`, y respeta uno escrito a mano", () => {
    const handWritten = { type: "object", properties: { email: { type: "string" } } };
    const document = describeBodies({
      openapi: "3.0.0",
      info: { title: "t", version: "1" },
      paths: {},
      components: { schemas: { LoginDto: { type: "object" }, RegisterDto: handWritten } },
    } as OpenAPIObject);
    const login = document.components!.schemas!.LoginDto as { required?: string[] };
    assert.deepEqual(login.required, ["email", "password"]);
    assert.equal(document.components!.schemas!.RegisterDto, handWritten);
  });

  test("un documento sin rutas recibe igualmente el esquema de ProblemDetails", () => {
    const document = describeErrors({ openapi: "3.0.0", info: { title: "t", version: "1" } } as OpenAPIObject);
    assert.ok(document.components?.schemas?.ProblemDetails);
    assert.equal(document.paths, undefined);
  });
});

describe("el contador de límites en memoria, lleno", () => {
  const MAX = 100_000;

  test("barre las ventanas vencidas antes de hacer sitio", async () => {
    let now = 0;
    const store = new InMemoryRateLimitStore(() => now);
    for (let index = 0; index < MAX / 2; index += 1) await store.hit(`corta-${index}`, 10);
    for (let index = 0; index < MAX / 2; index += 1) await store.hit(`larga-${index}`, 60_000);
    now = 100;
    assert.deepEqual(await store.hit("nueva", 1_000), { hits: 1, resetInMs: 1_000 });
    // La más antigua de las que siguen abiertas no se olvidó: el barrido hizo sitio de sobra.
    assert.deepEqual(await store.peek("larga-0"), { hits: 1, resetInMs: 59_900 });
    assert.equal(await store.peek("corta-0"), null);
  });

  test("si ni barriendo cabe, olvida la más antigua", async () => {
    const store = new InMemoryRateLimitStore(() => 0);
    for (let index = 0; index < MAX; index += 1) await store.hit(`k-${index}`, 60_000);
    assert.deepEqual(await store.hit("nueva", 60_000), { hits: 1, resetInMs: 60_000 });
    assert.equal(await store.peek("k-0"), null, "la más antigua sigue ahí");
    assert.deepEqual(await store.peek("k-1"), { hits: 1, resetInMs: 60_000 });
    assert.deepEqual(await store.peek("nueva"), { hits: 1, resetInMs: 60_000 });
  });
});
