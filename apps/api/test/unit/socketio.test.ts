/**
 * Socket.IO sin la API: lo que se guarda de la carga de `auth`, cómo viajan los argumentos, el plan
 * con sus secretos, y la guarda de red con bytes de verdad —el agente fijado a la IP comprobada y el
 * sondeo que no sigue una redirección ni lee sin tope—.
 */
import { createServer, request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_SOCKETIO,
  argsBody,
  emitValues,
  socketIoSessionPlan,
  storableAuthPayload,
} from "@/modules/channels/domain/socketio";
import { openSafeSocketIo, pinnedAgent } from "@/shared/http/safe-socketio";

const POLICY = { allowPrivateTargets: true, maxRedirects: 0, timeoutMs: 2_000, maxResponseBytes: 1024 * 1024 };
const OPTIONS = {
  path: "/socket.io",
  namespace: "/",
  auth: null,
  query: {},
  headers: {},
  transports: ["polling" as const],
  maxPayload: 1024,
  connectTimeoutMs: 1_000,
};

describe("la carga de auth, al guardar", () => {
  test("vacía los literales de credencial a cualquier profundidad y deja las variables", () => {
    const stored = JSON.parse(
      storableAuthPayload(
        '{"token":"abc123secreto","sala":"general","user":{"password":"otra","id":7},"jwt":"{{jwt}}","authorization":"Bearer {{t}}"}',
      ),
    );
    assert.deepEqual(stored, {
      token: "",
      sala: "general",
      user: { password: "", id: 7 },
      jwt: "{{jwt}}",
      authorization: "Bearer {{t}}",
    });
  });

  test("sin nada que vaciar, el texto tal cual; sin ser JSON aún, vacía por expresión", () => {
    const pretty = '{\n  "sala": "general"\n}';
    assert.equal(storableAuthPayload(pretty), pretty);
    assert.equal(storableAuthPayload('{"token":"literal-xyz","n":{{numero}}}'), '{"token":"","n":{{numero}}}');
  });
});

describe("los argumentos de un evento", () => {
  test("objetos y listas viajan como JSON; lo demás, como texto", () => {
    assert.deepEqual(emitValues(['{"a":1}', "[1,2]", "42", "hola", "{roto"]), [
      { a: 1 },
      [1, 2],
      "42",
      "hola",
      "{roto",
    ]);
  });

  test("en la transcripción: nada, uno tal cual, varios en lista, y los bytes en hexadecimal", () => {
    assert.equal(argsBody([]), "");
    assert.equal(argsBody(["hola"]), "hola");
    assert.equal(argsBody([{ a: 1 }]), '{"a":1}');
    assert.equal(argsBody([{ a: 1 }, "x"]), '[{"a":1},"x"]');
    assert.equal(argsBody([Buffer.from("ab")]), '{"$binary":"6162","bytes":2}');
  });
});

describe("el plan de una sesión", () => {
  test("resuelve la carga y mete cada valor en los secretos; la ruta de la URL es el espacio", () => {
    const secrets: string[] = [];
    const { plan, problems } = socketIoSessionPlan(
      {
        ...DEFAULT_SOCKETIO,
        auth: '{"token":"{{token}}","perfil":{"clave":"k-9876"}}',
        query: [
          { name: "api_key", value: "{{token}}", enabled: true },
          { name: "sala", value: "general", enabled: true },
          { name: "apagado", value: "x", enabled: false },
        ],
      },
      "https://chat.example.test/tienda",
      (value) => value.replace("{{token}}", "tk-plan-1234"),
      secrets,
    );
    assert.deepEqual(problems, []);
    assert.deepEqual(plan.auth, { token: "tk-plan-1234", perfil: { clave: "k-9876" } });
    assert.deepEqual(plan.query, { api_key: "tk-plan-1234", sala: "general" });
    assert.equal(plan.namespace, "/tienda");
    assert.ok(secrets.includes("tk-plan-1234"));
    assert.ok(secrets.includes("k-9876"));
    assert.ok(!secrets.includes("general"), "un valor de la query sin nombre de credencial no es un secreto");
  });

  test("una carga que ya resuelta no es un objeto es un problema con su campo", () => {
    const { problems } = socketIoSessionPlan(
      { ...DEFAULT_SOCKETIO, auth: "{{carga}}" },
      "http://x.test",
      () => "[1]",
      [],
    );
    assert.equal(problems[0]?.field, "socketio.auth");
  });
});

describe("la guarda de red", () => {
  let server: Server;
  let port: number;
  const hosts: string[] = [];

  before(async () => {
    server = createServer((incoming, response) => {
      hosts.push(incoming.headers.host ?? "");
      if (incoming.url?.startsWith("/redirige/"))
        response.writeHead(302, { location: "http://169.254.169.254/latest/meta-data/" }).end();
      else if (incoming.url?.startsWith("/enorme/")) response.writeHead(200).end("x".repeat(64 * 1024));
      else response.writeHead(200).end("ok");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = (server.address() as AddressInfo).port;
  });

  after(() => new Promise<void>((resolve) => server.close(() => resolve())));

  test("el agente conecta a la dirección comprobada, con el nombre en Host", async () => {
    const agent = pinnedAgent("127.0.0.1", false, "nombre.invalid");
    const status = await new Promise<number>((resolve, reject) =>
      request(`http://nombre.invalid:${port}/`, { agent }, (response) => {
        response.resume();
        resolve(response.statusCode ?? 0);
      })
        .on("error", reject)
        .end(),
    );
    assert.equal(status, 200);
    assert.equal(hosts.at(-1), `nombre.invalid:${port}`);
  });

  test("el sondeo no sigue una redirección: la sesión no abre y lo dice", async () => {
    await assert.rejects(
      openSafeSocketIo(`http://127.0.0.1:${port}`, POLICY, { ...OPTIONS, path: "/redirige/" }, () => undefined),
      /redirección no se sigue/,
    );
  });

  test("una respuesta del sondeo mayor que el tope se corta antes de juntarla", async () => {
    await assert.rejects(
      openSafeSocketIo(`http://127.0.0.1:${port}`, POLICY, { ...OPTIONS, path: "/enorme/" }, () => undefined),
      /pasó de 1024 bytes/,
    );
  });

  test("con la guarda de producción, una IP privada no llega a conectar", async () => {
    const before = hosts.length;
    await assert.rejects(
      openSafeSocketIo(`http://127.0.0.1:${port}`, { ...POLICY, allowPrivateTargets: false }, OPTIONS, () => undefined),
      /loopback|privad/i,
    );
    assert.equal(hosts.length, before);
  });
});
