import { Inject } from "@nestjs/common";
import { QueryHandler, type IQuery, type IQueryHandler } from "@nestjs/cqrs";

import { ownedProject } from "@/modules/projects/application/commands/update-project";
import { PROJECT_REPOSITORY, type ProjectRepositoryPort } from "@/modules/projects/domain/ports";
import {
  ENDPOINT_REPOSITORY,
  EXAMPLE_REPOSITORY,
  type EndpointRepositoryPort,
  type ExampleRepositoryPort,
} from "@/modules/endpoints/domain/ports";
import { viewDocSite, type DocSiteView } from "../../domain/model";
import { DOC_SITE_REPOSITORY, type DocSiteRepositoryPort } from "../../domain/ports";

/**
 * Las documentaciones del proyecto, y **qué calidad tendría la página**.
 *
 * Igual que la cobertura de los mocks, y por el mismo motivo: lo que se publica no es lo que se
 * cree. «12 rutas, 3 con descripción» dice que esa página va a ser una lista de paths, y lo dice
 * antes de que alguien la mande por correo a otro equipo. La otra cifra es la de ejemplos, que es
 * lo que separa una documentación que se entiende de una que hay que adivinar.
 */
export type DocSiteListView = {
  sites: DocSiteView[];
  coverage: { endpoints: number; described: number; withExamples: number };
};

export class ListDocSitesQuery implements IQuery {
  constructor(
    readonly organizationId: string,
    readonly projectId: string,
  ) {}
}

@QueryHandler(ListDocSitesQuery)
export class ListDocSitesHandler implements IQueryHandler<ListDocSitesQuery, DocSiteListView> {
  constructor(
    @Inject(PROJECT_REPOSITORY) private readonly projects: ProjectRepositoryPort,
    @Inject(DOC_SITE_REPOSITORY) private readonly sites: DocSiteRepositoryPort,
    @Inject(ENDPOINT_REPOSITORY) private readonly endpoints: EndpointRepositoryPort,
    @Inject(EXAMPLE_REPOSITORY) private readonly examples: ExampleRepositoryPort,
  ) {}

  async execute(query: ListDocSitesQuery): Promise<DocSiteListView> {
    const project = await ownedProject(this.projects, query.organizationId, query.projectId);
    const [sites, endpoints, examples] = await Promise.all([
      this.sites.listByProject(project.id),
      this.endpoints.listAll(project.id),
      this.examples.listByProject(project.id),
    ]);
    // Solo los activos: la página tampoco enseña los archivados, así que contar con ellos daría
    // una cobertura que no se corresponde con nada.
    const active = endpoints.filter((endpoint) => endpoint.status === "active");
    const covered = new Set(examples.map((example) => example.endpointId));
    return {
      sites: sites.map(viewDocSite),
      coverage: {
        endpoints: active.length,
        described: active.filter((endpoint) => endpoint.description.trim()).length,
        withExamples: active.filter((endpoint) => covered.has(endpoint.id)).length,
      },
    };
  }
}
