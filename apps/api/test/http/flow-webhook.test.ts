/**
 * The webhook node, end to end: a run that stops until something outside calls a one-time URL.
 *
 * The public route is the part worth distrusting, so most of what is asserted here is about it: the
 * payload arrives and the flow reads it, the token is stored nowhere (not in the step row, not in the
 * hook table), credentials in the call are masked before they are kept, and every way of not being
 * accepted — used, unknown, malformed, other verb, too late, cancelled — is the same 404.
 *
 * With two instances — the run on A, the call landing on B — it is in `multi-instance.test.ts`.
 */
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import request from "supertest";

import { REDACTED_TOKEN } from "@/modules/runs/domain/flow-hooks";
import { MASK } from "@/modules/endpoints/domain/examples";
import { createTestApp, type TestContext } from "../support/test-app";
import { StubTarget, STUB_SPEC_YAML } from "../support/stub-target";

let context: TestContext;
const api = () => request(context.app.getHttpServer());

type Actor = { organizationId: string; token: string };
let owner: Actor;
const as = (actor: Actor) => ({ Authorization: `Bearer ${actor.token}` });

before(async () => {
  context = await createTestApp();
  const email = "flow-webhook@example.com";
  const password = "Una-contraseña-larga-1";
  const registered = await api().post("/auth/register").send({ email, password, name: "hook" });
  const session = await api().post("/auth/login").send({ email, password });
  assert.equal(session.status, 200, JSON.stringify(session.body));
  owner = { organizationId: registered.body.organizationId, token: session.body.accessToken };
});

after(async () => {
  await context?.close();
});

/** A project with a contract and an environment pointed at a stub, and a flow of `steps` in it. */
async function flowWith(steps: Record<string, unknown>[]) {
  const target = new StubTarget({});
  await target.start();
  const project = await api()
    .post(`/orgs/${owner.organizationId}/projects`)
    .set(as(owner))
    .send({ name: `hook-${Math.random().toString(36).slice(2, 8)}` });
  assert.equal(project.status, 201, JSON.stringify(project.body));
  const projectBase = `/orgs/${owner.organizationId}/projects/${project.body.projectId}`;
  const imported = await api()
    .post(`${projectBase}/spec-versions`)
    .set(as(owner))
    .send({ source: { kind: "inline", raw: STUB_SPEC_YAML } });
  assert.equal(imported.status, 201, JSON.stringify(imported.body));
  const environment = await api()
    .post(`${projectBase}/environments`)
    .set(as(owner))
    .send({
      name: "stub",
      baseUrl: target.origin,
      specUrl: `${target.origin}/openapi.json`,
      writesAllowed: true,
      authEnforced: false,
      variables: {},
    });
  assert.equal(environment.status, 201, JSON.stringify(environment.body));
  const workflow = await api()
    .post(`${projectBase}/workflows`)
    .set(as(owner))
    .send({ name: "Con webhook", definition: { steps } });
  assert.equal(workflow.status, 201, JSON.stringify(workflow.body));
  const started = await api()
    .post(`${projectBase}/runs`)
    .set(as(owner))
    .send({ environmentId: environment.body.environmentId, workflowId: workflow.body.workflowId });
  assert.equal(started.status, 202, JSON.stringify(started.body));
  return { target, projectBase, runId: started.body.runId as string };
}

type CaseRow = { id: string; scenarioId: string; status: string; method: string; failure: string | null };
type StepRow = {
  request: { method: string; url: string } | null;
  actual: { status: number; headers: Record<string, string>; body: unknown } | null;
  assertions: { label: string; pass: boolean; detail: string }[];
};

const caseOf = (cases: CaseRow[], stepId: string) => cases.find((item) => item.scenarioId.endsWith(`:${stepId}`))!;

type HookWait = { caseId: string; stepId: string; url: string; method: string; expiresAt: string };

