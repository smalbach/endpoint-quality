import type { RunCaseViewOf, RunOf, RunReportOf, RunReportStep, RunViewOf } from "@eq/contracts";

import { Inject, Optional } from "@nestjs/common";
import { QueryHandler, type IQuery, type IQueryHandler } from "@nestjs/cqrs";

import { NotFoundError } from "@/shared/errors/domain-error";
import { PROJECT_REPOSITORY, type ProjectRepositoryPort } from "@/modules/projects/domain/ports";
import { ownedProject } from "@/modules/projects/application/commands/update-project";
import type { Run, RunCase, RunStep } from "../../domain/model";
import { isFinished } from "../../domain/model";
import { RUN_QUEUE, RUN_REPOSITORY, type RunQueuePort, type RunRepositoryPort } from "../../domain/ports";
import { WORKFLOW_REPOSITORY, type WorkflowRepositoryPort } from "@/modules/workflows/domain/ports";
import { CHANNEL_REPOSITORY, type ChannelRepositoryPort } from "@/modules/channels/domain/ports";
import { describeSource, loadCatalog } from "./describe-source";

export class ListRunsQuery implements IQuery {
  constructor(
    readonly organizationId: string,
    readonly projectId: string,
    readonly limit = 25,
  ) {}
}
export class GetRunQuery implements IQuery {
  constructor(
    readonly organizationId: string,
    readonly projectId: string,
    readonly runId: string,
  ) {}
}
export class GetRunCaseQuery implements IQuery {
  constructor(
    readonly organizationId: string,
    readonly projectId: string,
    readonly runId: string,
    readonly caseId: string,
  ) {}
}

/** The same declarations the browser reads, instantiated with this side's timestamps. */
export type RunRow = Run & RunOf<Date>;
export type RunView = Run & { cases: RunCase[] } & RunViewOf<Date>;
export type RunCaseView = RunCase & { steps: RunStep[] } & RunCaseViewOf<Date>;

@QueryHandler(ListRunsQuery)
export class ListRunsHandler implements IQueryHandler<ListRunsQuery, RunRow[]> {
  constructor(
    @Inject(PROJECT_REPOSITORY) private readonly projects: ProjectRepositoryPort,
    @Inject(RUN_REPOSITORY) private readonly runs: RunRepositoryPort,
    @Inject(WORKFLOW_REPOSITORY) private readonly workflows: WorkflowRepositoryPort,
    @Optional() @Inject(CHANNEL_REPOSITORY) private readonly channels: ChannelRepositoryPort | null = null,
  ) {}
  async execute(query: ListRunsQuery): Promise<RunRow[]> {
    const project = await ownedProject(this.projects, query.organizationId, query.projectId);
    const [runs, catalog] = await Promise.all([
      this.runs.listForProject(project.id, Math.min(100, Math.max(1, query.limit))),
      loadCatalog(this.workflows, project.id, this.channels),
    ]);
    return runs.map((run) => ({ ...run, source: describeSource(run, catalog) }));
  }
}

/**
 * A run with its case list, but **without the steps**.
 *
 * The steps hold full response bodies — a 311-case run is close to a thousand of them — and the
 * run view is what the progress screen polls. Shipping every body to render a list of green and
 * red rows would make the page slower the more there is to show.
 */
@QueryHandler(GetRunQuery)
export class GetRunHandler implements IQueryHandler<GetRunQuery, RunView> {
  constructor(
    @Inject(PROJECT_REPOSITORY) private readonly projects: ProjectRepositoryPort,
    @Inject(RUN_REPOSITORY) private readonly runs: RunRepositoryPort,
    @Inject(WORKFLOW_REPOSITORY) private readonly workflows: WorkflowRepositoryPort,
    @Inject(RUN_QUEUE) private readonly queue: RunQueuePort,
    @Optional() @Inject(CHANNEL_REPOSITORY) private readonly channels: ChannelRepositoryPort | null = null,
  ) {}
  async execute(query: GetRunQuery): Promise<RunView> {
    const project = await ownedProject(this.projects, query.organizationId, query.projectId);
    const run = await this.runs.findById(query.runId);
    if (!run || run.projectId !== project.id) throw new NotFoundError("La corrida no existe", "run-not-found");
    const [cases, catalog, paused] = await Promise.all([
      this.runs.listCases(run.id),
      loadCatalog(this.workflows, project.id, this.channels),
      // Read from the queue because the pause lives there: a page opened while the run waits has to
      // show the «siguiente» button without having seen the event that announced it.
      isFinished(run.status) ? null : this.queue.pausedAt(run.id),
    ]);
    return { ...run, source: describeSource(run, catalog), cases, paused };
  }
}

