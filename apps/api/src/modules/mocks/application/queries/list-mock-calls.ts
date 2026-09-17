/**
 * Las últimas llamadas que ha contestado un mock.
 *
 * Autenticada y bajo el proyecto, con las mismas guardas que el resto de mocks: la bitácora dice qué
 * rutas pide el front de alguien y a qué hora, y eso es de los del proyecto. Que la URL servida sea
 * pública no hace pública su bitácora.
 */
import { Inject } from "@nestjs/common";
import { QueryHandler, type IQuery, type IQueryHandler } from "@nestjs/cqrs";

import { ownedProject } from "@/modules/projects/application/commands/update-project";
import { PROJECT_REPOSITORY, type ProjectRepositoryPort } from "@/modules/projects/domain/ports";
import { NotFoundError } from "@/shared/errors/domain-error";
import { MOCK_CALL_HISTORY, viewMockCall, type MockCallView } from "../../domain/mock-call";
import { MOCK_REPOSITORY, type MockRepositoryPort } from "../../domain/ports";

/** Las llamadas, de la más reciente a la más vieja, y el tope que hay guardado. */
export type MockCallListView = {
  calls: MockCallView[];
  /** Cuántas se guardan por mock, para que la pantalla pueda decir que lo de antes se ha ido. */
  keep: number;
};

export class ListMockCallsQuery implements IQuery {
  constructor(
    readonly organizationId: string,
    readonly projectId: string,
    readonly mockId: string,
  ) {}
}

@QueryHandler(ListMockCallsQuery)
export class ListMockCallsHandler implements IQueryHandler<ListMockCallsQuery, MockCallListView> {
  constructor(
    @Inject(PROJECT_REPOSITORY) private readonly projects: ProjectRepositoryPort,
    @Inject(MOCK_REPOSITORY) private readonly mocks: MockRepositoryPort,
  ) {}

  async execute(query: ListMockCallsQuery): Promise<MockCallListView> {
    const project = await ownedProject(this.projects, query.organizationId, query.projectId);
    // Por el proyecto y no por el id suelto: la bitácora se pide por el mock, y un mock de otro
    // proyecto no existe para quien pregunta desde aquí.
    const mock = await this.mocks.findById(project.id, query.mockId);
    if (!mock) throw new NotFoundError("Ese mock no existe", "mock-not-found");
    return {
      calls: (await this.mocks.listCalls(mock.id, MOCK_CALL_HISTORY)).map(viewMockCall),
      keep: MOCK_CALL_HISTORY,
    };
  }
}
