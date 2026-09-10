/**
 * The SSRF guard, checked against the addresses it exists to refuse.
 *
 * These are not hypothetical inputs. `169.254.169.254` answers with the instance's cloud
 * credentials, needs no authentication, and is reachable from any process that can make an
 * outbound request — which is precisely what "importa el contrato desde esta URL" grants.
 *
 * The redirect and rebinding cases run against a real loopback server, because they are about
 * what the HTTP client does rather than what a pure function returns, and a mocked fetch would
 * prove only that the mock behaves.
 */
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { type AddressInfo } from "node:net";

import {
  BlockedTargetError,
  isBlockedAddress,
  resolveTarget,
  safeFetch,
  type SafeFetchPolicy,
} from "@/shared/http/safe-fetch";

const hosted: SafeFetchPolicy = {
  allowPrivateTargets: false,
  maxRedirects: 3,
  timeoutMs: 2_000,
  maxResponseBytes: 1024 * 64,
};
const selfHosted: SafeFetchPolicy = { ...hosted, allowPrivateTargets: true };

describe("rangos bloqueados", () => {
  test("el endpoint de metadatos de la nube", () => {
    // The single most valuable target of an SSRF: no credential needed, and the answer is the
    // instance's own credentials.
    const verdict = isBlockedAddress("169.254.169.254");
    assert.equal(verdict.blocked, true);
    assert.match(verdict.why!, /metadatos/);
  });

  test("loopback, redes privadas y CGNAT", () => {
    for (const address of [
      "127.0.0.1",
      "127.1.2.3",
      "10.0.0.5",
      "172.16.0.1",
      "172.31.255.254",
      "192.168.1.1",
      "100.64.0.1",
      "0.0.0.0",
    ]) {
      assert.equal(isBlockedAddress(address).blocked, true, `${address} debería estar bloqueada`);
    }
  });

  test("las direcciones públicas pasan, incluidas las vecinas de un rango privado", () => {
    // 172.15/172.32 sit either side of 172.16/12: an off-by-one in the mask shows up here.
    for (const address of ["1.1.1.1", "93.184.216.34", "172.15.255.255", "172.32.0.1", "11.0.0.1", "100.63.255.255"]) {
      assert.equal(isBlockedAddress(address).blocked, false, `${address} no debería estar bloqueada`);
    }
  });

  test("IPv6: loopback, link-local y unique-local", () => {
    for (const address of ["::1", "::", "fe80::1", "fc00::1", "fd12:3456::1"]) {
      assert.equal(isBlockedAddress(address).blocked, true, `${address} debería estar bloqueada`);
    }
    assert.equal(isBlockedAddress("2606:4700:4700::1111").blocked, false);
  });

  test("una IPv4 disfrazada de IPv6 no se cuela", () => {
    // `::ffff:169.254.169.254` reaches exactly the same place as the bare address, and a
    // string-based check would wave it through.
    assert.equal(isBlockedAddress("::ffff:169.254.169.254").blocked, true);
    assert.equal(isBlockedAddress("::ffff:127.0.0.1").blocked, true);
    assert.equal(isBlockedAddress("::ffff:1.1.1.1").blocked, false);
  });

  test("algo que no es una dirección se bloquea por defecto", () => {
    assert.equal(isBlockedAddress("no-soy-una-ip").blocked, true);
  });
});

describe("validación del destino", () => {
  test("solo http y https", async () => {
    // `file:` is the other half of SSRF, and an allowlist is the only way to be sure a new
    // scheme cannot appear.
    for (const url of ["file:///etc/passwd", "gopher://x/1", "ftp://x/y", "data:text/plain,hola"]) {
      await assert.rejects(resolveTarget(url, hosted), BlockedTargetError);
    }
  });

  test("una URL con credenciales se rechaza", async () => {
    await assert.rejects(resolveTarget("http://user:pass@1.1.1.1/openapi.json", hosted), /credenciales/);
  });

  test("una URL malformada se rechaza", async () => {
    await assert.rejects(resolveTarget("no-es-una-url", hosted), /no es una URL válida/);
  });

  test("localhost se bloquea en despliegue alojado", async () => {
    await assert.rejects(resolveTarget("http://127.0.0.1:8100/openapi.json", hosted), /loopback/);
  });

  test("y se permite en self-hosted, que es el uso normal en local", async () => {
    // An operator running this on their laptop against their own API is the ordinary case; the
    // flag exists so the hosted default can stay closed without breaking it.
    const resolved = await resolveTarget("http://127.0.0.1:8100/openapi.json", selfHosted);
    assert.equal(resolved.address, "127.0.0.1");
  });

  test("un nombre que resuelve a loopback se bloquea por su IP, no por su texto", async () => {
    // The reason the check is on the resolved address: the hostname is attacker-controlled and
    // can point anywhere.
    await assert.rejects(resolveTarget("http://localhost:8100/openapi.json", hosted), BlockedTargetError);
  });

  test("un nombre que no resuelve se rechaza con un motivo legible", async () => {
    await assert.rejects(resolveTarget("http://no-existe.invalid/openapi.json", hosted), /no se pudo resolver/);
  });
});

