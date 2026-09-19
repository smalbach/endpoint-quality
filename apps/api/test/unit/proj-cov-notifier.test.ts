/**
 * El aviso por correo de una solicitud de fusión, sin aplicación: a quién va, qué dice cuando le
 * faltan nombres, y que un correo que falla se registra en vez de romper la acción que lo pidió.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { MergeRequestNotifier } from "@/modules/projects/application/merge-request-notifier";
import type { ForkMergeRequest } from "@/modules/projects/domain/merge-request";

type Sent = { to: string; subject: string; text?: string };
const request = {
  id: "mr-1",
  organizationId: "org",
  forkProjectId: "fork",
  parentProjectId: "parent",
  title: "Llevar",
  description: "",
  status: "open",
  createdBy: "autor",
  createdAt: new Date(0),
  updatedAt: new Date(0),
  diff: [],
  diffVersion: 1,
  decidedBy: null,
  decidedAt: null,
} as unknown as ForkMergeRequest;

function notifier(options: {
  users: Record<string, { email: string; name: string }>;
  summaries?: unknown[];
  fail?: boolean;
}) {
  const sent: Sent[] = [];
  const errors: string[] = [];
  let done!: () => void;
  const finished = new Promise<void>((resolve) => (done = resolve));
  const mailer = {
    async send(mail: Sent) {
      if (options.fail) {
        queueMicrotask(done);
        throw new Error("smtp caído");
      }
      sent.push(mail);
      done();
    },
  };
  const users = { findById: async (id: string) => options.users[id] ?? null };
  const views = { list: async () => options.summaries ?? [] };
  const instance = new MergeRequestNotifier(
    mailer as never,
    users as never,
    { APP_URL: "https://app.test///" } as never,
    views as never,
  );
  (instance as unknown as { logger: { error(message: string): void } }).logger = {
    error: (message: string) => errors.push(message),
  };
  return { instance, sent, errors, finished };
}
const tick = () => new Promise((resolve) => setImmediate(resolve));

describe("el aviso de una solicitud", () => {
  test("quien actúa sobre su propia solicitud no se avisa a sí mismo", async () => {
    const { instance, sent } = notifier({ users: { autor: { email: "a@x.test", name: "Ana" } } });
    instance.notify(request, "comment", "autor");
    await tick();
    assert.deepEqual(sent, []);
  });

  test("un autor que ya no existe no recibe nada", async () => {
    const { instance, sent, errors } = notifier({ users: {} });
    instance.notify(request, "approved", "revisor");
    await tick();
    await tick();
    assert.deepEqual(sent, []);
    assert.deepEqual(errors, []);
  });

  test("sin resumen ni nombre de quien actúa, el correo usa los nombres genéricos y un enlace limpio", async () => {
    const { instance, sent, finished } = notifier({ users: { autor: { email: "a@x.test", name: "Ana" } } });
    instance.notify(request, "declined", "token-de-ci");
    await finished;
    assert.equal(sent.length, 1);
    assert.equal(sent[0]!.to, "a@x.test");
    assert.match(sent[0]!.subject, /rechazó por Alguien/);
    const text = JSON.stringify(sent[0]);
    assert.match(text, /la bifurcación/);
    assert.match(text, /el original/);
    assert.match(text, /https:\/\/app\.test\/p\/parent\/merge-requests\/mr-1/);
  });

  test("con resumen, los nombres de los proyectos", async () => {
    const { instance, sent, finished } = notifier({
      users: { autor: { email: "a@x.test", name: "Ana" }, revisor: { email: "r@x.test", name: "Rita" } },
      summaries: [
        { id: "otra", fork: { name: "No" }, parent: { name: "No" } },
        { id: "mr-1", fork: { name: "Mi copia" }, parent: { name: "Tienda" } },
      ],
    });
    instance.notify(request, "merged", "revisor");
    await finished;
    const text = JSON.stringify(sent[0]);
    assert.match(text, /Mi copia/);
    assert.match(text, /Tienda/);
    assert.match(sent[0]!.subject, /fusionó por Rita/);
  });

  test("un correo que falla se registra con el id de la solicitud y no se lanza", async () => {
    const { instance, errors, finished } = notifier({
      users: { autor: { email: "a@x.test", name: "Ana" } },
      fail: true,
    });
    instance.notify(request, "closed", "revisor");
    await finished;
    await tick();
    assert.deepEqual(errors, ["No se pudo avisar de la solicitud mr-1: smtp caído"]);
  });
});
