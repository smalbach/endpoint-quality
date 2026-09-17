/**
 * Las documentaciones publicadas de un proyecto: crear, listar, cambiar, rotar la clave y borrar.
 *
 * `viewer` lista —saber qué URLs públicas tiene un proyecto es parte de mirarlo— y `editor` hace
 * todo lo demás. Publicar la API de un proyecto no es una lectura.
 */
import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, UseGuards } from "@nestjs/common";
import { CommandBus, QueryBus } from "@nestjs/cqrs";

import {
  CurrentUser,
  OrgRoleGuard,
  RequireRole,
  type Principal,
} from "@/modules/auth/infrastructure/guards/auth.guard";
import {
  CreateDocSiteCommand,
  DeleteDocSiteCommand,
  RotateDocSiteKeyCommand,
  UpdateDocSiteCommand,
} from "../application/commands/manage-doc-sites";
import { ListDocSitesQuery } from "../application/queries/list-doc-sites";
import { DOC_PATH_PREFIX } from "../domain/model";
import { CreateDocSiteDto, UpdateDocSiteDto } from "./dto/doc-sites.dto";

const actorId = (principal: Principal): string => (principal.kind === "user" ? principal.userId : principal.tokenId);

@Controller("orgs/:organizationId/projects/:projectId/doc-sites")
@UseGuards(OrgRoleGuard)
export class DocSitesController {
  constructor(
    private readonly commandBus: CommandBus,
    private readonly queryBus: QueryBus,
  ) {}

  @Get()
  @RequireRole("viewer")
  async list(@Param("organizationId") organizationId: string, @Param("projectId") projectId: string) {
    const list = await this.queryBus.execute(new ListDocSitesQuery(organizationId, projectId));
    // El prefijo sale del servidor. Y es el del **navegador**, no el de la API: la dirección que se
    // le manda a una persona es la de la página, y la de `/shared/docs/...` es la que consume una
    // máquina. Componerlas en la pantalla sería tener el sitio escrito en dos lados.
    return { ...list, prefix: `/${DOC_PATH_PREFIX}` };
  }

  @Post()
  @RequireRole("editor")
  async create(
    @Param("organizationId") organizationId: string,
    @Param("projectId") projectId: string,
    @Body() body: CreateDocSiteDto,
    @CurrentUser() principal: Principal,
  ) {
    return this.commandBus.execute(
      new CreateDocSiteCommand(
        organizationId,
        projectId,
        body.name,
        body.visibility,
        { baseUrl: body.baseUrl, intro: body.intro, includeExamples: body.includeExamples },
        actorId(principal),
      ),
    );
  }

  @Patch(":siteId")
  @RequireRole("editor")
  async update(
    @Param("organizationId") organizationId: string,
    @Param("projectId") projectId: string,
    @Param("siteId") siteId: string,
    @Body() body: UpdateDocSiteDto,
  ) {
    return this.commandBus.execute(new UpdateDocSiteCommand(organizationId, projectId, siteId, body));
  }

  @Post(":siteId/key")
  @RequireRole("editor")
  async rotate(
    @Param("organizationId") organizationId: string,
    @Param("projectId") projectId: string,
    @Param("siteId") siteId: string,
  ) {
    return this.commandBus.execute(new RotateDocSiteKeyCommand(organizationId, projectId, siteId));
  }

  @Delete(":siteId")
  @RequireRole("editor")
  @HttpCode(204)
  async remove(
    @Param("organizationId") organizationId: string,
    @Param("projectId") projectId: string,
    @Param("siteId") siteId: string,
  ) {
    await this.commandBus.execute(new DeleteDocSiteCommand(organizationId, projectId, siteId));
  }
}
