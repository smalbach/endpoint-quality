/**
 * Security runs: launching one, watching it, reading it, and sharing it.
 *
 * `viewer` reads, `editor` launches and cancels — a run reaches somebody's API and may create rows
 * over there. Deleting is `editor` too; only the public read stands outside the org guard, gated by
 * a share token instead. There is no per-endpoint credential in any request: the run uses what the
 * environment stored.
 */
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
  Res,
  Sse,
  UseGuards,
} from "@nestjs/common";
import type { Response } from "express";
import { CommandBus, QueryBus } from "@nestjs/cqrs";
import { concat, from, map, takeWhile, type Observable } from "rxjs";

import {
  CurrentUser,
  OrgRoleGuard,
  Public,
  RequireRole,
  type Principal,
} from "@/modules/auth/infrastructure/guards/auth.guard";
import type { Severity } from "@eq/security-rules";
import {
  CancelSecurityRunCommand,
  DeleteSecurityRunCommand,
  SetSecurityRunVisibilityCommand,
  StartSecurityRunCommand,
} from "../application/commands/manage-security-run";
import {
  GetSecurityRunQuery,
  GetSharedSecurityRunQuery,
  ListSecurityRunsQuery,
  type SecurityRunDetailView,
  type SecurityRunFilters,
} from "../application/queries/get-security-run";
import { GetSecurityReportQuery, GetSharedSecurityReportQuery } from "../application/queries/get-security-report";
import { AnalyzeSecurityRunCommand } from "../application/commands/analyze-security-run";
import { securityReportFormat } from "./report";
import { SecurityRunProgressStream } from "../infrastructure/security-run-progress.stream";
import { SecurityRunVisibilityDto, StartSecurityRunDto } from "./dto/security-runs.dto";

function filtersOf(query: Record<string, string | undefined>): SecurityRunFilters {
  return {
    severity: query.severity as Severity | undefined,
    ruleKey: query.ruleKey,
    endpointId: query.endpointId,
    method: query.method?.toUpperCase(),
    statusFamily: query.statusFamily ? Number(query.statusFamily) : undefined,
    testType: query.testType,
    page: Number(query.page) || 1,
    pageSize: Number(query.pageSize) || 50,
  };
}

@Controller()
export class SecurityRunsController {
  constructor(
    private readonly commandBus: CommandBus,
    private readonly queryBus: QueryBus,
    private readonly progress: SecurityRunProgressStream,
  ) {}

  @Get("orgs/:organizationId/projects/:projectId/security-runs")
  @UseGuards(OrgRoleGuard)
  @RequireRole("viewer")
  async list(
    @Param("organizationId") organizationId: string,
    @Param("projectId") projectId: string,
    @Query("limit") limit?: string,
  ) {
    return this.queryBus.execute(new ListSecurityRunsQuery(organizationId, projectId, Number(limit) || 25));
  }

  @Post("orgs/:organizationId/projects/:projectId/security-runs")
  @UseGuards(OrgRoleGuard)
  @RequireRole("editor")
  @HttpCode(202)
  async start(
    @Param("organizationId") organizationId: string,
    @Param("projectId") projectId: string,
    @Body() body: StartSecurityRunDto,
    @CurrentUser() principal: Principal,
  ) {
    const triggeredBy =
      principal.kind === "user"
        ? { kind: "user" as const, id: principal.userId }
        : { kind: "api-token" as const, id: principal.tokenId };
    return this.commandBus.execute(new StartSecurityRunCommand(organizationId, projectId, body, triggeredBy));
  }

  @Get("orgs/:organizationId/projects/:projectId/security-runs/:runId")
  @UseGuards(OrgRoleGuard)
  @RequireRole("viewer")
  async get(
    @Param("organizationId") organizationId: string,
    @Param("projectId") projectId: string,
    @Param("runId") runId: string,
    @Query() query: Record<string, string | undefined>,
  ): Promise<SecurityRunDetailView> {
    return this.queryBus.execute(new GetSecurityRunQuery(organizationId, projectId, runId, filtersOf(query)));
  }

  @Post("orgs/:organizationId/projects/:projectId/security-runs/:runId/cancel")
  @UseGuards(OrgRoleGuard)
  @RequireRole("editor")
  @HttpCode(204)
  async cancel(
    @Param("organizationId") organizationId: string,
    @Param("projectId") projectId: string,
    @Param("runId") runId: string,
  ): Promise<void> {
    await this.commandBus.execute(new CancelSecurityRunCommand(organizationId, projectId, runId));
  }

