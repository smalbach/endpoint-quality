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
import { Body, Controller, Get, HttpCode, Param, Post, Query, Sse, UseGuards } from "@nestjs/common";
import { CommandBus, QueryBus } from "@nestjs/cqrs";
import { Observable, filter, map, merge, startWith, takeWhile } from "rxjs";

import { CurrentUser, OrgRoleGuard, RequireRole, type Principal } from "@/modules/auth/infrastructure/guards/auth.guard";
import { StartRunCommand } from "../application/commands/start-run";
import { CancelRunCommand } from "../application/commands/cancel-run";
import { GetRunCaseQuery, GetRunQuery, ListRunsQuery } from "../application/queries/get-run";
import { RunProgressStream } from "../infrastructure/run-progress.stream";
import { StartRunDto } from "./dto/runs.dto";

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
  async list(@Param("organizationId") organizationId: string, @Param("projectId") projectId: string, @Query("limit") limit?: string) {
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
    const triggeredBy = principal.kind === "user" ? { kind: "user" as const, id: principal.userId } : { kind: "api-token" as const, id: principal.tokenId };
    return this.commandBus.execute(new StartRunCommand(organizationId, projectId, body, triggeredBy));
  }

  @Get(":runId")
  @RequireRole("viewer")
  async get(@Param("organizationId") organizationId: string, @Param("projectId") projectId: string, @Param("runId") runId: string) {
    return this.queryBus.execute(new GetRunQuery(organizationId, projectId, runId));
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
  @RequireRole("viewer")
  stream(
    @Param("organizationId") organizationId: string,
    @Param("projectId") projectId: string,
    @Param("runId") runId: string,
  ): Observable<{ data: unknown; type: string }> {
    const snapshot = this.queryBus.execute(new GetRunQuery(organizationId, projectId, runId));
    return merge(this.progress.forRun(runId)).pipe(
      startWith({ type: "snapshot", payload: snapshot }),
      map((event) => ({ type: event.type, data: event.payload })),
      filter((event) => Boolean(event.data)),
      // `true` is emitted with the terminal event and then the stream ends, so the last thing a
      // follower receives is the finished run and not a silent disconnection.
      takeWhile((event) => event.type !== "finished", true),
    );
  }
}
