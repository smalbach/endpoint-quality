/**
 * Un formulario de Postman en un nodo `fetch`, desde el import hasta los bytes que salen.
 *
 * El fallo: el import escribía el formulario con `URLSearchParams`, que codifica las llaves, y el
 * nodo guardaba `token=%7B%7Btoken%7D%7D`. Ninguna interpolación casa con eso, así que la corrida lo
 * paraba por «Faltan variables» con la variable definida. Lo que decide algo:
 *
 * - **Las `{{variables}}` se guardan intactas**, y el resto del texto codificado.
 * - **Lo que vale una variable se codifica al enviar**: una contraseña con `&` sigue siendo un campo.
 * - **Una variable sin valor se sigue diciendo**, y no se manda.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import type { StepFetch } from "@eq/runner-core";

import { fetchCallFrom } from "@/modules/workflows/domain/postman-flows";
import type { PostmanItem } from "@/modules/workflows/domain/import-requests";
import { CaseExecutor, type ExecutionTarget } from "@/modules/runs/infrastructure/case-executor";
import type { SafeFetchPort, SafeRequestOptions } from "@/shared/http/safe-fetch";
import type { SecretCipherPort } from "@/shared/crypto/secret-cipher";

const item = (fields: Record<string, string>): PostmanItem =>
  ({
    trail: [],
    name: "Entrar",
    label: "Entrar",
    request: {
      name: "Entrar",
      method: "POST",
      url: "https://api.ejemplo.test/login",
      headers: {},
      body: { type: "x-www-form-urlencoded", fields, disabledFields: {} },
      auth: { type: "inherit", params: {} },
      examples: [],
    },
    prerequest: "",
    test: "",
  }) as unknown as PostmanItem;

function importedCall(fields: Record<string, string>): StepFetch {
  const call = fetchCallFrom(item(fields), null);
  assert.ok(typeof call !== "string", String(call));
  return call.fetch;
}

async function send(call: StepFetch, variables: Record<string, string>) {
  const sent: SafeRequestOptions[] = [];
  const http: SafeFetchPort = {
    get: async () => {
      throw new Error("no se usa");
    },
    request: async (_url, options) => {
      sent.push(options);
      return { status: 200, headers: { "content-type": "application/json" }, setCookie: [], body: "{}" } as never;
    },
  };
  const executor = new CaseExecutor(http, {} as SecretCipherPort);
  const target = {
    baseUrl: "https://api.ejemplo.test",
    writesAllowed: true,
    spec: null,
    specError: null,
    credentials: [],
    variables,
    session: null,
    cookies: [],
  } as ExecutionTarget;
  const executed = await executor.fetch({ call, target });
  return { executed, sent };
}

describe("un formulario importado en un nodo fetch", () => {
  test("las {{variables}} se guardan intactas, y el texto alrededor codificado", () => {
    const call = importedCall({ usuario: "{{user}}", clave: "{{pass}}", "nota libre": "a&b c" });
    assert.equal(call.body, "usuario={{user}}&clave={{pass}}&nota+libre=a%26b+c");
    assert.equal(call.headers?.["Content-Type"], "application/x-www-form-urlencoded");
  });

  test("al enviar, lo que vale cada variable va codificado dentro de su campo", async () => {
    const call = importedCall({ usuario: "{{user}}", clave: "{{pass}}", fijo: "x" });
    const { executed, sent } = await send(call, { user: "ana maría", pass: "p&ss=1" });
    assert.equal(executed.ok, true, JSON.stringify(executed));
    assert.equal(sent.length, 1);
    const fields = Object.fromEntries(new URLSearchParams(String(sent[0].body)));
    assert.deepEqual(fields, { usuario: "ana maría", clave: "p&ss=1", fijo: "x" });
  });

  test("una variable sin valor no sale, y se dice cuál", async () => {
    const call = importedCall({ usuario: "{{user}}", clave: "{{pass}}" });
    const { executed, sent } = await send(call, { user: "ana" });
    assert.equal(sent.length, 0);
    assert.equal(executed.ok, false);
    assert.match(JSON.stringify(executed), /Faltan variables: pass/);
  });
});
