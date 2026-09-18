/**
 * Descifrar HTTPS en el proxy de captura, de punta a punta y contra servidores de verdad.
 *
 * El destino es un servidor HTTPS con el certificado de `test/fixtures/tls` (para `localhost`,
 * firmado por la CA de prueba). El dispositivo es un cliente TLS que **solo** confía en la CA de
 * captura: si recibe la respuesta, es que el proxy le contestó con un certificado de esa CA.
 *
 * Lo que fijan: que lo de dentro del túnel se graba tapado igual que lo de HTTP y se puede importar;
 * que el proxy sigue validando el certificado del servidor de verdad (sin la CA de prueba entre las
 * de confianza, un 502 con el motivo); que un dispositivo que no acepta la CA deja el túnel grabado
 * con el motivo; que la clave de la CA solo existe cifrada en la fila; y que sin cifrado válido no
 * se genera nada y se dice por qué.
 */
import { after, afterEach, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { lookup } from "node:dns/promises";
import { existsSync, readFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { createServer as createHttpsServer, type Server as HttpsServer } from "node:https";
import { connect as netConnect, type AddressInfo, type Socket } from "node:net";
import { resolve } from "node:path";
import { connect as tlsConnect, getCACertificates, setDefaultCACertificates, type TLSSocket } from "node:tls";

import { CaptureAuthority } from "@/modules/captures/infrastructure/capture-authority";
import { CaptureProxyService } from "@/modules/captures/infrastructure/capture-proxy.service";
import { unimportable, type CaptureSession } from "@/modules/captures/domain/model";
import { SystemClock } from "@/shared/clock/clock.port";
import { loadEnv, type Env } from "@/shared/config/env";
import { generateOpaqueToken, hashOpaqueToken } from "@/shared/crypto/opaque-token";
import { AesGcmSecretCipher } from "@/shared/crypto/secret-cipher";
import { SecretCipherProvider } from "@/shared/crypto/secret-cipher.provider";
import { InMemoryCaptureAuthorityRepository, InMemoryCaptureRepository } from "../support/in-memory-captures";
import { TEST_ENV } from "../support/test-app";

function fixture(name: string): string {
  let directory = __dirname;
  while (!existsSync(resolve(directory, "test/fixtures/tls", name))) directory = resolve(directory, "..");
  return readFileSync(resolve(directory, "test/fixtures/tls", name), "utf8");
}

const defaults = getCACertificates("default");
const env = loadEnv({ ...TEST_ENV, ALLOW_PRIVATE_TARGETS: "true", CAPTURE_MITM: "true" });
const cipher = new AesGcmSecretCipher(Buffer.alloc(32, 5).toString("base64"));

let upstream: HttpsServer;
let upstreamPort: number;
let service: CaptureProxyService | null = null;

before(async () => {
  upstream = createHttpsServer({ cert: fixture("localhost.pem"), key: fixture("localhost.key") }, (req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/json", "set-cookie": "sid=COOKIE-DE-RESPUESTA; Secure" });
      res.end(JSON.stringify({ path: req.url, host: req.headers.host, access_token: "TOKEN-DE-RESPUESTA" }));
    });
  });
  // Donde resuelve `localhost`, que es donde va a conectar la guarda.
  const { address } = await lookup("localhost");
  await new Promise<void>((done) => upstream.listen(0, address, done));
  upstreamPort = (upstream.address() as AddressInfo).port;
});

after(async () => {
  setDefaultCACertificates(defaults);
  upstream.closeAllConnections();
  await new Promise((done) => upstream.close(done));
});

afterEach(async () => {
  setDefaultCACertificates(defaults);
  await service?.onModuleDestroy();
  service = null;
});

type Harness = {
  service: CaptureProxyService;
  captures: InMemoryCaptureRepository;
  authorities: InMemoryCaptureAuthorityRepository;
  authority: CaptureAuthority;
  session: CaptureSession;
  token: string;
  port: number;
  caPem: string;
};

