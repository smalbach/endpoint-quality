import { Inject } from "@nestjs/common";
import { CommandHandler, type ICommand, type ICommandHandler } from "@nestjs/cqrs";

import { safeParseRequestBody } from "@eq/runner-core";

import { ConflictError, InvalidInputError, NotFoundError } from "@/shared/errors/domain-error";
import { PROJECT_REPOSITORY, type ProjectRepositoryPort } from "@/modules/projects/domain/ports";
import { ENVIRONMENT_REPOSITORY, type EnvironmentRepositoryPort } from "@/modules/environments/domain/ports";
import type { RequestPreview } from "../../domain/model";
import { REQUEST_PREVIEWER, type PreviewTemplate, type RequestPreviewerPort } from "../../domain/ports";

export type PreviewRequestInput = { environmentId: string; template: PreviewTemplate };

export class PreviewRequestCommand implements ICommand {
  constructor(
    readonly organizationId: string,
    readonly projectId: string,
    readonly input: PreviewRequestInput,
  ) {}
}

/**
 * «Enviar»: the request on screen, against a real environment, answered in the same response.
 *
 * A command and not a query, and synchronous where starting a run is not, because the two are
 * different acts. A run is a matrix somebody launches and comes back to; this is one request
 * somebody is watching, and a 202 with an id to poll would reproduce the loop it exists to
 * remove. It is bounded by the same fetch timeout every other request in the system has.
 *
 * `editor`, not `viewer`. Nothing is written here, but something is written **over there**: the
 * request reaches somebody's API and may create a row. The environment still decides whether a
 * write is allowed at all — that authority stays where it was.
 */
@CommandHandler(PreviewRequestCommand)
export class PreviewRequestHandler implements ICommandHandler<PreviewRequestCommand, RequestPreview> {
  constructor(
    @Inject(PROJECT_REPOSITORY) private readonly projects: ProjectRepositoryPort,
    @Inject(ENVIRONMENT_REPOSITORY) private readonly environments: EnvironmentRepositoryPort,
    @Inject(REQUEST_PREVIEWER) private readonly previewer: RequestPreviewerPort,
  ) {}

  async execute(command: PreviewRequestCommand): Promise<RequestPreview> {
    // The same schema a saved request goes through, applied to a request that is not being saved.
    // There is no row here to validate on the way in, and without this a `type` nobody declared
    // reaches the serialiser as a 500 about something the person in front of it typed.
    const body = safeParseRequestBody(command.input.template.body);
    if (!body.ok) throw new InvalidInputError("El cuerpo no es válido", body.issues, "request-body-invalid");

    const project = await this.projects.findById(command.projectId);
    if (!project || project.organizationId !== command.organizationId)
      throw new NotFoundError("El proyecto no existe", "project-not-found");
    if (!project.activeSpecVersionId)
      throw new ConflictError("El proyecto no tiene contrato importado", "no-active-spec");

    const environment = await this.environments.findById(command.input.environmentId);
    // Folded into the 404 as everywhere else: a 403 would confirm the id is real to somebody
    // outside the project.
    if (!environment || environment.projectId !== project.id)
      throw new NotFoundError("El entorno no existe", "environment-not-found");

    return this.previewer.preview({
      projectId: project.id,
      environmentId: environment.id,
      // The active version, not a pinned one. A run pins its snapshot because it has to stay
      // interpretable next to the contract it measured; a rehearsal is about what is true now.
      specVersionId: project.activeSpecVersionId,
      template: command.input.template,
    });
  }
}
