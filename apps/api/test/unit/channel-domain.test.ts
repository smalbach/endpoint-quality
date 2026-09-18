/**
 * El dominio de los canales, con listas y relojes escritos a mano.
 *
 * Tres cosas se fijan aquí porque las tres fallan en silencio: que un canal no pueda guardar lo
 * que nunca podrá funcionar (una cabecera que rompe el handshake, una comprobación de estado HTTP
 * sobre un socket), que un socket colgado se corte por el reloj y no espere para siempre, y que el
 * segador distinga una sesión muerta de una viva de otra instancia.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_LIMITS,
  blankChannel,
  channelProblems,
  effectiveLimits,
  withChanges,
  type ChannelCeilings,
} from "@/modules/channels/domain/model";
import { closeSession, isStale, onFrame, onTick, startSession } from "@/modules/channels/domain/session";

const CEILINGS: ChannelCeilings = { ...DEFAULT_LIMITS, maxOpen: 20 };
const now = new Date("2026-03-01T10:00:00.000Z");
const fields = (problems: { field: string }[]) => problems.map((problem) => problem.field);

describe("lo que un canal no puede guardar", () => {
  test("una URL que no es de socket se dice al guardar, no al conectar", () => {
    assert.deepEqual(fields(channelProblems({ url: "https://api.ejemplo.com/chat" }, CEILINGS)), ["url"]);
    assert.deepEqual(fields(channelProblems({ url: "wss://usuario:clave@api.ejemplo.com" }, CEILINGS)), ["url"]);
    assert.deepEqual(channelProblems({ url: "wss://api.ejemplo.com/chat" }, CEILINGS), []);
    // Con variables no se sabe qué será hasta abrir contra un entorno, y eso no es un error.
    assert.deepEqual(channelProblems({ url: "{{wsBase}}/chat?room={{sala}}" }, CEILINGS), []);
  });

  test("las cabeceras del propio protocolo no se escriben a mano", () => {
    // Fijarlas rompe el handshake, y el error al conectar no nombra la cabecera.
    for (const name of ["Host", "Sec-WebSocket-Key", "Upgrade", "sec-websocket-protocol"]) {
      const problems = channelProblems({ headers: [{ name, value: "x", enabled: true }] }, CEILINGS);
      assert.deepEqual(fields(problems), ["headers.0.name"], name);
    }
    const injected = channelProblems(
      { headers: [{ name: "X-Token", value: "a\r\nX-Admin: 1", enabled: true }] },
      CEILINGS,
    );
    assert.deepEqual(fields(injected), ["headers.0.value"]);
  });

  test("un subprotocolo es una palabra, no una frase", () => {
    assert.deepEqual(fields(channelProblems({ subprotocols: ["graphql-ws", "mi protocolo"] }, CEILINGS)), [
      "subprotocols.1",
    ]);
  });

  test("un tope por encima del techo del despliegue se rechaza con el techo dicho", () => {
    const [problem] = channelProblems({ limits: { maxDurationMs: 3_600_000 } }, CEILINGS);
    assert.equal(problem.field, "limits.maxDurationMs");
    assert.match(problem.detail, /Como mucho 30000 ms de duración/);
  });

  test("pero un canal viejo con un techo que bajó se recorta, no se inutiliza", () => {
    const limits = effectiveLimits({ ...DEFAULT_LIMITS, maxDurationMs: 60_000 }, CEILINGS);
    assert.equal(limits.maxDurationMs, 30_000);
  });

  test("una comprobación de respuesta HTTP en un canal no se guarda", () => {
    // `status equals 200` sobre un socket no puede pasar nunca. Guardarla es guardar un rojo fijo.
    const problems = channelProblems(
      {
        expectations: {
          checks: [
            { source: "message", path: "type", operator: "equals", value: "pong", match: { at: "any" } },
            { source: "status", operator: "equals", value: 200 },
          ],
        },
      },
      CEILINGS,
    );
    assert.deepEqual(fields(problems), ["expectations.checks.1.source"]);
  });

  test("un código de cierre es uno de WebSocket", () => {
    assert.deepEqual(fields(channelProblems({ expectations: { closeCode: 200 } }, CEILINGS)), [
      "expectations.closeCode",
    ]);
  });

  test("la autenticación se guarda con la misma regla que la de un endpoint", () => {
    const channel = blankChannel({ id: "c", projectId: "p", name: "eco", url: "wss://x", now, by: "u" });
    const changed = withChanges(
      channel,
      { auth: { type: "bearer", params: { token: "{{token}}", sobra: "" } }, limits: { idleMs: 5_000 } },
      now,
      "u",
    );
    // Lo vacío que no es secreto no se guarda; los topes que no se mandaron se quedan como estaban.
    assert.deepEqual(changed.auth, { type: "bearer", params: { token: "{{token}}" } });
    assert.equal(changed.limits.idleMs, 5_000);
    assert.equal(changed.limits.maxDurationMs, DEFAULT_LIMITS.maxDurationMs);
  });
});

describe("el reloj de una sesión", () => {
  const session = () =>
    onFrame(
      startSession({
        id: "s",
        channelId: "c",
        projectId: "p",
        environmentId: null,
        ownerInstance: "a",
        startedBy: "u",
        now,
      }),
      { direction: "open", atMs: 0, handshake: { status: 101, headers: {} } },
      DEFAULT_LIMITS,
      {},
    ).session;

  test("un servidor que acepta y calla se corta por inactividad, desde la apertura", () => {
    const quiet = session();
    assert.equal(onTick(quiet, 9_999, DEFAULT_LIMITS), null);
    assert.equal(onTick(quiet, 10_000, DEFAULT_LIMITS), "idle-cap");
  });

  test("la inactividad cuenta desde el último mensaje, no desde la apertura", () => {
    const talking = onFrame(session(), { direction: "in", atMs: 8_000, body: "hola" }, DEFAULT_LIMITS, {}).session;
    assert.equal(onTick(talking, 15_000, DEFAULT_LIMITS), null);
    assert.equal(onTick(talking, 18_000, DEFAULT_LIMITS), "idle-cap");
  });

  test("uno que habla sin parar se corta por duración", () => {
    let chatty = session();
    for (let at = 1_000; at < 30_000; at += 1_000)
      chatty = onFrame(chatty, { direction: "in", atMs: at, body: "." }, DEFAULT_LIMITS, {}).session;
    assert.equal(onTick(chatty, 30_000, DEFAULT_LIMITS), "time-cap");
  });

  test("al cerrar queda el veredicto, calculado una vez", () => {
    const closed = closeSession(session(), "idle-cap", { minMessages: 1 }, now);
    assert.equal(closed.status, "closed");
    assert.equal(closed.stopReason, "idle-cap");
    assert.equal(closed.verdict?.ok, false);
    assert.equal(closed.verdict?.failure, "check");
    // Y una sesión cerrada no vuelve a cerrarse ni a cambiar de veredicto.
    assert.equal(closeSession(closed, "cancelled", {}, now), closed);
  });

  test("una que no llegó a abrir queda en error, con el motivo de quien abrió", () => {
    const never = startSession({
      id: "s",
      channelId: "c",
      projectId: "p",
      environmentId: null,
      ownerInstance: "a",
      startedBy: "u",
      now,
    });
    const failed = closeSession(never, "handshake-failed", {}, now, {
      kind: "network",
      detail: "el upgrade contestó 401",
    });
    assert.equal(failed.status, "error");
    assert.equal(failed.verdict?.assertions[0].detail, "el upgrade contestó 401");
  });
});

describe("el segador", () => {
  const beat = 5_000;
  test("una sesión abierta con el latido al día no se toca, sea de quien sea", () => {
    assert.equal(isStale({ status: "open", heartbeatAt: new Date(now.getTime() - 14_000) }, now, beat), false);
  });

  test("tres latidos perdidos y está muerta", () => {
    assert.equal(isStale({ status: "open", heartbeatAt: new Date(now.getTime() - 15_001) }, now, beat), true);
    assert.equal(isStale({ status: "connecting", heartbeatAt: new Date(now.getTime() - 60_000) }, now, beat), true);
  });

  test("una cerrada nunca es de segar, por viejo que sea su latido", () => {
    assert.equal(isStale({ status: "closed", heartbeatAt: new Date(0) }, now, beat), false);
  });
});
