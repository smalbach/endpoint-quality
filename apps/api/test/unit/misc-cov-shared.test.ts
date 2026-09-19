/**
 * Piezas compartidas que el resto de la suite solo toca de refilón: la cola y las respuestas raras
 * del proceso de scripts, los dos buzones de correo, la red configurada por el despliegue y el reloj
 * de los monitores.
 */
import { afterEach, describe, mock, test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import childProcess from "node:child_process";
import { Logger } from "@nestjs/common";

import { ProcessScriptSandbox } from "@/shared/scripts/process-script-sandbox";
import { SCRIPT_LIMITS, type ScriptInput } from "@/shared/scripts/script-sandbox";
import { BrevoMailer, LogMailer, monitorAlertMail } from "@/shared/mail/mailer";
import { ConfiguredSafeFetch, policyFromEnv } from "@/shared/http/safe-fetch.provider";
import { BlockedTargetError } from "@/shared/http/safe-fetch";
import { loadEnv } from "@/shared/config/env";
import { MonitorScheduler } from "@/modules/monitors/infrastructure/monitor.scheduler";
import { FireDueMonitorsCommand } from "@/modules/monitors/application/commands/fire-due-monitors";
import { TEST_ENV } from "@test/support/test-app";

afterEach(() => mock.restoreAll());

const input: ScriptInput = {
  phase: "pre",
  code: "1",
  environment: { name: null, values: {} },
  variables: {},
  request: { method: "GET", url: "/", headers: {}, body: null },
  response: null,
};

/** Un hijo de mentira: lo que el proceso de verdad haría, a demanda de la prueba. */
class FakeChild extends EventEmitter {
  exitCode: number | null = null;
  signalCode: string | null = null;
  stderr = new EventEmitter();
  killed: string[] = [];
  sent: unknown[] = [];
  sendError: Error | null = null;
  kill(signal: string) {
    this.killed.push(signal);
    return true;
  }
  send(message: unknown, callback: (error: Error | null) => void) {
    this.sent.push(message);
    queueMicrotask(() => callback(this.sendError));
    return true;
  }
}

function fakeFork(setup: (child: FakeChild) => void = () => {}) {
  const children: FakeChild[] = [];
  const forked = mock.method(childProcess, "fork", () => {
    const child = new FakeChild();
    children.push(child);
    setup(child);
    return child;
  });
  return { children, forked };
}

describe("el proceso del script, visto desde fuera", () => {
  test("un fallo que el proceso cuenta es el error del resultado, y el hijo vivo se mata", async () => {
    const { children, forked } = fakeFork((child) =>
      setImmediate(() => child.emit("message", { failure: "SyntaxError: nope" })),
    );
    const outcome = await new ProcessScriptSandbox().run(input);
    assert.equal(outcome.error, "SyntaxError: nope");
    assert.deepEqual(children[0]!.killed, ["SIGKILL"]);
    // Sin entorno heredado y con el modelo de permisos: lo que protege los secretos.
    const options = forked.mock.calls[0]!.arguments[2] as { env: object; execArgv: string[] };
    assert.deepEqual(options.env, {});
    assert.ok(options.execArgv.includes("--permission"));
    assert.ok(options.execArgv.includes("--disallow-code-generation-from-strings"));
    const sent = children[0]!.sent[0] as { input: ScriptInput; limits: { scriptMs: number } };
    assert.deepEqual(sent.input, input);
    assert.equal(sent.limits.scriptMs, SCRIPT_LIMITS.scriptMs);
  });

  test("una respuesta que no es JSON, o que no es texto, es un resultado ilegible y vacío", async () => {
    for (const reply of [{ result: "{roto" }, { result: 42 }, null]) {
      fakeFork((child) => setImmediate(() => child.emit("message", reply)));
      const outcome = await new ProcessScriptSandbox().run(input);
      assert.equal(outcome.error, "El script no devolvió un resultado legible");
      assert.deepEqual(outcome.logs, []);
      assert.deepEqual(outcome.tests, []);
      assert.equal(outcome.headers, null);
      mock.restoreAll();
    }
  });

  test("un hijo que ya salió no se mata otra vez, y un cierre posterior no pisa la respuesta", async () => {
    const { children } = fakeFork((child) =>
      setImmediate(() => {
        child.exitCode = 0;
        child.emit("message", { result: JSON.stringify({ error: null, logs: [{ level: "log", text: "hola" }] }) });
        child.emit("close", 0, null);
      }),
    );
    const outcome = await new ProcessScriptSandbox().run(input);
    assert.equal(outcome.error, null);
    assert.deepEqual(outcome.logs, [{ level: "log", text: "hola" }]);
    assert.deepEqual(children[0]!.killed, []);
  });

  test("morir sin responder dice la señal o el código, y la memoria agotada se nombra", async () => {
    fakeFork((child) => setImmediate(() => child.emit("close", null, "SIGSEGV")));
    assert.match((await new ProcessScriptSandbox().run(input)).error!, /terminó sin responder \(SIGSEGV\)/);
    mock.restoreAll();

    fakeFork((child) => setImmediate(() => child.emit("close", 3, null)));
    assert.match((await new ProcessScriptSandbox().run(input)).error!, /terminó sin responder \(código 3\)/);
    mock.restoreAll();

    fakeFork((child) =>
      setImmediate(() => {
        child.stderr.emit("data", Buffer.from("FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory"));
        child.emit("close", 134, null);
      }),
    );
    assert.equal(
      (await new ProcessScriptSandbox().run(input)).error,
      `El script superó el límite de ${SCRIPT_LIMITS.heapMb} MB de memoria`,
    );
  });

  test("un proceso que no arranca, o al que no se le puede pasar el script, es un error con su causa", async () => {
    fakeFork((child) => setImmediate(() => child.emit("error", new Error("EAGAIN"))));
    assert.equal((await new ProcessScriptSandbox().run(input)).error, "No se pudo arrancar el proceso del script: EAGAIN");
    mock.restoreAll();

    fakeFork((child) => {
      child.sendError = new Error("canal cerrado");
    });
    assert.equal(
      (await new ProcessScriptSandbox().run(input)).error,
      "No se pudo pasar el script a su proceso: canal cerrado",
    );
  });

  test("más scripts que procesos permitidos esperan su turno, y cada uno recibe el suyo", async () => {
    const { children } = fakeFork();
    const sandbox = new ProcessScriptSandbox();
    const total = SCRIPT_LIMITS.concurrency + 2;
    const runs = Array.from({ length: total }, (_, index) =>
      sandbox.run({ ...input, code: `// ${index}` }),
    );
    await new Promise((resolve) => setImmediate(resolve));
    // Solo `concurrency` procesos vivos; el resto, en cola.
    assert.equal(children.length, SCRIPT_LIMITS.concurrency);

    const answer = (child: FakeChild) => {
      const code = (child.sent[0] as { input: ScriptInput }).input.code;
      child.emit("message", { result: JSON.stringify({ error: null, logs: [{ level: "log", text: code }] }) });
    };
    answer(children[0]!);
    answer(children[1]!);
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(children.length, total);
    for (const child of children.slice(2)) answer(child);

    const outcomes = await Promise.all(runs);
    assert.deepEqual(
      outcomes.map((outcome) => outcome.logs[0]!.text),
      Array.from({ length: total }, (_, index) => `// ${index}`),
    );
  });
});

describe("el correo", () => {
  test("el buzón de registro escribe destinatario, asunto y texto en el log", async () => {
    const logged = mock.method(Logger.prototype, "log", () => {});
    await new LogMailer().send({ to: "ana@example.com", subject: "Hola", html: "<p>x</p>", text: "cuerpo" });
    assert.equal(logged.mock.callCount(), 1);
    assert.equal(logged.mock.calls[0]!.arguments[0], "Para ana@example.com · Hola\ncuerpo");
  });

  test("Brevo recibe la clave en su cabecera y el correo en su forma; un no-2xx es un error", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    let status = 201;
    mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response("{}", { status });
    });
    const mailer = new BrevoMailer("clave-brevo", { email: "no-reply@eq.test", name: "EQ" });
    const mail = { to: "ana@example.com", subject: "Asunto", html: "<b>h</b>", text: "t" };
    await mailer.send(mail);
    assert.equal(calls[0]!.url, "https://api.brevo.com/v3/smtp/email");
    assert.equal(calls[0]!.init.method, "POST");
    assert.equal((calls[0]!.init.headers as Record<string, string>)["api-key"], "clave-brevo");
    assert.deepEqual(JSON.parse(String(calls[0]!.init.body)), {
      sender: { email: "no-reply@eq.test", name: "EQ" },
      to: [{ email: "ana@example.com" }],
      subject: "Asunto",
      htmlContent: "<b>h</b>",
      textContent: "t",
    });

    status = 401;
    await assert.rejects(mailer.send(mail), /Brevo respondió 401/);
  });

  test("el aviso de un monitor sin corrida no inventa una, y una corrida que no llegó a correr lo dice", () => {
    const base = {
      monitorName: "API <prod>",
      projectName: "Tienda",
      schedule: "cada 5 min",
      failures: 2,
      link: "https://eq.test/m/1?a=1&b=2",
    };
    const down = monitorAlertMail({ ...base, kind: "down", totals: null, note: "", runId: null });
    assert.ok(!down.text.includes("Corrida:"));
    assert.match(down.text, /La corrida no llegó a ejecutarse\./);
    assert.equal(down.subject, "🔴 «API <prod>» está en rojo · Tienda");
    // El nombre del monitor y el enlace van escapados en el HTML.
    assert.ok(down.html.includes("API &#60;prod&#62;"));
    assert.ok(down.html.includes("a=1&#38;b=2"));

    const noted = monitorAlertMail({ ...base, kind: "down", totals: null, note: "sin entorno", runId: "r-1" });
    assert.match(noted.text, /La corrida no llegó a ejecutarse: sin entorno/);
    assert.match(noted.text, /Corrida: r-1/);
  });
});

