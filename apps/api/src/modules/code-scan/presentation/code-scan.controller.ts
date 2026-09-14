/**
 * Code scan: connect a repo, scan it (or an upload), read the diff, and import it.
 *
 * `viewer` reads the connector and the scans; `editor` writes the connector, runs a scan and imports
 * — a scan reaches an external repo and an import writes endpoints and roles. The token never comes
 * back out: the connector read reports only whether one is stored.
 */
import { Body, Controller, Delete, Get, HttpCode, Param, Post, Put, UseGuards } from "@nestjs/common";
import { CommandBus, QueryBus } from "@nestjs/cqrs";

import {
  CurrentUser,
  OrgRoleGuard,
  RequireRole,
  type Principal,
} from "@/modules/auth/infrastructure/guards/auth.guard";
import { DeleteConnectorCommand, SaveConnectorCommand } from "../application/commands/manage-connector";
import { ScanFromGithubCommand, ScanFromUploadCommand } from "../application/commands/scan";
import { ImportScanCommand } from "../application/commands/import-scan";
import { GetConnectorQuery, GetScanQuery, ListScansQuery } from "../application/queries/read-code-scan";
import { ImportScanDto, SaveConnectorDto, ScanUploadDto } from "./dto/code-scan.dto";

const actorId = (principal: Principal): string => (principal.kind === "user" ? principal.userId : principal.tokenId);

@Controller("orgs/:organizationId/projects/:projectId/code-scan")
@UseGuards(OrgRoleGuard)
export class CodeScanController {
  constructor(
    private readonly commandBus: CommandBus,
    private readonly queryBus: QueryBus,
  ) {}

  @Get("connector")
  @RequireRole("viewer")
  async connector(@Param("organizationId") organizationId: string, @Param("projectId") projectId: string) {
    return this.queryBus.execute(new GetConnectorQuery(organizationId, projectId));
  }

  @Put("connector")
  @RequireRole("editor")
  async saveConnector(
    @Param("organizationId") organizationId: string,
    @Param("projectId") projectId: string,
    @Body() body: SaveConnectorDto,
    @CurrentUser() principal: Principal,
  ) {
    return this.commandBus.execute(new SaveConnectorCommand(organizationId, projectId, body, actorId(principal)));
  }

  @Delete("connector")
  @RequireRole("editor")
  @HttpCode(204)
  async deleteConnector(
    @Param("organizationId") organizationId: string,
    @Param("projectId") projectId: string,
  ): Promise<void> {
    await this.commandBus.execute(new DeleteConnectorCommand(organizationId, projectId));
  }

  @Get("scans")
  @RequireRole("viewer")
  async scans(@Param("organizationId") organizationId: string, @Param("projectId") projectId: string) {
    return this.queryBus.execute(new ListScansQuery(organizationId, projectId));
  }

  @Get("scans/:scanId")
  @RequireRole("viewer")
  async scan(
    @Param("organizationId") organizationId: string,
    @Param("projectId") projectId: string,
    @Param("scanId") scanId: string,
  ) {
    return this.queryBus.execute(new GetScanQuery(organizationId, projectId, scanId));
  }

  @Post("scans")
  @RequireRole("editor")
  @HttpCode(201)
  async scanRepo(
    @Param("organizationId") organizationId: string,
    @Param("projectId") projectId: string,
    @CurrentUser() principal: Principal,
  ) {
    return this.commandBus.execute(new ScanFromGithubCommand(organizationId, projectId, actorId(principal)));
  }

  @Post("scans/upload")
  @RequireRole("editor")
  @HttpCode(201)
  async scanUpload(
    @Param("organizationId") organizationId: string,
    @Param("projectId") projectId: string,
    @Body() body: ScanUploadDto,
    @CurrentUser() principal: Principal,
  ) {
    return this.commandBus.execute(
      new ScanFromUploadCommand(organizationId, projectId, body.files, body.prefix ?? "", actorId(principal)),
    );
  }

  @Post("scans/:scanId/import")
  @RequireRole("editor")
  async importScan(
    @Param("organizationId") organizationId: string,
    @Param("projectId") projectId: string,
    @Param("scanId") scanId: string,
    @Body() body: ImportScanDto,
    @CurrentUser() principal: Principal,
  ) {
    return this.commandBus.execute(
      new ImportScanCommand(
        organizationId,
        projectId,
        scanId,
        { createRoles: Boolean(body.createRoles) },
        actorId(principal),
      ),
    );
  }
}
