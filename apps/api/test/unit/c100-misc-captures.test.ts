/**
 * Las capturas en lo que la aplicación de prueba —que siempre tiene el proxy encendido y
 * escuchando— no enseña: el resumen con la captura apagada o con el proxy sin puerto todavía, y el
 * «Parar» de una sesión que alguien borró mientras se paraba.
 */
import "reflect-metadata";
import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { StopCaptureCommand, StopCaptureHandler } from "@/modules/captures/application/commands/manage-captures";
import { GetCapturesHandler, GetCapturesQuery } from "@/modules/captures/application/queries/read-captures";
import type { CaptureSession } from "@/modules/captures/domain/model";
import type { Project } from "@/modules/projects/domain/model";
import { InMemoryCaptureRepository } from "../support/in-memory-captures";
import { InMemoryProjectRepository } from "../support/in-memory-repositories";

const NOW = new Date("2026-03-01T10:00:00.000Z");

const session: CaptureSession = {
  id: "s-1",
  projectId: "p-1",
  status: "active",
  tokenHash: "hash",
  limits: { durationMs: 60_000, maxRequests: 50, maxBodyBytes: 4_096 },
  itemCount: 3,
  startedAt: NOW,
  expiresAt: new Date(NOW.getTime() + 60_000),
  stoppedAt: null,
  stopReason: null,
  startedBy: "u",
  decryptHttps: false,
};

async function setup() {
  const projects = new InMemoryProjectRepository();
  await projects.save({ id: "p-1", organizationId: "org-1", archivedAt: null, deletedAt: null } as unknown as Project);
  const captures = new InMemoryCaptureRepository();
  await captures.saveSession(session);
  return { projects, captures };
}

describe("el resumen de capturas", () => {
  test("con la captura apagada no hay proxy ni CA que enseñar, y las sesiones sí", async () => {
    const { projects, captures } = await setup();
    let asked = 0;
    const handler = new GetCapturesHandler(
      projects,
      captures,
      { enabled: false, port: null, publicHost: null } as never,
      { status: async () => (asked += 1) } as never,
    );
    const overview = await handler.execute(new GetCapturesQuery("org-1", "p-1"));
    assert.equal(overview.enabled, false);
    assert.equal(overview.proxy, null);
    assert.equal(overview.mitm, null);
    assert.equal(asked, 0, "sin captura no se pregunta por la CA");
    assert.deepEqual(
      overview.sessions.map((row) => row.id),
      ["s-1"],
    );
  });

  test("encendida pero sin puerto todavía, no hay proxy al que apuntar", async () => {
    const { projects, captures } = await setup();
    const mitm = { enabled: false, fingerprint: null };
    const handler = new GetCapturesHandler(
      projects,
      captures,
      { enabled: true, port: null, publicHost: "captura.test" } as never,
      { status: async () => mitm } as never,
    );
    const overview = await handler.execute(new GetCapturesQuery("org-1", "p-1"));
    assert.equal(overview.enabled, true);
    assert.equal(overview.proxy, null);
    assert.equal(overview.mitm, mitm);
  });
});

describe("parar una captura", () => {
  test("si la sesión desaparece mientras se para, se contesta con la que se leyó antes de parar", async () => {
    const { projects, captures } = await setup();
    const stopped: string[] = [];
    const proxy = {
      stop: async (current: CaptureSession, reason: string) => {
        stopped.push(`${current.id}:${reason}`);
        await captures.removeSession(current.projectId, current.id);
        return true;
      },
    };
    const handler = new StopCaptureHandler(projects, captures, proxy as never);
    const view = await handler.execute(new StopCaptureCommand("org-1", "p-1", "s-1"));
    assert.deepEqual(stopped, ["s-1:manual"]);
    assert.equal(view.id, "s-1");
    assert.equal(view.itemCount, 3);
    assert.equal(await captures.findSession("p-1", "s-1"), null);
  });
});
