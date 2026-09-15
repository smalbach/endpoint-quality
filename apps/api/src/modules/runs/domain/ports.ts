import type { RequestBody } from "@eq/runner-core";

import type { RequestPreview, ResumeMode, Run, RunCase, RunPause, RunStatus, RunStep, RunTotals } from "./model";

export const RUN_REPOSITORY = Symbol("RUN_REPOSITORY");
export const RUN_QUEUE = Symbol("RUN_QUEUE");
export const REQUEST_PREVIEWER = Symbol("REQUEST_PREVIEWER");

export interface RunRepositoryPort {
  findById(id: string): Promise<Run | null>;
  listForProject(projectId: string, limit: number): Promise<Run[]>;
  save(run: Run): Promise<void>;
  saveCases(cases: RunCase[]): Promise<void>;
  listCases(runId: string): Promise<RunCase[]>;
  findCase(id: string): Promise<RunCase | null>;
  saveCase(runCase: RunCase): Promise<void>;
  saveSteps(steps: RunStep[]): Promise<void>;
  listSteps(runCaseId: string): Promise<RunStep[]>;
  /** Every step of every case of a run, in one read.
   *
   * The per-case view exists because a step carries whole response bodies and the progress screen
   * must not ship a thousand of them to draw a list. A report is the other need: a CI job, or
   * anyone comparing two runs, wants the assertion labels of all 311 cases and none of the
   * bodies. Asking for them case by case is 311 requests against a 120-per-minute limit — three
   * minutes of deliberate pacing to read one run. */
  listStepsForRun(runId: string): Promise<RunStep[]>;
  /** Recomputed from the case rows rather than incremented in memory: a worker that restarts
   * mid-run must not lose the count, and two workers must not both add one. */
  recomputeTotals(runId: string): Promise<RunTotals>;
  updateStatus(runId: string, status: RunStatus, at: Date, error?: string): Promise<void>;

  /**
   * Empties the payload columns of every step belonging to a run that finished before `before`,
   * and stamps `prunedAt`. Returns how many rows were emptied.
   *
   * The step survives. What weighs is the body; what makes a run from March still worth reading
   * is the assertion list, the label and the duration, and those are a few hundred bytes.
   */
  pruneStepBodies(before: Date): Promise<number>;

  /** Removes runs that finished before `before`, with their cases and steps. Returns how many
   * runs went. */
  deleteRunsBefore(before: Date): Promise<number>;
}

/**
 * Where a run waits to be executed.
 *
 * A port with two adapters because the two deployments have genuinely different needs: a hosted
 * instance wants Redis so a run survives a restart and several can proceed at once, and an
 * operator running this on a laptop should not have to install anything. `QUEUE_DRIVER` picks;
 * nothing else in the system knows which.
 */
export interface RunQueuePort {
  enqueue(runId: string): Promise<void>;
  /** Registered once at boot. The queue calls it with a run id and awaits it. */
  process(handler: (runId: string) => Promise<void>): void;
  /** Marks a run as cancelled so the worker stops at the next case boundary. Stopping mid-case
   * would leave a created resource with no cleanup step. */
  cancel(runId: string): Promise<void>;
  isCancelled(runId: string): Promise<boolean>;
  /** Records where a waiting run stopped, or clears it with `null`. Kept by the queue and not in the
   * worker's memory, so whichever instance answers `GET /runs/:id` can say the run is waiting. */
  pause(runId: string, at: RunPause | null): Promise<void>;
  pausedAt(runId: string): Promise<RunPause | null>;
  /** A person's release of a waiting run, left for the worker to take. */
  resume(runId: string, how: ResumeMode): Promise<void>;
  /** Consumes a pending release, if there is one. */
  takeResume(runId: string): Promise<ResumeMode | null>;
}

/**
 * Sending one request now, against a real environment.
 *
 * A port rather than a direct call because what implements it lives in infrastructure — it opens
 * sockets, decrypts credentials and reads the live contract — and the handler that validates the
 * request belongs in the application layer, which is not allowed to know any of that.
 */
export interface RequestPreviewerPort {
  preview(input: {
    projectId: string;
    environmentId: string;
    specVersionId: string;
    template: PreviewTemplate;
  }): Promise<RequestPreview>;
}

/** The request as the editor has it on screen, saved or not. There is no `templateId`: what gets
 * sent is what is in the form, which is the only reading of «enviar» that is not a surprise. */
export type PreviewTemplate = {
  name: string;
  operationId: string;
  expectedStatus: number;
  parameters: Record<string, string>;
  headers: Record<string, string>;
  body: RequestBody;
  auth: string;
};
