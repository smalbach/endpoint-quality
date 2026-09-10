/**
 * Reusable requests, and the flows composed from them.
 *
 * **Everything here is `editor`, nothing is `admin`.** The ladder reserves `admin` for the two
 * acts that can damage something outside this system: storing somebody's staging credential, and
 * the switch that lets a run write to a target. A flow is inert — it can only run against an
 * environment whose `writesAllowed` an admin already decided — and composing cases is the
 * editor's daily work, the same as curating the matrix.
 */
import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Put, UseGuards } from "@nestjs/common";
import { CommandBus, QueryBus } from "@nestjs/cqrs";

import {
  CurrentUser,
  OrgRoleGuard,
  RequireRole,
  type Principal,
} from "@/modules/auth/infrastructure/guards/auth.guard";
import {
  CreateRequestTemplateCommand,
  DeleteRequestTemplateCommand,
  UpdateRequestTemplateCommand,
} from "../application/commands/manage-request-template";
import {
  CreateWorkflowCommand,
  DeleteWorkflowCommand,
  UpdateWorkflowCommand,
} from "../application/commands/manage-workflow";
import { ListWorkflowsQuery } from "../application/queries/list-workflows";
import {
  CreateRequestTemplateDto,
  CreateWorkflowDto,
  UpdateRequestTemplateDto,
  UpdateWorkflowDto,
} from "./dto/workflows.dto";

const actorId = (principal: Principal): string => (principal.kind === "user" ? principal.userId : principal.tokenId);

@Controller("orgs/:organizationId/projects/:projectId")
@UseGuards(OrgRoleGuard)
export class WorkflowsController {
  constructor(
    private readonly commandBus: CommandBus,
    private readonly queryBus: QueryBus,
  ) {}

  /** Both lists in one answer: a node cannot be drawn without the request its step names. */
  @Get("workflows")
  @RequireRole("viewer")
  async list(@Param("organizationId") organizationId: string, @Param("projectId") projectId: string) {
    return this.queryBus.execute(new ListWorkflowsQuery(organizationId, projectId));
  }

  @Post("request-templates")
  @RequireRole("editor")
  async createTemplate(
    @Param("organizationId") organizationId: string,
    @Param("projectId") projectId: string,
    @Body() body: CreateRequestTemplateDto,
    @CurrentUser() principal: Principal,
  ) {
    return this.commandBus.execute(
      new CreateRequestTemplateCommand(organizationId, projectId, body, actorId(principal)),
    );
  }

  @Patch("request-templates/:templateId")
  @RequireRole("editor")
  @HttpCode(204)
  async updateTemplate(
    @Param("organizationId") organizationId: string,
    @Param("projectId") projectId: string,
    @Param("templateId") templateId: string,
    @Body() body: UpdateRequestTemplateDto,
    @CurrentUser() principal: Principal,
  ): Promise<void> {
    await this.commandBus.execute(
      new UpdateRequestTemplateCommand(organizationId, projectId, templateId, body, actorId(principal)),
    );
  }

  /** 409 when a flow still names it. A dangling step would only be discovered mid-run. */
  @Delete("request-templates/:templateId")
  @RequireRole("editor")
  @HttpCode(204)
  async deleteTemplate(
    @Param("organizationId") organizationId: string,
    @Param("projectId") projectId: string,
    @Param("templateId") templateId: string,
  ): Promise<void> {
    await this.commandBus.execute(new DeleteRequestTemplateCommand(organizationId, projectId, templateId));
  }

  @Post("workflows")
  @RequireRole("editor")
  async createWorkflow(
    @Param("organizationId") organizationId: string,
    @Param("projectId") projectId: string,
    @Body() body: CreateWorkflowDto,
    @CurrentUser() principal: Principal,
  ) {
    return this.commandBus.execute(new CreateWorkflowCommand(organizationId, projectId, body, actorId(principal)));
  }

  /** `PUT` and not `PATCH` for the graph: it is written whole or not at all. */
  @Put("workflows/:workflowId")
  @RequireRole("editor")
  @HttpCode(204)
  async updateWorkflow(
    @Param("organizationId") organizationId: string,
    @Param("projectId") projectId: string,
    @Param("workflowId") workflowId: string,
    @Body() body: UpdateWorkflowDto,
    @CurrentUser() principal: Principal,
  ): Promise<void> {
    await this.commandBus.execute(
      new UpdateWorkflowCommand(organizationId, projectId, workflowId, body, actorId(principal)),
    );
  }

  @Delete("workflows/:workflowId")
  @RequireRole("editor")
  @HttpCode(204)
  async deleteWorkflow(
    @Param("organizationId") organizationId: string,
    @Param("projectId") projectId: string,
    @Param("workflowId") workflowId: string,
  ): Promise<void> {
    await this.commandBus.execute(new DeleteWorkflowCommand(organizationId, projectId, workflowId));
  }
}