describe("la red del despliegue", () => {
  let server: Server | undefined;
  afterEach(() => new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve())));

  const listen = () =>
    new Promise<string>((resolve) => {
      server = createServer((request, response) => {
        let body = "";
        request.on("data", (chunk) => (body += chunk));
        request.on("end", () => {
          response.setHeader("content-type", "application/json");
          response.end(JSON.stringify({ method: request.method, auth: request.headers.authorization ?? null, body }));
        });
      });
      server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${(server!.address() as AddressInfo).port}/x`));
    });

  test("la política sale del entorno, y con los destinos privados cerrados localhost se bloquea", async () => {
    const env = loadEnv({ ...TEST_ENV, MAX_REDIRECTS: "2", REQUEST_TIMEOUT_MS: "1500" });
    assert.deepEqual(policyFromEnv(env), {
      allowPrivateTargets: false,
      maxRedirects: 2,
      timeoutMs: 1500,
      maxResponseBytes: env.MAX_RESPONSE_BYTES,
    });
    const fetcher = new ConfiguredSafeFetch(env);
    await assert.rejects(fetcher.get("http://127.0.0.1:9/"), BlockedTargetError);
    await assert.rejects(fetcher.request("http://127.0.0.1:9/", { method: "POST", body: "x" }), BlockedTargetError);
  });

  test("con los destinos privados abiertos, get y request llegan con sus cabeceras y su cuerpo", async () => {
    const url = await listen();
    const fetcher = new ConfiguredSafeFetch(loadEnv({ ...TEST_ENV, ALLOW_PRIVATE_TARGETS: "true" }));
    const got = await fetcher.get(url, { headers: { authorization: "Bearer t" } });
    assert.equal(got.status, 200);
    assert.deepEqual(JSON.parse(got.body), { method: "GET", auth: "Bearer t", body: "" });
    const posted = await fetcher.request(url, { method: "PUT", body: "hola" });
    assert.deepEqual(JSON.parse(posted.body), { method: "PUT", auth: null, body: "hola" });
  });
});

describe("el reloj de los monitores", () => {
  const scheduler = (seconds: string, execute: (command: unknown) => Promise<unknown>) => {
    const bus = { execute: mock.fn(execute) };
    const instance = new MonitorScheduler(bus as never, loadEnv({ ...TEST_ENV, MONITOR_TICK_SECONDS: seconds }));
    return { instance, bus, tick: () => (instance as unknown as { tick(): Promise<void> }).tick() };
  };

  test("con cero segundos no arranca ningún temporizador y apagar no rompe nada", () => {
    const logged = mock.method(Logger.prototype, "log", () => {});
    const interval = mock.method(globalThis, "setInterval");
    const { instance } = scheduler("0", async () => ({}));
    instance.onApplicationBootstrap();
    assert.equal(interval.mock.callCount(), 0);
    assert.match(String(logged.mock.calls[0]!.arguments[0]), /MONITOR_TICK_SECONDS=0/);
    instance.onApplicationShutdown();
  });

  test("con segundos, arranca un intervalo sin retener el proceso y el apagado lo limpia", () => {
    const cleared = mock.method(globalThis, "clearInterval");
    const { instance, bus } = scheduler("30", async () => ({}));
    instance.onApplicationBootstrap();
    const timer = (instance as unknown as { timer: NodeJS.Timeout }).timer;
    assert.ok(timer);
    assert.equal(timer.hasRef(), false);
    // Nada al arrancar: el horario manda.
    assert.equal(bus.execute.mock.callCount(), 0);
    instance.onApplicationShutdown();
    assert.equal(cleared.mock.calls[0]!.arguments[0], timer);
  });

  test("un turno lanza el comando, anota solo si reclamó algo, y dos turnos no se solapan", async () => {
    const logged = mock.method(Logger.prototype, "log", () => {});
    let release: (value: unknown) => void = () => {};
    const results = [
      new Promise((resolve) => (release = resolve)),
      Promise.resolve({ claimed: 0, started: 0, skipped: 0, failed: 0 }),
    ];
    const { bus, tick } = scheduler("60", () => results.shift() as Promise<unknown>);

    const first = tick();
    await tick(); // el segundo vuelve sin hacer nada mientras el primero sigue
    assert.equal(bus.execute.mock.callCount(), 1);
    assert.ok(bus.execute.mock.calls[0]!.arguments[0] instanceof FireDueMonitorsCommand);
    release({ claimed: 3, started: 1, skipped: 1, failed: 1 });
    await first;
    assert.equal(logged.mock.calls[0]!.arguments[0], "Turno: 3 vencidos · 1 lanzados · 1 saltados · 1 con error");

    await tick(); // libre otra vez; sin nada reclamado no anota
    assert.equal(bus.execute.mock.callCount(), 2);
    assert.equal(logged.mock.callCount(), 1);
  });

  test("un turno que falla se anota como aviso y el siguiente vuelve a intentarlo", async () => {
    const warned = mock.method(Logger.prototype, "warn", () => {});
    const failures: unknown[] = [new Error("db caída"), "texto suelto"];
    const { bus, tick } = scheduler("60", async () => {
      throw failures.shift();
    });
    await tick();
    await tick();
    assert.equal(bus.execute.mock.callCount(), 2);
    assert.match(String(warned.mock.calls[0]!.arguments[0]), /falló y se reintentará: db caída/);
    assert.match(String(warned.mock.calls[1]!.arguments[0]), /falló y se reintentará: texto suelto/);
  });
});
