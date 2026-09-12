/**
 * The endpoints of a project: the analyzer's list, editor and «Send», under this API's rules.
 *
 * `viewer` reads, `editor` writes and sends — sending reaches somebody's API and may create a row
 * over there, which is a write in every sense that matters. The static routes are declared before
 * `:endpointId` so `bulk-status` is never read as an id.
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
  UploadedFile,
  UploadedFiles,
  UseGuards,
  UseInterceptors,
} from "@nestjs/common";
import { CommandBus, QueryBus } from "@nestjs/cqrs";
import { AnyFilesInterceptor, FileInterceptor } from "@nestjs/platform-express";

import { InvalidInputError } from "@/shared/errors/domain-error";
import { MAX_SPEC_BYTES } from "@/shared/http/body-limits";
import {
  CurrentUser,
  OrgRoleGuard,
  RequireRole,
  type Principal,
} from "@/modules/auth/infrastructure/guards/auth.guard";
import {
  CreateEndpointCommand,
  DeleteEndpointsCommand,
  SetEndpointStatusCommand,
  UpdateEndpointCommand,
} from "../application/commands/manage-endpoints";
import { ImportEndpointCurlCommand, ImportEndpointFileCommand } from "../application/commands/import-endpoints";
import { SendEndpointRequestCommand } from "../application/commands/send-endpoint-request";
import { GetEndpointQuery, ListEndpointsQuery } from "../application/queries/list-endpoints";
import { MAX_UPLOAD_BYTES, MAX_UPLOAD_FILES, type UploadedPart } from "../domain/send-request";
import {
  BulkDeleteEndpointsDto,
  BulkEndpointStatusDto,
  CreateEndpointDto,
  ImportEndpointCurlDto,
  ListEndpointsQueryDto,
  UpdateEndpointDto,
} from "./dto/endpoints.dto";

const actorId = (principal: Principal): string => (principal.kind === "user" ? principal.userId : principal.tokenId);

@Controller("orgs/:organizationId/projects/:projectId/endpoints")
@UseGuards(OrgRoleGuard)
export class EndpointsController {
  constructor(
    private readonly commandBus: CommandBus,
    private readonly queryBus: QueryBus,
  ) {}

  @Get()
  @RequireRole("viewer")
  async list(
    @Param("organizationId") organizationId: string,
    @Param("projectId") projectId: string,
    @Query() query: ListEndpointsQueryDto,
  ) {
    return this.queryBus.execute(new ListEndpointsQuery(organizationId, projectId, query));
  }

  @Post()
  @RequireRole("editor")
  async create(
    @Param("organizationId") organizationId: string,
    @Param("projectId") projectId: string,
    @Body() body: CreateEndpointDto,
    @CurrentUser() principal: Principal,
  ) {
    return this.commandBus.execute(new CreateEndpointCommand(organizationId, projectId, body, actorId(principal)));
  }

  @Patch("bulk-status")
  @RequireRole("editor")
  async bulkStatus(
    @Param("organizationId") organizationId: string,
    @Param("projectId") projectId: string,
    @Body() body: BulkEndpointStatusDto,
    @CurrentUser() principal: Principal,
  ) {
    return this.commandBus.execute(
      new SetEndpointStatusCommand(organizationId, projectId, body.ids, body.status, actorId(principal)),
    );
  }

  /** POST and not `DELETE` with a body, which several proxies drop. */
  @Post("bulk-delete")
  @HttpCode(200)
  @RequireRole("editor")
  async bulkDelete(
    @Param("organizationId") organizationId: string,
    @Param("projectId") projectId: string,
    @Body() body: BulkDeleteEndpointsDto,
  ) {
    return this.commandBus.execute(new DeleteEndpointsCommand(organizationId, projectId, body.ids, false));
  }

  /** Multipart, field `file`. Nothing in the file is ever sent anywhere. */
  @Post("import/file")
  @RequireRole("editor")
  @UseInterceptors(FileInterceptor("file", { limits: { fileSize: MAX_SPEC_BYTES, files: 1 } }))
  async importFile(
    @Param("organizationId") organizationId: string,
    @Param("projectId") projectId: string,
    @UploadedFile() file: UploadedPart | undefined,
    @CurrentUser() principal: Principal,
  ) {
    if (!file)
      throw new InvalidInputError(
        "Falta el fichero",
        [{ field: "file", detail: "Adjunta un fichero" }],
        "file-missing",
      );
    return this.commandBus.execute(
      new ImportEndpointFileCommand(
        organizationId,
        projectId,
        file.originalname,
        file.buffer.toString("utf8"),
        actorId(principal),
      ),
    );
  }

  @Post("import/curl")
  @RequireRole("editor")
  async importCurl(
    @Param("organizationId") organizationId: string,
    @Param("projectId") projectId: string,
    @Body() body: ImportEndpointCurlDto,
    @CurrentUser() principal: Principal,
  ) {
    return this.commandBus.execute(
      new ImportEndpointCurlCommand(organizationId, projectId, body.curl, actorId(principal)),
    );
  }

  /**
   * «Send»: multipart, a `request` part with the JSON of what is on screen and one part per file —
   * `file:<field>` for a form-data field, `binary` for a binary body. Ten files, 10 MB each.
   * 200 whatever the target answered: its status is in the body, not in this response's.
   */
  @Post("send")
  @HttpCode(200)
  @RequireRole("editor")
  @UseInterceptors(
    AnyFilesInterceptor({ limits: { files: MAX_UPLOAD_FILES, fileSize: MAX_UPLOAD_BYTES, fieldSize: MAX_SPEC_BYTES } }),
  )
  async send(
    @Param("organizationId") organizationId: string,
    @Param("projectId") projectId: string,
    @Body("request") request: string | undefined,
    @UploadedFiles() files: UploadedPart[] | undefined,
  ) {
    return this.commandBus.execute(new SendEndpointRequestCommand(organizationId, projectId, request, files ?? []));
  }

  @Get(":endpointId")
  @RequireRole("viewer")
  async get(
    @Param("organizationId") organizationId: string,
    @Param("projectId") projectId: string,
    @Param("endpointId") endpointId: string,
  ) {
    return this.queryBus.execute(new GetEndpointQuery(organizationId, projectId, endpointId));
  }

  @Patch(":endpointId")
  @RequireRole("editor")
  async update(
    @Param("organizationId") organizationId: string,
    @Param("projectId") projectId: string,
    @Param("endpointId") endpointId: string,
    @Body() body: UpdateEndpointDto,
    @CurrentUser() principal: Principal,
  ) {
    return this.commandBus.execute(
      new UpdateEndpointCommand(organizationId, projectId, endpointId, body, actorId(principal)),
    );
  }

  @Delete(":endpointId")
  @RequireRole("editor")
  @HttpCode(204)
  async remove(
    @Param("organizationId") organizationId: string,
    @Param("projectId") projectId: string,
    @Param("endpointId") endpointId: string,
  ): Promise<void> {
    await this.commandBus.execute(new DeleteEndpointsCommand(organizationId, projectId, [endpointId], true));
  }
}
