/**
 * Guardar, renombrar, reordenar y borrar ejemplos de un endpoint.
 *
 * El camino normal es **guardar la respuesta que acabas de recibir**, no teclear un ejemplo: eso es
 * lo que hace que se guarden. Un formulario en blanco con quince campos se rellena una vez y no se
 * vuelve a tocar, y entonces la lista de ejemplos se queda vacía y no documenta nada.
 *
 * Por eso el comando de crear acepta el par petición/respuesta tal y como salió de «Enviar», lo
 * pasa por la redacción, y **devuelve el parte de lo que se quitó**. Ese parte no es un detalle: un
 * ejemplo que perdió la cabecera de autenticación en silencio es un ejemplo que se lee como «esto
 * funcionaba sin credencial», y alguien lo va a creer.
 */
import { Inject } from "@nestjs/common";
import { CommandHandler, type ICommand, type ICommandHandler } from "@nestjs/cqrs";

import { CLOCK, type ClockPort } from "@/shared/clock/clock.port";
import { ConflictError, InvalidInputError, NotFoundError } from "@/shared/errors/domain-error";
import { PROJECT_REPOSITORY, type ProjectRepositoryPort } from "@/modules/projects/domain/ports";
import {
  MAX_EXAMPLES_PER_ENDPOINT,
  blankExample,
  defaultExampleName,
  exampleProblems,
  redactExample,
  uniqueExampleName,
  viewExample,
  type ExampleRequest,
  type ExampleResponse,
  type ExampleView,
  type Redaction,
} from "../../domain/examples";
import {
  ENDPOINT_REPOSITORY,
  EXAMPLE_REPOSITORY,
  type EndpointRepositoryPort,
  type ExampleRepositoryPort,
} from "../../domain/ports";
import { writableProject } from "./manage-endpoints";

/** Lo que devuelve guardar: el ejemplo y qué se le quitó por ser una credencial. */
export type SavedExample = { example: ExampleView; redaction: Redaction };

export class SaveExampleCommand implements ICommand {
  constructor(
    readonly organizationId: string,
    readonly projectId: string,
    readonly endpointId: string,
    /** Vacío para que lo ponga el código de estado, que es lo que se busca en la lista. */
    readonly name: string,
    readonly request: ExampleRequest,
    readonly response: ExampleResponse,
    readonly actorId: string,
  ) {}
}

@CommandHandler(SaveExampleCommand)
export class SaveExampleHandler implements ICommandHandler<SaveExampleCommand, SavedExample> {
  constructor(
    @Inject(PROJECT_REPOSITORY) private readonly projects: ProjectRepositoryPort,
    @Inject(ENDPOINT_REPOSITORY) private readonly endpoints: EndpointRepositoryPort,
    @Inject(EXAMPLE_REPOSITORY) private readonly examples: ExampleRepositoryPort,
    @Inject(CLOCK) private readonly clock: ClockPort,
  ) {}

  async execute(command: SaveExampleCommand): Promise<SavedExample> {
    const project = await writableProject(this.projects, command.organizationId, command.projectId);
    const endpoint = await this.endpoints.findById(project.id, command.endpointId);
    if (!endpoint) throw new NotFoundError("Ese endpoint no existe", "endpoint-not-found");

    const problems = exampleProblems({ request: command.request, response: command.response });
    if (command.name.trim()) problems.push(...exampleProblems({ name: command.name }));
    if (problems.length) throw new InvalidInputError("El ejemplo no es válido", problems);

    const existing = await this.examples.listByEndpoint(project.id, endpoint.id);
    if (existing.length >= MAX_EXAMPLES_PER_ENDPOINT) {
      throw new ConflictError(
        `Este endpoint ya tiene ${MAX_EXAMPLES_PER_ENDPOINT} ejemplos: borra alguno antes de añadir otro`,
        "examples-full",
      );
    }

    const clean = redactExample(command.request, command.response);
    const now = this.clock.now();
    const example = blankExample({
      projectId: project.id,
      endpointId: endpoint.id,
      name: uniqueExampleName(
        command.name.trim() || defaultExampleName(command.response.status),
        new Set(existing.map((row) => row.name)),
      ),
      request: clean.request,
      response: clean.response,
      origin: "manual",
      orderIndex: existing.length,
      now,
      actorId: command.actorId,
    });
    await this.examples.save(example);
    return { example: viewExample(example), redaction: clean.redaction };
  }
}

