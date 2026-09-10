/**
 * Every case the coupled dashboard would run, executed headlessly, verdict recorded.
 *
 * The order is `buildQueue`'s, not a convenience order of mine. It matters: `safe` puts reads
 * first and DELETEs last, and a matrix that writes before it reads sees different data. Running
 * the two sides in different orders would produce differences that say nothing about the
 * decoupling.
 */
import { endpoints } from "../../packages/runner-core/test/legacy/endpoints.ts";
import { buildQueue } from "../../packages/runner-core/test/legacy/execution-plan.ts";
import { LegacyRunner } from "./legacy/orchestrate.ts";
import { ADMIN_TOKEN, API_KEY, READ_TOKEN } from "./credentials.ts";

export type Verdict = { key: string; operationId: string; scenarioId: string; ok: boolean; steps: number; failedAssertions: string[] };

export async function legacyVerdicts(baseUrl: string, authEnabled: boolean, singleCredential: boolean, onCase?: (index: number, total: number, key: string) => void): Promise<Verdict[]> {
  const queue = buildQueue(endpoints, { mode: "safe", customOrder: [], caseSelection: {}, authEnabled });
  const runner = new LegacyRunner(
    endpoints,
    baseUrl,
    // With auth off the dashboard's own guidance is to leave the fields empty: the API grants
    // `catalog:admin` to everyone, and sending a token would test the gateway's absence.
    authEnabled ? { token: ADMIN_TOKEN, apiKey: API_KEY, readToken: READ_TOKEN, singleCredential } : { token: "", apiKey: "", readToken: "" },
    1,
  );

  const verdicts: Verdict[] = [];
  for (const [index, item] of queue.entries()) {
    const key = `${item.endpoint.id}:${item.scenario.id}`;
    onCase?.(index + 1, queue.length, key);
    const result = await runner.runScenario(item.endpoint, item.scenario);
    verdicts.push({
      key,
      operationId: item.endpoint.id,
      scenarioId: item.scenario.id,
      ok: result.ok,
      steps: result.steps.length,
      // Kept so a disagreement can be read without re-running: "both red" is parity, "red here
      // for the status and red there for the schema" is not.
      failedAssertions: result.steps.flatMap((step) => step.assertions.filter((assertion) => !assertion.pass).map((assertion) => assertion.label)),
    });
  }
  return verdicts;
}
