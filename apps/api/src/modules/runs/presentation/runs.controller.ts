/**
 * Starting a run, following it, and reading it back.
 *
 * `POST /runs` answers **202 with an id** and nothing else: the matrix proceeds in a worker, so
 * the browser can close, the connection can drop, and a CI job can fire and forget. That is the
 * whole difference from the coupled dashboard, where the loop lived in a React component and the
 * run died with the tab.
 *
 * Launching a run is `editor`, and the environment decides whether it may write — the run itself
 * is not where that authority lives.
 */
import { Body, Controller, Get, HttpCode, Param, Post, Query, Res, Sse, UseGuards } from "@nestjs/common";
import type { Response } from "express";
import { CommandBus, QueryBus } from "@nestjs/cqrs";
import { SkipThrottle } from "@nestjs/throttler";
import { Observable, concat, from, map, takeWhile } from "rxjs";

import {
  CurrentUser,
  OrgRoleGuard,
  RequireRole,
  type Principal,
} from "@/modules/auth/infrastructure/guards/auth.guard";
import { StartRunCommand } from "../application/commands/start-run";
import { CancelRunCommand } from "../application/commands/cancel-run";
import { ResumeRunCommand } from "../application/commands/resume-run";
import {
  GetRunCaseQuery,
  GetRunQuery,
  GetRunReportQuery,
  ListRunsQuery,
  type RunReport,
  type RunView,
} from "../application/queries/get-run";
import { RunProgressStream } from "../infrastructure/run-progress.stream";
import { ResumeRunDto, StartRunDto } from "./dto/runs.dto";
import { REPORT_CONTENT_TYPE, REPORT_FORMATS, toHtmlReport, toJUnitXml, type ReportFormat } from "./report-formats";

/**
 * `?format=` as a query parameter and not as a suffix on the path, because it is the same
 * resource: `.../report` is one run's result, and `json`, `html` and `junit` are three renderings
 * of it. A `report.xml` route would be a second URL for the same thing, and the day a third
 * format arrives there would be three.
 *
 * Anything unrecognised falls back to JSON rather than answering 400. The parameter is typed by
 * hand into a CI script far more often than it is generated, and a report that answers «formato
 * inválido» to `?format=JUnit` fails the pipeline for a reason that has nothing to do with the
 * API being tested.
 */
function reportFormat(value: string | undefined): ReportFormat {
  const wanted = (value ?? "json").trim().toLowerCase();
  return (REPORT_FORMATS as readonly string[]).includes(wanted) ? (wanted as ReportFormat) : "json";
}

@Controller("orgs/:organizationId/projects/:projectId/runs")
@UseGuards(OrgRoleGuard)
export class RunsController {
  constructor(
    private readonly commandBus: CommandBus,
    private readonly queryBus: QueryBus,
    private readonly progress: RunProgressStream,
  ) {}

  @Get()
  @RequireRole("viewer")
  async list(
    @Param("organizationId") organizationId: string,
    @Param("projectId") projectId: string,
    @Query("limit") limit?: string,
  ) {
    return this.queryBus.execute(new ListRunsQuery(organizationId, projectId, Number(limit) || 25));
  }

  @Post()
  @HttpCode(202)
  @RequireRole("editor")
  async start(
    @Param("organizationId") organizationId: string,
    @Param("projectId") projectId: string,
    @Body() body: StartRunDto,
    @CurrentUser() principal: Principal,
  ) {
    const triggeredBy =
      principal.kind === "user"
        ? { kind: "user" as const, id: principal.userId }
        : { kind: "api-token" as const, id: principal.tokenId };
    return this.commandBus.execute(new StartRunCommand(organizationId, projectId, body, triggeredBy));
  }

  @Get(":runId")
  @RequireRole("viewer")
  async get(
    @Param("organizationId") organizationId: string,
    @Param("projectId") projectId: string,
    @Param("runId") runId: string,
  ) {
    return this.queryBus.execute(new GetRunQuery(organizationId, projectId, runId));
  }

