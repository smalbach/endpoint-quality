/**
 * Los mocks de un proyecto: crear, listar, cambiar, rotar la clave y borrar.
 *
 * `viewer` lista —saber qué URLs públicas tiene un proyecto es parte de mirarlo— y `editor` hace
 * todo lo demás. Crear un mock público es publicar datos del proyecto, así que no es una lectura.
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
  CreateMockCommand,
  DeleteMockCommand,
  RotateMockKeyCommand,
  UpdateMockCommand,
} from "../application/commands/manage-mocks";
import { ListMocksQuery } from "../application/queries/list-mocks";
import { MOCK_PATH_PREFIX } from "../domain/model";
import { CreateMockDto, UpdateMockDto } from "./dto/mocks.dto";

const actorId = (principal: Principal): string => (principal.kind === "user" ? principal.userId : principal.tokenId);

@Controller("orgs/:organizationId/projects/:projectId/mocks")
@UseGuards(OrgRoleGuard)
export class MocksController {
  constructor(
    private readonly commandBus: CommandBus,
    private readonly queryBus: QueryBus,
  ) {}

  @Get()
  @RequireRole("viewer")
  async list(@Param("organizationId") organizationId: string, @Param("projectId") projectId: string) {
    const list = await this.queryBus.execute(new ListMocksQuery(organizationId, projectId));
    // El prefijo sale del servidor y no se compone en el navegador: la URL que hay que pegar en un
    // front la decide quien sirve el mock, y si algún día cambia el sitio, cambia en uno.
    return { ...list, prefix: `/${MOCK_PATH_PREFIX}` };
  }

  @Post()
  @RequireRole("editor")
  async create(
    @Param("organizationId") organizationId: string,
    @Param("projectId") projectId: string,
    @Body() body: CreateMockDto,
    @CurrentUser() principal: Principal,
  ) {
    return this.commandBus.execute(
      new CreateMockCommand(organizationId, projectId, body.name, body.visibility, body.delay, actorId(principal)),
    );
  }

  @Patch(":mockId")
  @RequireRole("editor")
  async update(
    @Param("organizationId") organizationId: string,
    @Param("projectId") projectId: string,
    @Param("mockId") mockId: string,
    @Body() body: UpdateMockDto,
  ) {
    return this.commandBus.execute(new UpdateMockCommand(organizationId, projectId, mockId, body));
  }

  @Post(":mockId/key")
  @RequireRole("editor")
  async rotate(
    @Param("organizationId") organizationId: string,
    @Param("projectId") projectId: string,
    @Param("mockId") mockId: string,
  ) {
    return this.commandBus.execute(new RotateMockKeyCommand(organizationId, projectId, mockId));
  }

  @Delete(":mockId")
  @RequireRole("editor")
  @HttpCode(204)
  async remove(
    @Param("organizationId") organizationId: string,
    @Param("projectId") projectId: string,
    @Param("mockId") mockId: string,
  ) {
    await this.commandBus.execute(new DeleteMockCommand(organizationId, projectId, mockId));
  }
}
