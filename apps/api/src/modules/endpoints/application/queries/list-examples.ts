/**
 * Los ejemplos guardados de un endpoint.
 *
 * Salen enteros, con el cuerpo. Es lo contrario de lo que se hace con una cookie o con una variable
 * sensible, y a propósito: un ejemplo **ya** ha pasado por la redacción al guardarse, así que lo
 * que hay en la tabla no es un secreto. Enseñarlo a medias aquí obligaría a una segunda llamada
 * para leer lo único que un ejemplo tiene que decir.
 */
import { Inject } from "@nestjs/common";
import { QueryHandler, type IQuery, type IQueryHandler } from "@nestjs/cqrs";

import { NotFoundError } from "@/shared/errors/domain-error";
import { PROJECT_REPOSITORY, type ProjectRepositoryPort } from "@/modules/projects/domain/ports";
import { ownedProject } from "@/modules/projects/application/commands/update-project";
import { viewExample, type ExampleView } from "../../domain/examples";
import {
  ENDPOINT_REPOSITORY,
  EXAMPLE_REPOSITORY,
  type EndpointRepositoryPort,
  type ExampleRepositoryPort,
} from "../../domain/ports";

export class ListExamplesQuery implements IQuery {
  constructor(
    readonly organizationId: string,
    readonly projectId: string,
    readonly endpointId: string,
  ) {}
}

@QueryHandler(ListExamplesQuery)
export class ListExamplesHandler implements IQueryHandler<ListExamplesQuery, { examples: ExampleView[] }> {
  constructor(
    @Inject(PROJECT_REPOSITORY) private readonly projects: ProjectRepositoryPort,
    @Inject(ENDPOINT_REPOSITORY) private readonly endpoints: EndpointRepositoryPort,
    @Inject(EXAMPLE_REPOSITORY) private readonly examples: ExampleRepositoryPort,
  ) {}

  async execute(query: ListExamplesQuery): Promise<{ examples: ExampleView[] }> {
    const project = await ownedProject(this.projects, query.organizationId, query.projectId);
    // Se comprueba que el endpoint existe en vez de devolver una lista vacía: «no hay ejemplos» y
    // «ese endpoint no es de este proyecto» son dos respuestas distintas.
    const endpoint = await this.endpoints.findById(project.id, query.endpointId);
    if (!endpoint) throw new NotFoundError("Ese endpoint no existe", "endpoint-not-found");
    const rows = await this.examples.listByEndpoint(project.id, endpoint.id);
    return { examples: rows.map(viewExample) };
  }
}
