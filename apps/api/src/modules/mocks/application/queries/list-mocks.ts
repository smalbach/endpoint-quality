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
import type { LifecycleState } from "@/shared/lifecycle/lifecycle";
import { viewMock, type MockServerView } from "../../domain/model";
import { MOCK_REPOSITORY, type MockRepositoryPort } from "../../domain/ports";

/**
 * Los mocks del proyecto, y **cuántas rutas puede contestar cada uno**.
 *
 * Ese recuento no es adorno. Un mock es una URL que parece funcionar y contesta 501 a todo porque el
 * proyecto no tiene ningún ejemplo guardado, y eso se descubre cuando el front ya está apuntado. El
 * número lo dice antes: «4 de 12 rutas» es la única cifra que hace falta para saber si esto sirve.
 */
export type MockListView = {
  mocks: MockServerView[];
  /** Rutas del proyecto que tienen al menos un ejemplo, y rutas en total. Igual para todos los
   * mocks del proyecto: sirven los mismos ejemplos. */
  coverage: { withExamples: number; endpoints: number };
};

export class ListMocksQuery implements IQuery {
  constructor(
    readonly organizationId: string,
    readonly projectId: string,
    /** Qué lista se pide: los que sirven, los archivados o los eliminados. */
    readonly state: LifecycleState = "active",
  ) {}
}

@QueryHandler(ListMocksQuery)
export class ListMocksHandler implements IQueryHandler<ListMocksQuery, MockListView> {
  constructor(
    @Inject(PROJECT_REPOSITORY) private readonly projects: ProjectRepositoryPort,
    @Inject(MOCK_REPOSITORY) private readonly mocks: MockRepositoryPort,
    @Inject(ENDPOINT_REPOSITORY) private readonly endpoints: EndpointRepositoryPort,
    @Inject(EXAMPLE_REPOSITORY) private readonly examples: ExampleRepositoryPort,
  ) {}

  async execute(query: ListMocksQuery): Promise<MockListView> {
    const project = await ownedProject(this.projects, query.organizationId, query.projectId);
    const [mocks, endpoints, examples] = await Promise.all([
      this.mocks.listByProject(project.id, query.state),
      this.endpoints.listAll(project.id),
      this.examples.listByProject(project.id),
    ]);
    const covered = new Set(examples.map((example) => example.endpointId));
    return {
      mocks: mocks.map(viewMock),
      coverage: {
        withExamples: endpoints.filter((endpoint) => covered.has(endpoint.id)).length,
        endpoints: endpoints.length,
      },
    };
  }
}
