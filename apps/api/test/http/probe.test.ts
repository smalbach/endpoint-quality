import { before, after, test } from "node:test";
import request from "supertest";
import { createTestApp, type TestContext } from "../support/test-app";
import { StubTarget, STUB_SPEC_YAML } from "../support/stub-target";

let context: TestContext;
const api = () => request(context.app.getHttpServer());

before(async () => {
  context = await createTestApp();
});
after(async () => context?.close());

test("probe", async () => {
  const target = new StubTarget({});
  await target.start();
  const password = "una-contraseña-larga";
  await api().post("/auth/register").send({ email: "probe@example.com", password, name: "p" });
  const session = await api().post("/auth/login").send({ email: "probe@example.com", password });
  const as = { Authorization: `Bearer ${session.body.accessToken}` };
  const org = (await api().get("/auth/me").set(as)).body;
  const project = await api().post(`/orgs/${org.organizations[0].id}/projects`).set(as).send({ name: "p" });
  const base = `/orgs/${org.organizations[0].id}/projects/${project.body.projectId}`;
  await api()
    .post(`${base}/spec-versions`)
    .set(as)
    .send({ source: { kind: "inline", raw: STUB_SPEC_YAML } });
  await api()
    .put(`${base}/config/bodies`)
    .set(as)
    .send({
      bodyTemplates: {
        createThing: { body: { name: "creado", size: 7 } },
        createSession: { body: { email: "a@b.c", password: "x" } },
      },
    });
  await api()
    .put(`${base}/config/parameters`)
    .set(as)
    .send({
      parameterSamples: {},
      fallbackSamples: ["test"],
      excludeFromSoloScenarios: [],
      pathDefaults: { id: "1" },
      fallbackPathValue: "1",
      missingIdValue: "no-existe",
    });
  const env = await api()
    .post(`${base}/environments`)
    .set(as)
    .send({ name: "s", baseUrl: target.origin, specUrl: `${target.origin}/openapi.json`, writesAllowed: true });
  const started = await api().post(`${base}/runs`).set(as).send({ environmentId: env.body.environmentId });
  await context.queue.idle();
  const report = await api().get(`${base}/runs/${started.body.runId}/report`).set(as);
  for (const item of report.body.cases) {
    if (item.status === "passed") continue;
    console.log("CASE", item.scenarioId, item.operationId, item.status);
    for (const step of item.steps)
      for (const a of step.assertions) if (!a.pass) console.log("   ", step.label, "|", a.label, "|", a.detail);
  }
  await target.stop();
});