/**
 * Cambiar un ejemplo ya guardado: el nombre, el sitio en la lista, o el par entero.
 *
 * Reeditar el par pasa **otra vez** por la redacción. Sería fácil confiar en que lo guardado ya
 * está limpio y solo limpiar en el alta, y entonces el camino para meter un token en la base de
 * datos sería editar un ejemplo en vez de crearlo.
 */
export class UpdateExampleCommand implements ICommand {
  constructor(
    readonly organizationId: string,
    readonly projectId: string,
    readonly exampleId: string,
    readonly input: { name?: string; orderIndex?: number; request?: ExampleRequest; response?: ExampleResponse },
  ) {}
}

@CommandHandler(UpdateExampleCommand)
export class UpdateExampleHandler implements ICommandHandler<UpdateExampleCommand, SavedExample> {
  constructor(
    @Inject(PROJECT_REPOSITORY) private readonly projects: ProjectRepositoryPort,
    @Inject(EXAMPLE_REPOSITORY) private readonly examples: ExampleRepositoryPort,
    @Inject(CLOCK) private readonly clock: ClockPort,
  ) {}

  async execute(command: UpdateExampleCommand): Promise<SavedExample> {
    const project = await writableProject(this.projects, command.organizationId, command.projectId);
    const current = await this.examples.findById(project.id, command.exampleId);
    if (!current) throw new NotFoundError("Ese ejemplo no existe", "example-not-found");

    const problems = exampleProblems(command.input);
    if (command.input.orderIndex !== undefined && command.input.orderIndex < 0)
      problems.push({ field: "orderIndex", detail: "No puede ser negativo" });
    if (problems.length) throw new InvalidInputError("El ejemplo no es válido", problems);

    const name = command.input.name?.trim();
    if (name && name !== current.name) {
      const siblings = await this.examples.listByEndpoint(project.id, current.endpointId);
      if (siblings.some((row) => row.id !== current.id && row.name === name))
        throw new ConflictError(`Ya hay un ejemplo llamado «${name}»`, "example-duplicate-name");
    }

    const clean = redactExample(command.input.request ?? current.request, command.input.response ?? current.response);
    const updated = {
      ...current,
      name: name || current.name,
      orderIndex: command.input.orderIndex ?? current.orderIndex,
      request: clean.request,
      response: clean.response,
      updatedAt: this.clock.now(),
    };
    await this.examples.save(updated);
    return { example: viewExample(updated), redaction: clean.redaction };
  }
}

export class DeleteExampleCommand implements ICommand {
  constructor(
    readonly organizationId: string,
    readonly projectId: string,
    readonly exampleId: string,
  ) {}
}

@CommandHandler(DeleteExampleCommand)
export class DeleteExampleHandler implements ICommandHandler<DeleteExampleCommand, void> {
  constructor(
    @Inject(PROJECT_REPOSITORY) private readonly projects: ProjectRepositoryPort,
    @Inject(EXAMPLE_REPOSITORY) private readonly examples: ExampleRepositoryPort,
  ) {}

  async execute(command: DeleteExampleCommand): Promise<void> {
    const project = await writableProject(this.projects, command.organizationId, command.projectId);
    const gone = await this.examples.remove(project.id, command.exampleId);
    if (!gone) throw new NotFoundError("Ese ejemplo no existe", "example-not-found");
  }
}
