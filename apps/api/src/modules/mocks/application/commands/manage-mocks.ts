/**
 * Crear, cambiar, rotar la clave y borrar servidores de mocks.
 *
 * Crear devuelve **la clave en claro una vez** cuando el mock es privado, y nunca más: de ella se
 * guarda el hash. Es el mismo trato que los tokens de API de este producto, y por la misma razón —
 * lo que no está guardado no se puede filtrar.
 *
 * Cambiar la visibilidad de privado a público **no borra la clave**: la deja de pedir. Volver a
 * privado sigue pidiendo la de siempre. Generar una nueva en cada vuelta invalidaría en silencio a
 * todo el que la tenía, y hacer pública una URL ya es bastante para una sola decisión.
 */
import { Inject } from "@nestjs/common";
import { CommandHandler, type ICommand, type ICommandHandler } from "@nestjs/cqrs";

import { CLOCK, type ClockPort } from "@/shared/clock/clock.port";
import { ConflictError, InvalidInputError, NotFoundError } from "@/shared/errors/domain-error";
import { PROJECT_REPOSITORY, type ProjectRepositoryPort } from "@/modules/projects/domain/ports";
import { writableProject } from "@/modules/endpoints/application/commands/manage-endpoints";
import {
  MAX_MOCKS_PER_PROJECT,
  blankMock,
  mockProblems,
  rotatedKey,
  viewMock,
  type MockDelay,
  type MockServerView,
  type MockVisibility,
} from "../../domain/model";
import { MOCK_REPOSITORY, type MockRepositoryPort } from "../../domain/ports";

/** Lo que devuelve crear o rotar: el mock y, una sola vez, la clave. */
export type IssuedMock = { mock: MockServerView; apiKey: string | null };

export class CreateMockCommand implements ICommand {
  constructor(
    readonly organizationId: string,
    readonly projectId: string,
    readonly name: string,
    /** Sin valor por defecto: publicar los ejemplos de un proyecto es una decisión, no una omisión. */
    readonly visibility: MockVisibility,
    readonly delay: MockDelay | undefined,
    readonly actorId: string,
  ) {}
}

@CommandHandler(CreateMockCommand)
export class CreateMockHandler implements ICommandHandler<CreateMockCommand, IssuedMock> {
  constructor(
    @Inject(PROJECT_REPOSITORY) private readonly projects: ProjectRepositoryPort,
    @Inject(MOCK_REPOSITORY) private readonly mocks: MockRepositoryPort,
    @Inject(CLOCK) private readonly clock: ClockPort,
  ) {}

  async execute(command: CreateMockCommand): Promise<IssuedMock> {
    const project = await writableProject(this.projects, command.organizationId, command.projectId);
    const problems = mockProblems(
      { name: command.name, visibility: command.visibility, delay: command.delay },
      { requireVisibility: true },
    );
    if (problems.length) throw new InvalidInputError("El mock no es válido", problems);

    const existing = await this.mocks.listByProject(project.id);
    if (existing.length >= MAX_MOCKS_PER_PROJECT) {
      throw new ConflictError(
        `Este proyecto ya tiene ${MAX_MOCKS_PER_PROJECT} mocks: borra alguno antes de crear otro`,
        "mocks-full",
      );
    }
    if (existing.some((row) => row.name === command.name.trim()))
      throw new ConflictError(`Ya hay un mock llamado «${command.name.trim()}»`, "mock-duplicate-name");

    const created = blankMock({
      projectId: project.id,
      name: command.name.trim(),
      visibility: command.visibility,
      delay: command.delay,
      now: this.clock.now(),
      actorId: command.actorId,
    });
    await this.mocks.save(created.mock);
    return { mock: viewMock(created.mock), apiKey: created.apiKey };
  }
}

/** Lo mismo más la clave, cuando pasar a privado ha tenido que crear una. */
export type UpdatedMock = MockServerView & { apiKey?: string };

export class UpdateMockCommand implements ICommand {
  constructor(
    readonly organizationId: string,
    readonly projectId: string,
    readonly mockId: string,
    readonly input: { name?: string; visibility?: MockVisibility; delay?: MockDelay; enabled?: boolean },
  ) {}
}

