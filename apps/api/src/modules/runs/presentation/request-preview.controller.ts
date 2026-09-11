/**
 * «Enviar»: one request, now, answered in the same response.
 *
 * Its own controller and not another route under `/runs`, because it is not one. A run is queued,
 * recorded and followed; this is sent, judged and forgotten. Filing it under runs would mean
 * every reader of the runs API had to learn which of its routes leaves a row behind.
 *
 * Deliberately **not** `@SkipThrottle()`. The two routes that skip the limiter are reads of a
 * finished run; this one sends real traffic to somebody's API, and the default limit is what
 * keeps a held-down button from turning the editor into a load generator.
 */
import { Body, Controller, HttpCode, Param, Post, UseGuards } from "@nestjs/common";
import { CommandBus } from "@nestjs/cqrs";

import { OrgRoleGuard, RequireRole } from "@/modules/auth/infrastructure/guards/auth.guard";
import { PreviewRequestCommand } from "../application/commands/preview-request";
import { PreviewRequestDto } from "./dto/runs.dto";

@Controller("orgs/:organizationId/projects/:projectId/request-preview")
@UseGuards(OrgRoleGuard)
export class RequestPreviewController {
  constructor(private readonly commandBus: CommandBus) {}

  /**
   * 200 and the outcome. Not 201: nothing was created here, whatever the target may have created
   * on its side — and that is the target's answer to report, not this API's status code.
   */
  @Post()
  @HttpCode(200)
  @RequireRole("editor")
  async send(
    @Param("organizationId") organizationId: string,
    @Param("projectId") projectId: string,
    @Body() body: PreviewRequestDto,
  ) {
    return this.commandBus.execute(
      new PreviewRequestCommand(organizationId, projectId, {
        environmentId: body.environmentId,
        template: {
          name: body.name ?? "Petición de prueba",
          operationId: body.operationId,
          expectedStatus: body.expectedStatus,
          parameters: body.parameters ?? {},
          headers: body.headers ?? {},
          body: body.body ?? { type: "none" },
          auth: body.auth ?? "default",
        },
      }),
    );
  }
}