  /**
   * The run as a report: every case with its assertions, no response bodies.
   *
   * Outside the throttler for the same reason the stream is. Reading a finished run is one
   * request; what the limit is there to stop is a client that asks 311 times, which is exactly
   * what this exists to make unnecessary.
   */
  @SkipThrottle()
  @Get(":runId/report")
  @RequireRole("viewer")
  async report(
    @Param("organizationId") organizationId: string,
    @Param("projectId") projectId: string,
    @Param("runId") runId: string,
    @Query("format") format: string | undefined,
    @Res({ passthrough: true }) response: Response,
  ) {
    const chosen = reportFormat(format);
    const report = await this.queryBus.execute<GetRunReportQuery, RunReport>(
      new GetRunReportQuery(organizationId, projectId, runId),
    );
    if (chosen === "json") return report;

    // `passthrough` so Nest still applies the guards and the exception filter; only the body and
    // the content type are taken over. Returning the string from the handler would publish it as
    // JSON — a quoted, escaped blob that no CI runner and no browser can read.
    response.type(REPORT_CONTENT_TYPE[chosen]);
    // Named so a browser saves something recognisable and a CI job can collect it by pattern. The
    // run id is in the name because two of them in one artifact directory is the ordinary case.
    response.header(
      "Content-Disposition",
      `inline; filename="corrida-${runId}.${chosen === "junit" ? "xml" : "html"}"`,
    );
    return chosen === "junit" ? toJUnitXml(report) : toHtmlReport(report);
  }

  @Get(":runId/cases/:caseId")
  @RequireRole("viewer")
  async getCase(
    @Param("organizationId") organizationId: string,
    @Param("projectId") projectId: string,
    @Param("runId") runId: string,
    @Param("caseId") caseId: string,
  ) {
    return this.queryBus.execute(new GetRunCaseQuery(organizationId, projectId, runId, caseId));
  }

  @Post(":runId/cancel")
  @HttpCode(204)
  @RequireRole("editor")
  async cancel(
    @Param("organizationId") organizationId: string,
    @Param("projectId") projectId: string,
    @Param("runId") runId: string,
  ): Promise<void> {
    await this.commandBus.execute(new CancelRunCommand(organizationId, projectId, runId));
  }

  /** Lets a run waiting at a step boundary go on: one step, or the rest of the way. */
  @Post(":runId/resume")
  @HttpCode(204)
  @RequireRole("editor")
  async resume(
    @Param("organizationId") organizationId: string,
    @Param("projectId") projectId: string,
    @Param("runId") runId: string,
    @Body() body: ResumeRunDto,
  ): Promise<void> {
    await this.commandBus.execute(new ResumeRunCommand(organizationId, projectId, runId, body.mode));
  }

  /**
   * Live progress.
   *
   * It opens with the run's **current state** rather than with the next event, so a client that
   * connects late — or reconnects — sees where things stand instead of waiting for the next case
   * to finish. The stream completes on its own when the run does, which is what tells the browser
   * to stop holding the connection.
   *
   * A client behind a proxy that buffers SSE can poll `GET /runs/:id` instead; the payload is the
   * same shape, which is deliberate.
   */
  @Sse(":runId/stream")
  // A long-lived connection is not a request rate, and counting it as one creates a trap: when
  // the stream is refused the client falls back to polling, the polling spends the same budget,
  // and the stream can never reconnect. One follower holds one connection; the real limit on
  // this route is the number of open sockets, which is a different control.
  @SkipThrottle()
  @RequireRole("viewer")
  stream(
    @Param("organizationId") organizationId: string,
    @Param("projectId") projectId: string,
    @Param("runId") runId: string,
  ): Observable<{ data: unknown; type: string }> {
    // `from` and not `startWith`: the query returns a promise, and putting it straight into the
    // stream sends the *promise* — which serialises as `{}` and reaches the client as a snapshot
    // with zero totals while the case rows say otherwise. It has to be resolved first.
    const snapshot = from(
      this.queryBus.execute<GetRunQuery, RunView>(new GetRunQuery(organizationId, projectId, runId)),
    ).pipe(
      map((run) => {
        // **A run that is already over opens as `finished`, not as a snapshot.** A follower that
        // connects after the last case — which is every follower of a run that takes thirty
        // milliseconds — would otherwise hold a stream that will never emit anything again, while
        // its header keeps showing whatever the first fetch happened to catch. The `finished`
        // event is what tells it to re-read the stored run, and `takeWhile` closes the connection
        // on the way out.
        const over = run.status !== "queued" && run.status !== "running";
        return over
          ? { type: "finished", payload: { totals: run.totals, status: run.status } }
          : { type: "snapshot", payload: { totals: run.totals } };
      }),
    );

    return concat(snapshot, this.progress.forRun(runId)).pipe(
      map((event) => ({ type: event.type, data: event.payload })),
      // `true` is emitted with the terminal event and then the stream ends, so the last thing a
      // follower receives is the finished run and not a silent disconnection.
      takeWhile((event) => event.type !== "finished", true),
    );
  }
}