async function harness(): Promise<Harness> {
  const captures = new InMemoryCaptureRepository();
  const authorities = new InMemoryCaptureAuthorityRepository();
  const authority = new CaptureAuthority(env, cipher, authorities);
  // El destino escucha en un puerto cualquiera: se añade a los de túnel permitidos. Y un plazo corto,
  // que es lo que tarda en grabarse un apretón de manos que el dispositivo deja a medias.
  const proxyEnv = { ...env, CAPTURE_CONNECT_PORTS: [443, upstreamPort], REQUEST_TIMEOUT_MS: 1_500 };
  service = new CaptureProxyService(proxyEnv, captures, new SystemClock(), authority);
  const token = generateOpaqueToken();
  const now = new Date();
  const session: CaptureSession = {
    id: randomUUID(),
    projectId: randomUUID(),
    status: "active",
    tokenHash: hashOpaqueToken(token),
    limits: { durationMs: 60_000, maxRequests: 50, maxBodyBytes: 4_096 },
    itemCount: 0,
    startedAt: now,
    expiresAt: new Date(now.getTime() + 60_000),
    stoppedAt: null,
    stopReason: null,
    startedBy: randomUUID(),
    decryptHttps: true,
  };
  await captures.saveSession(session);
  const port = await service.open(session);
  const caPem = (await authority.view()).pem;
  return { service, captures, authorities, authority, session, token, port, caPem };
}

/** Abre un túnel por el proxy y devuelve el socket crudo, ya con el `200` leído. */
function tunnel(port: number, authority: string, token: string): Promise<Socket> {
  return new Promise((done, fail) => {
    const socket = netConnect({ host: "127.0.0.1", port }, () => {
      const credential = Buffer.from(`captura:${token}`).toString("base64");
      socket.write(
        `CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\nProxy-Authorization: Basic ${credential}\r\n\r\n`,
      );
    });
    let data = "";
    const onData = (chunk: Buffer) => {
      data += chunk.toString("latin1");
      if (!data.includes("\r\n\r\n")) return;
      socket.off("data", onData);
      if (data.startsWith("HTTP/1.1 200")) done(socket);
      else fail(new Error(data.split("\r\n")[0]));
    };
    socket.on("data", onData);
    socket.on("error", fail);
  });
}

/** Una petición HTTPS por el túnel, confiando **solo** en `ca`. */
async function viaTunnel(
  h: Harness,
  path: string,
  options: { ca?: string; headers?: Record<string, string> } = {},
): Promise<{ status: number; body: string }> {
  const raw = await tunnel(h.port, `localhost:${upstreamPort}`, h.token);
  const secure: TLSSocket = await new Promise((done, fail) => {
    const socket = tlsConnect({ socket: raw, servername: "localhost", ca: options.ca ?? h.caPem }, () => done(socket));
    // Un dispositivo que no se fía del certificado cuelga la conexión, como hace un navegador.
    socket.on("error", (error) => {
      raw.destroy();
      fail(error);
    });
  });
  return new Promise((done, fail) => {
    const req = httpRequest(
      {
        createConnection: () => secure,
        host: "localhost",
        port: upstreamPort,
        path,
        headers: { Host: `localhost:${upstreamPort}`, ...options.headers },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          secure.destroy();
          done({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") });
        });
      },
    );
    req.on("error", fail);
    req.end();
  });
}