@CommandHandler(UpdateMockCommand)
export class UpdateMockHandler implements ICommandHandler<UpdateMockCommand, UpdatedMock> {
  constructor(
    @Inject(PROJECT_REPOSITORY) private readonly projects: ProjectRepositoryPort,
    @Inject(MOCK_REPOSITORY) private readonly mocks: MockRepositoryPort,
    @Inject(CLOCK) private readonly clock: ClockPort,
  ) {}

  async execute(command: UpdateMockCommand): Promise<UpdatedMock> {
    const project = await writableProject(this.projects, command.organizationId, command.projectId);
    const current = await this.mocks.findById(project.id, command.mockId);
    if (!current) throw new NotFoundError("Ese mock no existe", "mock-not-found");

    const problems = mockProblems(command.input);
    if (problems.length) throw new InvalidInputError("El mock no es válido", problems);

    const name = command.input.name?.trim();
    if (name && name !== current.name) {
      const siblings = await this.mocks.listByProject(project.id);
      if (siblings.some((row) => row.id !== current.id && row.name === name))
        throw new ConflictError(`Ya hay un mock llamado «${name}»`, "mock-duplicate-name");
    }

    const visibility = command.input.visibility ?? current.visibility;
    // Pasar a privado un mock que nunca tuvo clave necesita una, o pediría una cabecera que nadie
    // puede mandar y quedaría cerrado para siempre.
    const issued = visibility === "private" && !current.apiKeyHash ? rotatedKey(current, this.clock.now()) : null;
    const updated = {
      ...(issued?.mock ?? current),
      name: name || current.name,
      visibility,
      delay: command.input.delay ?? current.delay,
      enabled: command.input.enabled ?? current.enabled,
      updatedAt: this.clock.now(),
    };
    await this.mocks.save(updated);
    // Si ha habido que crear una clave, sale aquí: es la única vez que se puede ver.
    return issued ? { ...viewMock(updated), apiKey: issued.apiKey } : viewMock(updated);
  }
}

/** La clave vieja deja de valer en el mismo momento, que es de lo que sirve rotar. */
export class RotateMockKeyCommand implements ICommand {
  constructor(
    readonly organizationId: string,
    readonly projectId: string,
    readonly mockId: string,
  ) {}
}

@CommandHandler(RotateMockKeyCommand)
export class RotateMockKeyHandler implements ICommandHandler<RotateMockKeyCommand, IssuedMock> {
  constructor(
    @Inject(PROJECT_REPOSITORY) private readonly projects: ProjectRepositoryPort,
    @Inject(MOCK_REPOSITORY) private readonly mocks: MockRepositoryPort,
    @Inject(CLOCK) private readonly clock: ClockPort,
  ) {}

  async execute(command: RotateMockKeyCommand): Promise<IssuedMock> {
    const project = await writableProject(this.projects, command.organizationId, command.projectId);
    const current = await this.mocks.findById(project.id, command.mockId);
    if (!current) throw new NotFoundError("Ese mock no existe", "mock-not-found");
    if (current.visibility !== "private")
      throw new ConflictError("Un mock público no tiene clave que rotar", "mock-not-private");

    const issued = rotatedKey(current, this.clock.now());
    await this.mocks.save(issued.mock);
    return { mock: viewMock(issued.mock), apiKey: issued.apiKey };
  }
}

export class DeleteMockCommand implements ICommand {
  constructor(
    readonly organizationId: string,
    readonly projectId: string,
    readonly mockId: string,
  ) {}
}

@CommandHandler(DeleteMockCommand)
export class DeleteMockHandler implements ICommandHandler<DeleteMockCommand, void> {
  constructor(
    @Inject(PROJECT_REPOSITORY) private readonly projects: ProjectRepositoryPort,
    @Inject(MOCK_REPOSITORY) private readonly mocks: MockRepositoryPort,
  ) {}

  async execute(command: DeleteMockCommand): Promise<void> {
    const project = await writableProject(this.projects, command.organizationId, command.projectId);
    const gone = await this.mocks.remove(project.id, command.mockId);
    if (!gone) throw new NotFoundError("Ese mock no existe", "mock-not-found");
  }
}
