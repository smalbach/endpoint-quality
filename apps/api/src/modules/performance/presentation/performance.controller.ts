/**
 * Performance: plans somebody edits, and the runs of them.
 *
 * `viewer` reads; `editor` writes a plan, launches and cancels a run — a load test reaches somebody's
 * API and pushes real traffic at it. Runs use the environment's stored variables and credentials;
 * no per-request secret ever travels in a body here.
 */
import { Body, Controller, Delete, Get, HttpCode, Param, Post, Put, Query, UseGuards } from "@nestjs/common";
import { CommandBus, QueryBus } from "@nestjs/cqrs";
import { concat, from, map, takeWhile, type Observable } from "rxjs";
import { Sse } from "@nestjs/common";

import {
  CurrentUser,
  OrgRoleGuard,
  RequireRole,
  type Principal,
} from "@/modules/auth/infrastructure/guards/auth.guard";
import { CreatePlanCommand, DeletePlanCommand, UpdatePlanCommand } from "../application/commands/manage-plan";
import { CancelRunCommand, DeleteRunCommand, StartRunCommand } from "../application/commands/manage-run";
import {
  CompareRunsQuery,
  GetPlanQuery,
  GetRunQuery,
  ListPlansQuery,
  ListRunsQuery,
} from "../application/queries/read-performance";
import { PerformanceProgressStream } from "../infrastructure/performance-progress.stream";
import { CreatePlanDto, StartPerformanceRunDto, UpdatePlanDto } from "./dto/performance.dto";

const actorId = (principal: Principal): string => (principal.kind === "user" ? principal.userId : principal.tokenId);

@Controller("orgs/:organizationId/projects/:projectId/performance")
@UseGuards(OrgRoleGuard)
export class PerformanceController {
  constructor(
    private readonly commandBus: CommandBus,
    private readonly queryBus: QueryBus,
    private readonly progress: PerformanceProgressStream,
  ) {}

  // ----- Plans -----

  @Get("plans")
  @RequireRole("viewer")
  async listPlans(@Param("organizationId") organizationId: string, @Param("projectId") projectId: string) {
    return this.queryBus.execute(new ListPlansQuery(organizationId, projectId));
  }

  @Get("plans/:planId")
  @RequireRole("viewer")
  async getPlan(
    @Param("organizationId") organizationId: string,
    @Param("projectId") projectId: string,
    @Param("planId") planId: string,
  ) {
    return this.queryBus.execute(new GetPlanQuery(organizationId, projectId, planId));
  }

  @Post("plans")
  @RequireRole("editor")
  async createPlan(
    @Param("organizationId") organizationId: string,
    @Param("projectId") projectId: string,
    @Body() body: CreatePlanDto,
    @CurrentUser() principal: Principal,
  ) {
    return this.commandBus.execute(new CreatePlanCommand(organizationId, projectId, body, actorId(principal)));
  }

  @Put("plans/:planId")
  @RequireRole("editor")
  @HttpCode(204)
  async updatePlan(
    @Param("organizationId") organizationId: string,
    @Param("projectId") projectId: string,
    @Param("planId") planId: string,
    @Body() body: UpdatePlanDto,
    @CurrentUser() principal: Principal,
  ): Promise<void> {
    await this.commandBus.execute(new UpdatePlanCommand(organizationId, projectId, planId, body, actorId(principal)));
  }

  @Delete("plans/:planId")
  @RequireRole("editor")
  @HttpCode(204)
  async deletePlan(
    @Param("organizationId") organizationId: string,
    @Param("projectId") projectId: string,
    @Param("planId") planId: string,
  ): Promise<void> {
    await this.commandBus.execute(new DeletePlanCommand(organizationId, projectId, planId));
  }

  // ----- Runs -----

  @Get("runs")
  @RequireRole("viewer")
  async listRuns(
    @Param("organizationId") organizationId: string,
    @Param("projectId") projectId: string,
    @Query("planId") planId?: string,
  ) {
    return this.queryBus.execute(new ListRunsQuery(organizationId, projectId, planId || undefined));
  }

  @Get("compare")
  @RequireRole("viewer")
  async compareRuns(
    @Param("organizationId") organizationId: string,
    @Param("projectId") projectId: string,
    @Query("base") base: string,
    @Query("target") target: string,
  ) {
    return this.queryBus.execute(new CompareRunsQuery(organizationId, projectId, base, target));
  }

  @Get("runs/:runId")
  @RequireRole("viewer")
  async getRun(
    @Param("organizationId") organizationId: string,
    @Param("projectId") projectId: string,
    @Param("runId") runId: string,
  ) {
    return this.queryBus.execute(new GetRunQuery(organizationId, projectId, runId));
  }

  @Post("plans/:planId/runs")
  @RequireRole("editor")
  @HttpCode(202)
  async startRun(
    @Param("organizationId") organizationId: string,
    @Param("projectId") projectId: string,
    @Param("planId") planId: string,
    @Body() body: StartPerformanceRunDto,
  ) {
    return this.commandBus.execute(new StartRunCommand(organizationId, projectId, planId, body.environmentId));
  }

  @Post("runs/:runId/cancel")
  @RequireRole("editor")
  @HttpCode(204)
  async cancelRun(
    @Param("organizationId") organizationId: string,
    @Param("projectId") projectId: string,
    @Param("runId") runId: string,
  ): Promise<void> {
    await this.commandBus.execute(new CancelRunCommand(organizationId, projectId, runId));
  }

  @Delete("runs/:runId")
  @RequireRole("editor")
  @HttpCode(204)
  async deleteRun(
    @Param("organizationId") organizationId: string,
    @Param("projectId") projectId: string,
    @Param("runId") runId: string,
  ): Promise<void> {
    await this.commandBus.execute(new DeleteRunCommand(organizationId, projectId, runId));
  }

  /** Live progress: current state, then the stream, then completes on finish. */
  @Sse("runs/:runId/stream")
  @RequireRole("viewer")
  stream(
    @Param("organizationId") organizationId: string,
    @Param("projectId") projectId: string,
    @Param("runId") runId: string,
  ): Observable<{ data: unknown; type: string }> {
    const snapshot = from(this.queryBus.execute(new GetRunQuery(organizationId, projectId, runId))).pipe(
      map((run: unknown) => {
        const detail = run as { status: string; progress: unknown };
        return {
          type: detail.status === "queued" || detail.status === "running" ? "progress" : "finished",
          data: { runId, status: detail.status, progress: detail.progress },
        };
      }),
    );
    return concat(snapshot, this.progress.forRun(runId)).pipe(takeWhile((event) => event.type !== "finished", true));
  }
}