describe("descifrar HTTPS", () => {
  test("lo de dentro del túnel se reenvía, se graba tapado y se puede importar", async () => {
    // El proxy confía en la CA de prueba, que es la que firma el certificado del destino.
    setDefaultCACertificates([...defaults, fixture("ca.pem")]);
    const h = await harness();
    const answer = await viaTunnel(h, "/v1/pedidos?api_key=CLAVE-EN-LA-QUERY", {
      headers: { Authorization: "Bearer TOKEN-DEL-DISPOSITIVO", Cookie: "sid=COOKIE-DEL-DISPOSITIVO" },
    });
    assert.equal(answer.status, 200);
    const echoed = JSON.parse(answer.body);
    assert.equal(echoed.path, "/v1/pedidos?api_key=CLAVE-EN-LA-QUERY");

    const items = [...h.captures.items.values()];
    assert.equal(items.length, 1);
    const [item] = items;
    assert.equal(item.encrypted, false);
    assert.equal(item.method, "GET");
    assert.equal(item.status, 200);
    assert.match(item.url, new RegExp(`^https://localhost:${upstreamPort}/v1/pedidos\\?api_key=`));
    assert.equal(item.requestHeaders.Authorization, "Bearer ••••••••");
    assert.equal(unimportable(item), null);
    const stored = JSON.stringify(items);
    for (const secret of [
      "TOKEN-DEL-DISPOSITIVO",
      "COOKIE-DEL-DISPOSITIVO",
      "CLAVE-EN-LA-QUERY",
      "COOKIE-DE-RESPUESTA",
      "TOKEN-DE-RESPUESTA",
      h.token,
    ]) {
      assert.ok(!stored.includes(secret), `${secret} no debería guardarse`);
    }
  });

  test("el proxy sigue validando el certificado del servidor de verdad", async () => {
    // Sin la CA de prueba entre las de confianza, el certificado del destino no vale.
    const h = await harness();
    const answer = await viaTunnel(h, "/x");
    assert.equal(answer.status, 502);
    const [item] = [...h.captures.items.values()];
    assert.match(item.error ?? "", /certificate|self.signed|issuer/i);
  });

  test("un dispositivo que no acepta la CA de captura deja el túnel grabado con el motivo", async () => {
    setDefaultCACertificates([...defaults, fixture("ca.pem")]);
    const h = await harness();
    // Como una app que fija su certificado: solo confía en la CA del servidor de verdad.
    await assert.rejects(viaTunnel(h, "/x", { ca: fixture("ca.pem") }));
    let item = [...h.captures.items.values()][0];
    for (let wait = 0; !item && wait < 60; wait += 1) {
      await new Promise((done) => setTimeout(done, 50));
      item = [...h.captures.items.values()][0];
    }
    assert.ok(item, "el túnel fallido se graba");
    assert.equal(item.method, "CONNECT");
    assert.equal(item.encrypted, true);
    assert.match(item.error ?? "", /CA de captura/);
  });

  test("la clave de la CA solo está cifrada en la fila, y lo que se descarga es solo el certificado", async () => {
    const h = await harness();
    const row = h.authorities.row!;
    assert.ok(row.privateKeyCiphertext.startsWith("v1."));
    assert.ok(!JSON.stringify(row).includes("PRIVATE KEY"), "ni rastro de un PEM de clave privada");
    assert.match(cipher.decrypt(row.privateKeyCiphertext), /BEGIN PRIVATE KEY/);
    const view = await h.authority.view();
    assert.match(view.pem, /BEGIN CERTIFICATE/);
    assert.ok(!JSON.stringify(view).includes("PRIVATE KEY"));
    assert.match(view.fingerprint, /^([0-9A-F]{2}:){31}[0-9A-F]{2}$/);
    // Otra instancia con la misma tabla usa la misma CA, no genera otra.
    const other = new CaptureAuthority(env, cipher, h.authorities);
    assert.equal((await other.view()).pem, view.pem);
  });

  test("sin un cifrado válido no se genera nada y se dice por qué", async () => {
    for (const key of [undefined, Buffer.alloc(8).toString("base64")]) {
      const withoutKey = { ...env, SECRETS_KEY: key } as Env;
      const authorities = new InMemoryCaptureAuthorityRepository();
      const authority = new CaptureAuthority(withoutKey, new SecretCipherProvider(withoutKey), authorities);
      await assert.rejects(authority.ensure(), /no puede arrancar.*SECRETS_KEY/s);
      assert.equal(authorities.row, null, "no se guarda nada, ni cifrado ni en claro");
      const status = await authority.status();
      assert.equal(status?.ready, false);
      assert.match(status?.problem ?? "", /SECRETS_KEY/);
    }
  });

  test("una clave guardada que no se descifra con la SECRETS_KEY actual no se sustituye en silencio", async () => {
    const h = await harness();
    const before = h.authorities.row!.certificatePem;
    const otherCipher = new AesGcmSecretCipher(Buffer.alloc(32, 6).toString("base64"));
    const authority = new CaptureAuthority(env, otherCipher, h.authorities);
    await assert.rejects(authority.ensure(), /no se puede descifrar/);
    assert.equal(h.authorities.row!.certificatePem, before);
  });

  test("con CAPTURE_MITM apagado no hay CA ni descifrado", async () => {
    const off = loadEnv({ ...TEST_ENV });
    const authority = new CaptureAuthority(off, cipher, new InMemoryCaptureAuthorityRepository());
    assert.equal(await authority.status(), null);
    await assert.rejects(authority.ensure(), /CAPTURE_MITM/);
  });
});