/** One case with everything it did: the request as sent, the response as received, and every
 * assertion. This is the evidence view, and it is fetched one case at a time. */
@QueryHandler(GetRunCaseQuery)
export class GetRunCaseHandler implements IQueryHandler<GetRunCaseQuery, RunCaseView> {
  constructor(
    @Inject(PROJECT_REPOSITORY) private readonly projects: ProjectRepositoryPort,
    @Inject(RUN_REPOSITORY) private readonly runs: RunRepositoryPort,
  ) {}
  async execute(query: GetRunCaseQuery): Promise<RunCaseView> {
    const project = await ownedProject(this.projects, query.organizationId, query.projectId);
    const run = await this.runs.findById(query.runId);
    if (!run || run.projectId !== project.id) throw new NotFoundError("La corrida no existe", "run-not-found");
    const runCase = await this.runs.findCase(query.caseId);
    if (!runCase || runCase.runId !== run.id) throw new NotFoundError("El caso no existe", "run-case-not-found");
    return { ...runCase, steps: await this.runs.listSteps(runCase.id) };
  }
}

/**
 * The whole run as a report: every case, every assertion, no bodies.
 *
 * The two views that already existed cover the two screens — a list to draw progress, one case to
 * read the evidence — and left the third need unmet. **A run is a result somebody wants to keep**:
 * compare against last week's, attach to a pull request, fail a pipeline on. Getting that out of
 * the per-case view is one request per case, which against a 120-per-minute limit turns reading a
 * 311-case run into three minutes of pacing.
 *
 * What is dropped is what makes the per-case view expensive: `request`, `expected` and `actual`
 * hold whole payloads and whole response bodies. What is kept is the part a report is made of —
 * which case, which step, which assertions, and the latency. A 311-case run comes out around a
 * few hundred kilobytes instead of tens of megabytes.
 */
export class GetRunReportQuery implements IQuery {
  constructor(
    readonly organizationId: string,
    readonly projectId: string,
    readonly runId: string,
  ) {}
}

export type ReportAssertion = RunReportStep["assertions"][number];
export type ReportStep = RunReportStep;
export type ReportCase = Omit<RunCase, "runId"> & { steps: ReportStep[] };
export type RunReport = RunReportOf<Date> & { run: RunRow; cases: ReportCase[] };

@QueryHandler(GetRunReportQuery)
export class GetRunReportHandler implements IQueryHandler<GetRunReportQuery, RunReport> {
  constructor(
    @Inject(PROJECT_REPOSITORY) private readonly projects: ProjectRepositoryPort,
    @Inject(RUN_REPOSITORY) private readonly runs: RunRepositoryPort,
    @Inject(WORKFLOW_REPOSITORY) private readonly workflows: WorkflowRepositoryPort,
    @Optional() @Inject(CHANNEL_REPOSITORY) private readonly channels: ChannelRepositoryPort | null = null,
  ) {}
  async execute(query: GetRunReportQuery): Promise<RunReport> {
    const project = await ownedProject(this.projects, query.organizationId, query.projectId);
    const run = await this.runs.findById(query.runId);
    if (!run || run.projectId !== project.id) throw new NotFoundError("La corrida no existe", "run-not-found");

    // One read for the cases and one for every step, then grouped here. The alternative — a query
    // per case — is the N+1 that made the per-case view unusable as a report in the first place.
    const [cases, steps, catalog] = await Promise.all([
      this.runs.listCases(run.id),
      this.runs.listStepsForRun(run.id),
      loadCatalog(this.workflows, project.id, this.channels),
    ]);
    const byCase = new Map<string, RunStep[]>();
    for (const step of steps) byCase.set(step.runCaseId, [...(byCase.get(step.runCaseId) ?? []), step]);

    return {
      // The report is what gets attached to a pull request or read six months later, so what it
      // executed has to be in it. An anonymous list of 311 verdicts is not evidence of anything.
      run: { ...run, source: describeSource(run, catalog) },
      cases: cases.map(({ runId: _runId, ...runCase }) => ({
        ...runCase,
        steps: (byCase.get(runCase.id) ?? []).map((step) => ({
          index: step.index,
          purpose: step.purpose,
          label: step.label,
          ok: step.ok,
          durationMs: step.durationMs,
          // Stored as JSON, so it arrives as `unknown`. Narrowed here rather than trusted: a row
          // written by an older version with a different shape should come out empty, not
          // crash the report of a run somebody is waiting on.
          assertions: Array.isArray(step.assertions) ? (step.assertions as ReportAssertion[]) : [],
        })),
      })),
    };
  }
}
