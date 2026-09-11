/**
 * Sending one request, now, and judging it exactly as a run would.
 *
 * The whole value is in the «exactly»: same `CaseExecutor`, same decrypted credentials, same
 * `writesAllowed`, same live contract, same assertions. A preview built on its own HTTP client
 * would be a second engine, and the first time the two disagreed the person in front of it would
 * have no way of knowing which one was lying.
 *
 * What it does **not** do is the other half of the point. Nothing is queued, no `runs` row is
 * written, no totals move and no progress event is published. A rehearsal that left a verdict in
 * the history would make the history unreadable — and people rehearse a lot.
 */
import { Injectable } from "@nestjs/common";

import { InvalidInputError } from "@/shared/errors/domain-error";
import { scenarioFor } from "@/modules/workflows/domain/model";
import type { ScenarioCredential } from "@eq/runner-core";
import type { RequestPreview } from "../domain/model";
import type { PreviewTemplate, RequestPreviewerPort } from "../domain/ports";
import { CaseExecutor } from "./case-executor";
import { ExecutionContextFactory } from "./execution-context";

@Injectable()
export class RequestPreviewer implements RequestPreviewerPort {
  constructor(
    private readonly contexts: ExecutionContextFactory,
    private readonly executor: CaseExecutor,
  ) {}

  async preview(input: {
    projectId: string;
    environmentId: string;
    specVersionId: string;
    template: PreviewTemplate;
  }): Promise<RequestPreview> {
    const context = await this.contexts.build(input);
    const operation = context.resolved.find((candidate) => candidate.id === input.template.operationId);
    // Named rather than silently skipped. A request pointing at an operation the active contract
    // does not declare is the ordinary consequence of importing a new version, and the editor can
    // only say so if the API does.
    if (!operation) {
      throw new InvalidInputError(
        "La operación no está en el contrato activo",
        [{ field: "operationId", detail: `El contrato de este proyecto no declara ${input.template.operationId}` }],
        "operation-not-found",
      );
    }

    const executed = await this.executor.run({
      operation,
      scenario: scenarioFor({
        id: "preview",
        name: input.template.name,
        description: null,
        expectedStatus: input.template.expectedStatus,
        parameters: input.template.parameters,
        headers: input.template.headers,
        body: input.template.body,
        auth: input.template.auth as ScenarioCredential,
      }),
      operations: context.resolved,
      config: context.config,
      target: context.target,
      // One. Extra samples exist to measure a percentile over a matrix; here the person is
      // watching a single request and the second one would only make them wait.
      samples: 1,
    });

    // `flow: "request"` plans exactly one step, so there is one. Reading the last rather than the
    // first keeps that from being a claim this file has to be right about.
    const step = executed.steps.at(-1);
    if (!step) throw new Error("La petición no llegó a planificarse");

    return {
      ok: step.ok,
      failure: step.failure,
      request: step.sent,
      expected: {
        status: step.request.expectedStatus,
        shape: step.request.expectedShape,
        operationPath: step.request.operationPath,
      },
      response: step.actual
        ? {
            status: step.actual.status,
            contentType: step.actual.contentType,
            headers: step.actual.headers,
            body: step.actual.body,
            // Of the bytes that arrived, not of the parsed value: a body re-serialised from the
            // object is a different number, and the one worth showing is what crossed the wire.
            sizeBytes: Buffer.byteLength(step.actual.raw ?? ""),
          }
        : null,
      assertions: step.assertions,
      latency: step.latency,
      durationMs: step.durationMs,
    };
  }
}
