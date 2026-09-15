import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { notifyPayload, notifyUrlProblem, redactSecrets } from "../src/notify.ts";
import { safeParseWorkflowDocument } from "../src/workflow-schema.ts";

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const req = (id: string, extra: Record<string, unknown> = {}) => ({ id, requestTemplateId: uuid(1), ...extra });
const parse = (steps: unknown[]) => safeParseWorkflowDocument({ steps }).ok;

describe("nodo notificar", () => {
  const notify = (block: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) => ({
    id: "aviso",
    kind: "notify",
    dependsOn: ["crear"],
    notify: { channel: "slack", urlVariable: "SLACK_WEBHOOK", message: "pedido creado: {{orderId}}", ...block },
    ...extra,
  });

  test("el documento guarda el nombre de la variable, nunca la URL", () => {
    assert.equal(parse([req("crear"), notify()]), true);
    assert.equal(parse([req("crear"), notify({ channel: "teams", onError: "fail" })]), true);
    assert.equal(parse([req("crear"), notify({ channel: "webhook", urlVariable: "env.HOOK_URL", onError: "continue" })]), true);
    // Un nodo suelto, sin dependencias, también vale: avisar al empezar.
    assert.equal(parse([notify({}, { dependsOn: undefined })]), true);

    assert.equal(parse([req("crear"), notify({ urlVariable: "https://hooks.slack.com/services/T/B/x" })]), false);
    assert.equal(parse([req("crear"), notify({ urlVariable: "" })]), false);
    assert.equal(parse([req("crear"), notify({ message: "   " })]), false);
    assert.equal(parse([req("crear"), notify({ channel: "email" })]), false);
    assert.equal(parse([req("crear"), notify({ onError: "stop" })]), false);
    assert.equal(parse([req("crear"), { id: "aviso", kind: "notify", dependsOn: ["crear"] }]), false);
    assert.equal(parse([req("crear", { notify: { channel: "slack", urlVariable: "X", message: "hola" } })]), false);
  });

  test("cada canal recibe su forma de payload", () => {
    const origin = { runId: "r1", workflowId: "w1", stepId: "aviso" };
    assert.deepEqual(notifyPayload("slack", "hola", origin), { text: "hola" });
    assert.deepEqual(notifyPayload("teams", "hola", origin), {
      "@type": "MessageCard",
      "@context": "https://schema.org/extensions",
      text: "hola",
    });
    assert.deepEqual(notifyPayload("webhook", "hola", origin), { text: "hola", runId: "r1", workflowId: "w1", stepId: "aviso" });
  });

  test("la URL tiene que existir y ser http(s)", () => {
    assert.match(notifyUrlProblem("HOOK", undefined) ?? "", /«HOOK» no está definida/);
    assert.match(notifyUrlProblem("HOOK", "  ") ?? "", /no está definida/);
    assert.match(notifyUrlProblem("HOOK", "no es url") ?? "", /URL válida/);
    assert.match(notifyUrlProblem("HOOK", "ftp://x.test/a") ?? "", /http\(s\)/);
    assert.equal(notifyUrlProblem("HOOK", "https://hooks.slack.com/services/T/B/x"), null);
  });

  test("redacta secretos, el más largo primero, y deja en paz los cortos", () => {
    const url = "https://hooks.example.com/abc";
    assert.equal(redactSecrets(`falló ${url}/ y ${url}`, [url, "abc", "x"]), "falló ••••••••/ y ••••••••");
    assert.equal(redactSecrets("id 1 ok", ["1"]), "id 1 ok");
  });
});