/** The URL a waiting webhook node hands out, read from the run view the way the run page does. */
async function waitingHook(projectBase: string, runId: string, stepId: string, on: TestContext = context) {
  const deadline = Date.now() + 5000;
  for (;;) {
    const run = await request(on.app.getHttpServer()).get(`${projectBase}/runs/${runId}`).set(as(owner));
    const waiting = (run.body.cases as CaseRow[] | undefined)?.find(
      (item) => item.scenarioId.endsWith(`:${stepId}`) && item.status === "running",
    );
    const hook = (run.body.hooks as HookWait[] | undefined)?.find((item) => item.stepId === stepId);
    if (waiting && hook) {
      const match = /\/hooks\/flows\/([A-Za-z0-9_-]{43})$/.exec(hook.url);
      assert.equal(hook.caseId, waiting.id);
      if (match) return { caseId: waiting.id, url: hook.url, token: match[1], method: waiting.method, hook };
    }
    if (Date.now() > deadline)
      throw new Error(`El webhook «${stepId}» no llegó a esperar: ${JSON.stringify(run.body)}`);
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
}

/**
 * A POST to the hook route over a bare socket, for what supertest cannot express: headers that
 * promise a body never sent, or a body that never ends. `send` gets a write function and may return
 * a callback to call on `drain`. Resolves when the connection closes, with whatever answer arrived.
 */
function rawHookCall(
  token: string,
  headers: Record<string, string>,
  send: (write: (chunk: Buffer) => boolean) => (() => void) | void,
): Promise<{ status: number | null; headers: http.IncomingHttpHeaders; body: string; closed: boolean }> {
  const address = context.app.getHttpServer().address() as AddressInfo;
  return new Promise((resolve) => {
    const result = { status: null as number | null, headers: {} as http.IncomingHttpHeaders, body: "", closed: false };
    const outgoing = http.request({
      host: "127.0.0.1",
      port: address.port,
      method: "POST",
      path: `/hooks/flows/${token}`,
      headers,
      agent: false,
    });
    const done = () => {
      result.closed = true;
      resolve(result);
    };
    // A hung connection would hang the suite: give up well before its timeout.
    const guard = setTimeout(() => outgoing.destroy(), 8_000);
    outgoing.on("response", (incoming) => {
      result.status = incoming.statusCode ?? null;
      result.headers = incoming.headers;
      incoming.setEncoding("utf8");
      incoming.on("data", (text: string) => (result.body += text));
      incoming.on("error", () => undefined);
    });
    // EPIPE / ECONNRESET is the expected end for a client still writing when the server hangs up.
    outgoing.on("error", () => undefined);
    outgoing.on("close", () => {
      clearTimeout(guard);
      done();
    });
    outgoing.flushHeaders();
    const onDrain = send((chunk) => !outgoing.destroyed && outgoing.write(chunk));
    if (onDrain) outgoing.on("drain", onDrain);
  });
}

async function finished(projectBase: string, runId: string) {
  await context.queue.idle();
  const run = await api().get(`${projectBase}/runs/${runId}`).set(as(owner));
  return run.body as { status: string; cases: CaseRow[] };
}

async function caseDetail(projectBase: string, runId: string, caseId: string) {
  const detail = await api().get(`${projectBase}/runs/${runId}/cases/${caseId}`).set(as(owner));
  return detail.body as { status: string; failure: string | null; steps: StepRow[] };
}

describe("nodo Esperar webhook", () => {
  test("la llamada entrega su cuerpo: comprobaciones, capturas y los nodos siguientes lo leen", async () => {
    const flow = await flowWith([
      {
        id: "pago",
        kind: "webhook",
        webhook: { timeoutMs: 20_000 },
        checks: [{ source: "body", path: "status", operator: "equals", value: "paid" }],
        captures: [{ variable: "orderId", from: "body", path: "order.id" }],
      },
      {
        id: "leer",
        kind: "validate",
        dependsOn: ["pago"],
        validate: { from: "pago" },
        checks: [{ source: "body", path: "order.id", operator: "equals", value: "A-17" }],
      },
      {
        id: "usar",
        kind: "set",
        dependsOn: ["leer"],
        set: { assignments: [{ variable: "copia", value: "{{orderId}}" }] },
      },
    ]);
    const hook = await waitingHook(flow.projectBase, flow.runId, "pago");
    assert.equal(hook.method, "HOOK");
    // Sin PUBLIC_API_URL, la base es la API en su puerto de localhost.
    assert.ok(hook.url.startsWith(`http://localhost:${context.env.PORT}/hooks/flows/`), hook.url);

    const delivered = await api()
      .post(`/hooks/flows/${hook.token}`)
      .set("Authorization", "Bearer secreto-del-proveedor")
      .set("Cookie", "sid=de-un-navegador")
      .set("X-Forwarded-For", "10.0.0.7")
      .set("X-Event-Id", "evt_1")
      .send({ status: "paid", order: { id: "A-17" }, password: "clave-del-cliente" });
    assert.equal(delivered.status, 202, JSON.stringify(delivered.body));

    const run = await finished(flow.projectBase, flow.runId);
    assert.equal(run.status, "passed", JSON.stringify(run.cases));
    assert.equal(caseOf(run.cases, "pago").status, "passed");
    assert.equal(caseOf(run.cases, "leer").status, "passed", "la validación leyó la respuesta del webhook");
    assert.equal(caseOf(run.cases, "usar").status, "passed", "la captura del webhook quedó en las variables");

    const detail = await caseDetail(flow.projectBase, flow.runId, hook.caseId);
    assert.equal(detail.steps.length, 1, "la fila de espera se reescribe, no se duplica");
    const [step] = detail.steps;
    assert.ok(step.request?.url.endsWith(`/hooks/flows/${REDACTED_TOKEN}`), step.request?.url);
    assert.ok(!JSON.stringify(detail).includes(hook.token), "el token no sobrevive en la fila");
    // Lo que llegó se tapa antes de guardarlo, con las reglas de una captura: el campo con nombre de
    // credencial y las cabeceras de credencial llegan como máscara, la red de delante no llega.
    assert.deepEqual(step.actual?.body, { status: "paid", order: { id: "A-17" }, password: MASK });
    assert.equal(step.actual?.status, 200);
    assert.equal(step.actual?.headers["x-event-id"], "evt_1");
    assert.equal(step.actual?.headers.authorization, MASK);
    assert.equal(step.actual?.headers.cookie, MASK);
    assert.equal(step.actual?.headers["x-forwarded-for"], undefined, "la red de delante no se guarda");
    const stored = JSON.stringify([...context.repositories.flowHooks.rows.values()]);
    for (const secret of [hook.token, "secreto-del-proveedor", "de-un-navegador", "clave-del-cliente"]) {
      assert.ok(!JSON.stringify(detail).includes(secret), `${secret} no está en la fila del paso`);
      assert.ok(!stored.includes(secret), `${secret} no está en la tabla de esperas`);
    }
    // Leída la entrega, la fila de la espera ya no la lleva.
    assert.ok([...context.repositories.flowHooks.rows.values()].every((row) => row.delivery === null));
    const view = await api().get(`${flow.projectBase}/runs/${flow.runId}`).set(as(owner));
    assert.deepEqual(view.body.hooks, [], "una corrida terminada no enseña URL");
    assert.ok(step.assertions.some((assertion) => assertion.label === "Variables capturadas" && assertion.pass));

    // Un solo uso, y ningún rechazo se distingue de otro.
    const reused = await api().post(`/hooks/flows/${hook.token}`).send({ status: "paid" });
    const unknown = await api()
      .post(`/hooks/flows/${"A".repeat(43)}`)
      .send({});
    const malformed = await api().post("/hooks/flows/corto").send({});
    for (const refused of [reused, unknown, malformed]) {
      assert.equal(refused.status, 404);
      // La respuesta no repite la ruta con el token: `instance` lo lleva tapado.
      assert.ok(
        !JSON.stringify(refused.body).includes(hook.token) && !JSON.stringify(refused.body).includes("A".repeat(43)),
      );
      assert.equal(refused.body.type, reused.body.type);
      assert.equal(refused.body.detail, reused.body.detail);
    }
    await flow.target.stop();
  });

  test("con PUT y texto: el otro verbo no la encuentra ni la gasta", async () => {
    const flow = await flowWith([
      {
        id: "aviso",
        kind: "webhook",
        webhook: { timeoutMs: 20_000, method: "PUT" },
        checks: [{ source: "body", operator: "equals", value: "listo" }],
      },
    ]);
    const hook = await waitingHook(flow.projectBase, flow.runId, "aviso");

    const wrongVerb = await api().post(`/hooks/flows/${hook.token}`).set("Content-Type", "text/plain").send("listo");
    assert.equal(wrongVerb.status, 404);
    const delivered = await api().put(`/hooks/flows/${hook.token}`).set("Content-Type", "text/plain").send("listo");
    assert.equal(delivered.status, 202, JSON.stringify(delivered.body));

    const run = await finished(flow.projectBase, flow.runId);
    assert.equal(run.status, "passed", JSON.stringify(run.cases));
    const detail = await caseDetail(flow.projectBase, flow.runId, hook.caseId);
    assert.equal(detail.steps[0].actual?.body, "listo");
    await flow.target.stop();
  });

  test("si nadie llama a tiempo el nodo falla, lo que depende de él no corre y la URL deja de responder", async () => {
    const flow = await flowWith([
      { id: "pago", kind: "webhook", webhook: { timeoutMs: 1_000 } },
      { id: "despues", kind: "set", dependsOn: ["pago"], set: { assignments: [{ variable: "x", value: "1" }] } },
    ]);
    const hook = await waitingHook(flow.projectBase, flow.runId, "pago");

    const run = await finished(flow.projectBase, flow.runId);
    assert.equal(run.status, "failed");
    assert.equal(caseOf(run.cases, "pago").status, "failed");
    assert.equal(caseOf(run.cases, "pago").failure, "network");
    assert.equal(caseOf(run.cases, "despues").status, "skipped");

    const detail = await caseDetail(flow.projectBase, flow.runId, hook.caseId);
    assert.ok(!JSON.stringify(detail).includes(hook.token));
    assert.ok(
      detail.steps[0].assertions.some((assertion) => !assertion.pass && assertion.detail.includes("Nadie llamó")),
    );

    const late = await api().post(`/hooks/flows/${hook.token}`).send({ status: "paid" });
    assert.equal(late.status, 404);
    await flow.target.stop();
  });

  test("cancelar mientras espera termina la corrida sin veredicto sobre el nodo, y la URL muere con ella", async () => {
    const flow = await flowWith([{ id: "pago", kind: "webhook", webhook: { timeoutMs: 20_000 } }]);
    const hook = await waitingHook(flow.projectBase, flow.runId, "pago");

    const cancelled = await api().post(`${flow.projectBase}/runs/${flow.runId}/cancel`).set(as(owner));
    assert.equal(cancelled.status, 204);
    const run = await finished(flow.projectBase, flow.runId);
    assert.equal(run.status, "cancelled");
    assert.equal(caseOf(run.cases, "pago").status, "skipped");

    const detail = await caseDetail(flow.projectBase, flow.runId, hook.caseId);
    assert.ok(!JSON.stringify(detail).includes(hook.token));
    const late = await api().post(`/hooks/flows/${hook.token}`).send({});
    assert.equal(late.status, 404);
    await flow.target.stop();
  });

  test("un Content-Length de más de 1 MB recibe 413 sin enviar el cuerpo, y la conexión se cierra", async () => {
    const token = "B".repeat(43);
    // Only the headers: a client that respects Content-Length reads the answer before sending more.
    const answer = await rawHookCall(
      token,
      { "Content-Type": "text/plain", "Content-Length": String(1_048_577) },
      () => {},
    );
    assert.equal(answer.status, 413);
    assert.equal(answer.headers.connection, "close");
    assert.match(String(answer.headers["content-type"]), /application\/problem\+json/);
    assert.equal(JSON.parse(answer.body).status, 413);
    assert.ok(!answer.body.includes(token), "la respuesta no devuelve el token");
    assert.ok(answer.closed, "el servidor cuelga la conexión");
  });

  test("una subida por trozos que pasa de 1 MB se corta enseguida en vez de drenarse", async () => {
    const token = "C".repeat(43);
    const started = Date.now();
    let sent = 0;
    // A client that would go on forever: 64 KB chunks until the server stops it.
    const answer = await rawHookCall(
      token,
      { "Content-Type": "text/plain", "Transfer-Encoding": "chunked" },
      (write) => {
        const chunk = Buffer.alloc(64 * 1024, 120);
        const pump = () => {
          let more = true;
          while (more) {
            more = write(chunk);
            sent += chunk.length;
          }
        };
        pump();
        return pump;
      },
    );
    assert.ok(Date.now() - started < 5_000, `tardó ${Date.now() - started} ms en cortar`);
    assert.ok(sent > 1_048_576, `el cliente llegó a mandar más del tope antes del corte (${sent} bytes)`);
    assert.ok(answer.closed, "el servidor cuelga la conexión");
    // The 413 may or may not reach a client still writing; if it does, it is the Problem Details.
    if (answer.status !== null) assert.equal(answer.status, 413);
  });

  test("un webhook dentro del cuerpo de un bucle no se puede guardar", async () => {
    const project = await api()
      .post(`/orgs/${owner.organizationId}/projects`)
      .set(as(owner))
      .send({ name: `hook-loop-${Math.random().toString(36).slice(2, 8)}` });
    const projectBase = `/orgs/${owner.organizationId}/projects/${project.body.projectId}`;
    const saved = await api()
      .post(`${projectBase}/workflows`)
      .set(as(owner))
      .send({
        name: "Bucle con webhook",
        definition: {
          steps: [
            { id: "lista", kind: "fetch", fetch: { method: "GET", url: "/things" } },
            { id: "b", kind: "loop", dependsOn: ["lista"], loop: { from: "lista", path: "data", as: "item" } },
            { id: "pago", kind: "webhook", dependsOn: ["b"], inLoop: "b", webhook: { timeoutMs: 5_000 } },
          ],
        },
      });
    assert.equal(saved.status, 422, JSON.stringify(saved.body));
  });
});