  @Delete("orgs/:organizationId/projects/:projectId/security-runs/:runId")
  @UseGuards(OrgRoleGuard)
  @RequireRole("editor")
  @HttpCode(204)
  async remove(
    @Param("organizationId") organizationId: string,
    @Param("projectId") projectId: string,
    @Param("runId") runId: string,
  ): Promise<void> {
    await this.commandBus.execute(new DeleteSecurityRunCommand(organizationId, projectId, runId));
  }

  @Patch("orgs/:organizationId/projects/:projectId/security-runs/:runId/visibility")
  @UseGuards(OrgRoleGuard)
  @RequireRole("editor")
  async setVisibility(
    @Param("organizationId") organizationId: string,
    @Param("projectId") projectId: string,
    @Param("runId") runId: string,
    @Body() body: SecurityRunVisibilityDto,
  ) {
    return this.commandBus.execute(
      new SetSecurityRunVisibilityCommand(organizationId, projectId, runId, body.visibility),
    );
  }

  /** Live progress. Opens with the run's current state, then streams, then completes on finish. */
  @Sse("orgs/:organizationId/projects/:projectId/security-runs/:runId/stream")
  @UseGuards(OrgRoleGuard)
  @RequireRole("viewer")
  stream(
    @Param("organizationId") organizationId: string,
    @Param("projectId") projectId: string,
    @Param("runId") runId: string,
  ): Observable<{ data: unknown; type: string }> {
    const snapshot = from(
      this.queryBus.execute<GetSecurityRunQuery, SecurityRunDetailView>(
        new GetSecurityRunQuery(organizationId, projectId, runId, { page: 1, pageSize: 1 }),
      ),
    ).pipe(
      map((run) => ({
        type: run.status === "queued" || run.status === "running" ? "progress" : "finished",
        data: { runId, status: run.status, progress: run.progress, score: run.score, risk: run.risk },
      })),
    );
    return concat(snapshot, this.progress.forRun(runId)).pipe(takeWhile((event) => event.type !== "finished", true));
  }

  @Post("orgs/:organizationId/projects/:projectId/security-runs/:runId/ai")
  @UseGuards(OrgRoleGuard)
  @RequireRole("editor")
  async analyze(
    @Param("organizationId") organizationId: string,
    @Param("projectId") projectId: string,
    @Param("runId") runId: string,
  ) {
    return this.commandBus.execute(new AnalyzeSecurityRunCommand(organizationId, projectId, runId));
  }

  /** The run as a report: JSON, or a print-ready HTML page the reader saves as PDF. */
  @Get("orgs/:organizationId/projects/:projectId/security-runs/:runId/report")
  @UseGuards(OrgRoleGuard)
  @RequireRole("viewer")
  async report(
    @Param("organizationId") organizationId: string,
    @Param("projectId") projectId: string,
    @Param("runId") runId: string,
    @Query("format") format: string | undefined,
    @Res({ passthrough: true }) response: Response,
  ) {
    const chosen = securityReportFormat(format);
    const result = await this.queryBus.execute<GetSecurityReportQuery, { contentType: string; body: string | unknown }>(
      new GetSecurityReportQuery(organizationId, projectId, runId, chosen),
    );
    if (chosen === "json") return result.body;
    response.type(result.contentType);
    response.header("Content-Disposition", `inline; filename="seguridad-${runId}.html"`);
    return result.body;
  }

  @Get("shared/security-runs/:shareToken/report")
  @Public()
  async sharedReport(
    @Param("shareToken") shareToken: string,
    @Query("format") format: string | undefined,
    @Res({ passthrough: true }) response: Response,
  ) {
    const chosen = securityReportFormat(format);
    const result = await this.queryBus.execute<
      GetSharedSecurityReportQuery,
      { contentType: string; body: string | unknown }
    >(new GetSharedSecurityReportQuery(shareToken, chosen));
    if (chosen === "json") return result.body;
    response.type(result.contentType);
    return result.body;
  }

  /** The public read of a shared run: no session, gated by the token. */
  @Get("shared/security-runs/:shareToken")
  @Public()
  async shared(
    @Param("shareToken") shareToken: string,
    @Query() query: Record<string, string | undefined>,
  ): Promise<SecurityRunDetailView> {
    return this.queryBus.execute(new GetSharedSecurityRunQuery(shareToken, filtersOf(query)));
  }
}