describe("contra un servidor real", () => {
  let server: Server;
  let origin: string;

  before(async () => {
    server = createServer((request, response) => {
      const url = new URL(request.url ?? "/", "http://localhost");
      if (url.pathname === "/ok") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ openapi: "3.1.0", host: request.headers.host }));
        return;
      }
      if (url.pathname === "/redirect-to-metadata") {
        // The classic bypass: a URL that passes the check, then sends the client somewhere that
        // would not have.
        response.writeHead(302, { location: "http://169.254.169.254/latest/meta-data/" });
        response.end();
        return;
      }
      if (url.pathname === "/redirect-loop") {
        response.writeHead(302, { location: `${origin}/redirect-loop` });
        response.end();
        return;
      }
      if (url.pathname === "/redirect-chain") {
        const step = Number(url.searchParams.get("step") ?? "0");
        response.writeHead(302, { location: `${origin}/redirect-chain?step=${step + 1}` });
        response.end();
        return;
      }
      if (url.pathname === "/huge") {
        response.writeHead(200, { "content-type": "text/plain" });
        // No `content-length`: the cap has to hold against what actually arrives, not against
        // what the server claims it will send.
        const chunk = "x".repeat(8192);
        for (let index = 0; index < 100; index += 1) response.write(chunk);
        response.end();
        return;
      }
      if (url.pathname === "/slow") {
        setTimeout(() => response.end("tarde"), 5_000).unref();
        return;
      }
      response.writeHead(404).end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  test("una respuesta normal llega entera", async () => {
    const result = await safeFetch(`${origin}/ok`, selfHosted);
    assert.equal(result.status, 200);
    assert.equal(JSON.parse(result.body).openapi, "3.1.0");
  });

  test("la cabecera Host conserva el nombre original aunque se conecte a la IP", async () => {
    // Connecting to the literal address is what closes the DNS rebinding window; keeping `Host`
    // is what stops that from breaking virtual hosting.
    const result = await safeFetch(`${origin}/ok`, selfHosted);
    assert.equal(JSON.parse(result.body).host, origin.replace("http://", ""));
  });

  test("una redirección hacia el endpoint de metadatos se corta en el salto", async () => {
    // The check runs again on hop two, which is the whole reason redirects are followed by hand.
    await assert.rejects(safeFetch(`${origin}/redirect-to-metadata`, selfHosted), /metadatos|169\.254/);
  });

  test("un bucle de redirecciones se detecta", async () => {
    await assert.rejects(safeFetch(`${origin}/redirect-loop`, selfHosted), /bucle de redirecciones/);
  });

  test("una cadena larga se corta en el límite configurado", async () => {
    await assert.rejects(
      safeFetch(`${origin}/redirect-chain`, { ...selfHosted, maxRedirects: 2 }),
      /más de 2 redirecciones/,
    );
  });

  test("una respuesta enorme se corta en el tope de bytes", async () => {
    // A URL that streams forever is a denial of service that needs no private address at all.
    await assert.rejects(safeFetch(`${origin}/huge`, { ...selfHosted, maxResponseBytes: 4096 }), /supera 4096 bytes/);
  });

  test("un servidor que no responde se corta por timeout", async () => {
    await assert.rejects(safeFetch(`${origin}/slow`, { ...selfHosted, timeoutMs: 200 }), /sin respuesta en 200 ms/);
  });
});
