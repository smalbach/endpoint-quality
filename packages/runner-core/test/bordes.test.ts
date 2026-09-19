/**
 * Los bordes de las piezas pequeñas: el valor que falta, el que sobra y el que llega por el otro
 * camino. Cada uno es un caso que alguna vez se va a dar con datos de verdad.
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { matchesBudgetRule } from "../src/budgets.ts";
import { defineProjectConfig, parametersFor, type BudgetRule, type EnvelopeRule } from "../src/config.ts";
import { applyFrame, blankConversation, redactHeaders, type ChannelLimits } from "../src/conversation.ts";
import { matchesEnvelopeRule } from "../src/envelope.ts";
import { orderOperations } from "../src/execution-plan.ts";
import { graphqlAssertion, graphqlErrors, graphqlVariablesProblem } from "../src/graphql.ts";
import { MAX_TOPIC_BYTES, publishTopicProblem, topicMatches } from "../src/mqtt-topic.ts";
import { redactSecrets } from "../src/notify.ts";
import { formTemplate, interpolateFormBody } from "../src/request-body.ts";
import { requestPathFor } from "../src/request-path.ts";
import { subflowProblems, subflowSteps, type SubflowTarget } from "../src/subflows.ts";
import { interpolate } from "../src/text.ts";
import { roleOf, type Operation } from "../src/types.ts";
import { interpolateValue } from "../src/variables.ts";
import type { WorkflowDocument } from "../src/workflows.ts";

const operation = (id: string, method: Operation["method"], path: string): Operation =>
  ({ id, method, path, summary: id, tag: "T", statuses: [200], parameters: [] }) as Operation;

describe("reglas por camino", () => {
  test("un presupuesto por prefijo solo casa con los caminos que empiezan así", () => {
    const rule = { id: "v1", pathPrefix: "/v1/", thresholdMs: 70, label: "v1", source: "RFP" } as BudgetRule;
    assert.equal(matchesBudgetRule(rule, "GET", "/v1/widgets", "/v1/widgets"), true);
    assert.equal(matchesBudgetRule(rule, "GET", "/v2/widgets", "/v2/widgets"), false);
  });

  test("un sobre por sufijo solo casa con los caminos que acaban así", () => {
    const rule: EnvelopeRule = { id: "lista", match: { pathSuffix: "/items" }, shape: "list" };
    assert.equal(matchesEnvelopeRule(operation("listItems", "GET", "/v1/items"), rule), true);
    assert.equal(matchesEnvelopeRule(operation("getItem", "GET", "/v1/items/{id}"), rule), false);
  });
});

describe("parámetros de una operación", () => {
  test("las muestras: las del endpoint, si no las del proyecto, si no las de reserva", () => {
    const config = defineProjectConfig({
      parameterSamples: { limit: ["10"], cursor: ["abc"] },
      fallbackSamples: ["x"],
      operationParameters: { listItems: { parameterSamples: { limit: ["5"] } }, getItem: { missingIdValue: "0" } },
    });
    const list = parametersFor(config, "listItems");
    assert.deepEqual(list.samples("limit"), ["5"]);
    assert.deepEqual(list.samples("cursor"), ["abc"]);
    assert.deepEqual(list.samples("otro"), ["x"]);
    // Un endpoint con ajustes pero sin muestras propias usa las del proyecto.
    assert.deepEqual(parametersFor(config, "getItem").samples("limit"), ["10"]);
  });

  test("el camino usa los valores por defecto del propio endpoint además de los del proyecto", () => {
    const config = defineProjectConfig({
      pathDefaults: { tenant: "acme" },
      operationParameters: { getItem: { pathDefaults: { itemId: "42" } } },
    });
    const get = operation("getItem", "GET", "/t/{tenant}/items/{itemId}");
    assert.equal(requestPathFor(get, config), "/t/acme/items/42");
    assert.equal(requestPathFor(get, config, { itemId: "7" }), "/t/acme/items/7");
  });
});

describe("orden de ejecución", () => {
  test("el orden seguro pone las lecturas primero y respeta el contrato entre iguales", () => {
    const list = [
      operation("borrar", "DELETE", "/x/{id}"),
      operation("leerB", "GET", "/b"),
      operation("crear", "POST", "/x"),
      operation("leerA", "GET", "/a"),
    ];
    assert.deepEqual(
      orderOperations(list as never, "safe", []).map((item) => item.id),
      ["leerB", "leerA", "crear", "borrar"],
    );
  });
});

describe("redacción", () => {
  test("una cabecera secreta se tapa entera, pero vacía se deja vacía; sin secretos, las demás quedan igual", () => {
    assert.deepEqual(
      redactHeaders({ authorization: "Bearer abc", cookie: "", "x-id": "7" }, { secretHeader: /^(authorization|cookie)$/i }),
      { authorization: "••••••••", cookie: "", "x-id": "7" },
    );
  });

  test("una trama sin cuerpo se guarda como un mensaje vacío", () => {
    const limits: ChannelLimits = { maxMessages: 10, maxBytes: 1000, maxMessageBytes: 100, maxDurationMs: 1000, idleMs: 1000 };
    const { conversation } = applyFrame(blankConversation(), { direction: "in", atMs: 1 }, limits);
    assert.equal(conversation.messages[0].body, "");
    assert.equal(conversation.messages[0].bytes, 0);
  });

  test("las propiedades de usuario pasan por la regla por forma además de por los secretos", () => {
    const limits: ChannelLimits = { maxMessages: 10, maxBytes: 1000, maxMessageBytes: 100, maxDurationMs: 1000, idleMs: 1000 };
    const { conversation } = applyFrame(
      blankConversation(),
      {
        direction: "in",
        atMs: 1,
        body: "{}",
        properties: { userProperties: [["trace", "jwt.aaa.bbb"]], correlationData: "jwt.ccc.ddd" },
      },
      limits,
      { redact: (text) => text.replace(/jwt\.\S+/g, "[jwt]") },
    );
    assert.deepEqual(conversation.messages[0].properties, {
      userProperties: [["trace", "[jwt]"]],
      correlationData: "[jwt]",
      correlationEncoding: "text",
    });
    // Sin regla por forma solo se tapan los secretos conocidos.
    const plain = applyFrame(
      blankConversation(),
      { direction: "in", atMs: 1, body: "{}", properties: { userProperties: [["trace", "jwt.aaa s3cr3t"]] } },
      limits,
      { secrets: ["s3cr3t"] },
    );
    assert.deepEqual(plain.conversation.messages[0].properties, { userProperties: [["trace", "jwt.aaa ••••••••"]] });
  });

  test("en una notificación, el secreto largo se tapa antes que el corto que contiene", () => {
    assert.equal(redactSecrets("token=abcd1234 y abcd", ["abcd", "abcd1234", "ab"]), "token=•••••••• y ••••••••");
  });
});

describe("GraphQL", () => {
  test("una barra invertida al final de un texto no rompe la comprobación de las variables", () => {
    assert.equal(graphqlVariablesProblem('{"a": "x\\'), "las variables de GraphQL no son JSON válido");
    assert.equal(graphqlVariablesProblem('{"a": "x\\"{{v}}"}'), null);
  });

  test("un error sin mensaje se enseña como su JSON", () => {
    assert.deepEqual(graphqlErrors({ errors: [{ code: 7 }, "texto", null] }).messages, ['{"code":7}', '"texto"', "null"]);
  });

  test("un error se cuenta en singular y los mensajes largos se cortan", () => {
    const long = "x".repeat(250);
    const one = graphqlAssertion({ errors: [{ message: long }] });
    assert.equal(one.pass, false);
    assert.equal(one.detail, `1 error: ${"x".repeat(200)}…`);
    const two = graphqlAssertion({ errors: [{ message: "a" }, { message: "b" }] }, true);
    assert.deepEqual(two, { label: "Errores GraphQL", pass: true, detail: "2 errores permitidos: a · b" });
  });
});

describe("MQTT", () => {
  test("un filtro más largo que el tema no casa si no acaba en #", () => {
    assert.equal(topicMatches("casa/salon/luz", "casa/salon"), false);
    assert.equal(topicMatches("casa/salon/#", "casa/salon"), true);
  });

  test("un tema de más de 64 KB se rechaza al publicar", () => {
    assert.equal(publishTopicProblem("a".repeat(MAX_TOPIC_BYTES)), null);
    assert.equal(publishTopicProblem("a".repeat(MAX_TOPIC_BYTES + 1)), `Como mucho ${MAX_TOPIC_BYTES} bytes`);
    // Los bytes, no los caracteres: una ñ ocupa dos.
    assert.equal(publishTopicProblem("ñ".repeat(Math.ceil(MAX_TOPIC_BYTES / 2))), `Como mucho ${MAX_TOPIC_BYTES} bytes`);
  });
});

describe("formularios", () => {
  test("unas llaves sin cerrar son texto, y se codifican como texto", () => {
    assert.equal(formTemplate({ nota: "a {{b" }), "nota=a+%7B%7Bb");
    assert.equal(interpolateFormBody("nota={{sin cerrar", () => "nunca"), "nota={{sin cerrar");
    assert.equal(interpolateFormBody("n={{a}}&m=}}{{", (span) => (span === "{{a}}" ? "1 2" : span)), "n=1+2&m=}}{{");
  });
});

describe("sub-flujos", () => {
  const doc = (...ids: string[]): WorkflowDocument => ({
    steps: ids.map((workflowId, index) => ({ id: `s${index}`, kind: "subflow", subflow: { workflowId } })),
  });

  test("un nodo sub-flujo sin su bloque no cuenta como sub-flujo", () => {
    assert.deepEqual(subflowSteps({ steps: [{ id: "s", kind: "subflow" }] } as WorkflowDocument), []);
  });

  test("el mismo problema alcanzado por dos caminos se informa una vez", () => {
    const flows: Record<string, SubflowTarget> = { hijo: { id: "hijo", name: "Hijo", definition: doc("nieto", "nieto") } };
    const problems = subflowProblems({ id: "raiz", definition: doc("hijo") }, (id) => flows[id]);
    assert.deepEqual(problems, [{ stepIndex: 0, stepId: "s0", detail: "el flujo nieto no existe en este proyecto" }]);
  });
});

describe("textos y variables", () => {
  test("una clave que falta deja la plantilla a la vista", () => {
    assert.equal(interpolate("{{a}} y {{b}}", { a: 1 }), "1 y {{b}}");
  });

  test("el rol de una credencial, o null si no es un rol o no hay credencial", () => {
    assert.equal(roleOf("role:vendedor"), "vendedor");
    assert.equal(roleOf("none"), null);
    assert.equal(roleOf(undefined), null);
  });

  test("las listas se interpolan elemento a elemento y lo que no es texto se deja igual", () => {
    assert.deepEqual(interpolateValue(["{{a}}", 3, true, null, ["{{a}}"]], { a: "x" }), ["x", 3, true, null, ["x"]]);
    assert.equal(interpolateValue(7, {}), 7);
  });
});
