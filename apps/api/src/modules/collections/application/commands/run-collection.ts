import { randomUUID } from "node:crypto";
import { Inject } from "@nestjs/common";
import { CommandHandler, type ICommand, type ICommandHandler } from "@nestjs/cqrs";

import { ConflictError, InvalidInputError, NotFoundError } from "@/shared/errors/domain-error";
import { CLOCK, type ClockPort } from "@/shared/clock/clock.port";
import { PROJECT_REPOSITORY, type ProjectRepositoryPort } from "@/modules/projects/domain/ports";
import { ownedProject } from "@/modules/projects/application/commands/update-project";
import { ENVIRONMENT_REPOSITORY, type EnvironmentRepositoryPort } from "@/modules/environments/domain/ports";
import { EMPTY_TOTALS, findItem, requestsOf, type CollectionRun } from "../../domain/model";
import {
  COLLECTION_REPOSITORY,
  COLLECTION_RUN_QUEUE,
  COLLECTION_RUN_REPOSITORY,
  type CollectionRepositoryPort,
  type CollectionRunQueuePort,
  type CollectionRunRepositoryPort,
} from "../../domain/ports";
import { ownedCollection } from "./manage-collection";

/**
 * Los topes de una corrida.
 *
 * Una colección de ochenta peticiones por cincuenta vueltas son cuatro mil peticiones contra el
 * API de alguien: se rechaza al lanzarla, con su número, y no a los veinte minutos. Es la misma
 * idea que el techo de VUs de una prueba de carga.
 */
export const MAX_ITERATIONS = 50;
export const MAX_DELAY_MS = 60_000;
export const MAX_RUN_REQUESTS = 5_000;

export type RunCollectionInput = {
  environmentId: string | null;
  iterations?: number;
  delayMs?: number;
  stopOnFailure?: boolean;
  /** Correr solo una carpeta, como el «Run folder» de Postman. Null es la colección entera. */
  folderId?: string | null;
};

export class RunCollectionCommand implements ICommand {
  constructor(
    readonly organizationId: string,
    readonly projectId: string,
    readonly collectionId: string,
    readonly input: RunCollectionInput,
    readonly actorId: string,
  ) {}
}
export class CancelCollectionRunCommand implements ICommand {
  constructor(
    readonly organizationId: string,
    readonly projectId: string,
    readonly runId: string,
  ) {}
}
export class DeleteCollectionRunCommand implements ICommand {
  constructor(
    readonly organizationId: string,
    readonly projectId: string,
    readonly runId: string,
  ) {}
}

export async function ownedRun(
  projects: ProjectRepositoryPort,
  runs: CollectionRunRepositoryPort,
  organizationId: string,
  projectId: string,
  runId: string,
): Promise<CollectionRun> {
  await ownedProject(projects, organizationId, projectId);
  const run = await runs.find(projectId, runId);
  if (!run) throw new NotFoundError("La corrida no existe", "collection-run-not-found");
  return run;
}

/**
 * «Run collection»: la fila de la corrida, y la cola que la recorre.
 *
 * Todo lo que se puede saber antes de mandar nada se comprueba aquí —que la carpeta existe, que
 * hay peticiones, que el entorno es de este proyecto, que el número de vueltas es razonable—
 * porque un 422 inmediato es una frase y un fallo a mitad de la corrida es un informe a medias.
 */
@CommandHandler(RunCollectionCommand)
export class RunCollectionHandler implements ICommandHandler<RunCollectionCommand, { runId: string }> {
  constructor(
    @Inject(PROJECT_REPOSITORY) private readonly projects: ProjectRepositoryPort,
    @Inject(COLLECTION_REPOSITORY) private readonly collections: CollectionRepositoryPort,
    @Inject(COLLECTION_RUN_REPOSITORY) private readonly runs: CollectionRunRepositoryPort,
    @Inject(ENVIRONMENT_REPOSITORY) private readonly environments: EnvironmentRepositoryPort,
    @Inject(COLLECTION_RUN_QUEUE) private readonly queue: CollectionRunQueuePort,
    @Inject(CLOCK) private readonly clock: ClockPort,
  ) {}

  async execute(command: RunCollectionCommand): Promise<{ runId: string }> {
    const collection = await ownedCollection(
      this.projects,
      this.collections,
      command.organizationId,
      command.projectId,
      command.collectionId,
    );

    const iterations = command.input.iterations ?? 1;
    const delayMs = command.input.delayMs ?? 0;
    if (!Number.isInteger(iterations) || iterations < 1 || iterations > MAX_ITERATIONS)
      throw new InvalidInputError(
        "Número de vueltas no válido",
        [{ field: "iterations", detail: `Entre 1 y ${MAX_ITERATIONS}` }],
        "invalid-iterations",
      );
    if (!Number.isInteger(delayMs) || delayMs < 0 || delayMs > MAX_DELAY_MS)
      throw new InvalidInputError(
        "Espera entre peticiones no válida",
        [{ field: "delayMs", detail: `Entre 0 y ${MAX_DELAY_MS} ms` }],
        "invalid-delay",
      );

    const folderId = command.input.folderId ?? null;
    const folder = folderId ? findItem(collection.document.items, folderId) : null;
    if (folderId && (!folder || folder.item.kind !== "folder"))
      throw new NotFoundError("La carpeta no está en la colección", "collection-folder-not-found");

    const plan = requestsOf(folder ? folder.item.items : collection.document.items);
    if (!plan.length)
      throw new ConflictError(
        folder ? "Esa carpeta no tiene ninguna petición" : "La colección no tiene ninguna petición",
        "nothing-to-run",
      );
    if (plan.length * iterations > MAX_RUN_REQUESTS)
      throw new InvalidInputError(
        "La corrida pide demasiadas peticiones",
        [
          {
            field: "iterations",
            detail: `${plan.length} peticiones × ${iterations} vueltas pasan de ${MAX_RUN_REQUESTS}`,
          },
        ],
        "too-many-requests",
      );

    const environment = command.input.environmentId
      ? await this.environments.findById(command.input.environmentId)
      : null;
    if (command.input.environmentId && (!environment || environment.projectId !== command.projectId))
      throw new NotFoundError("El entorno no existe", "environment-not-found");

    const run: CollectionRun = {
      id: randomUUID(),
      organizationId: command.organizationId,
      projectId: command.projectId,
      collectionId: collection.id,
      collectionName: collection.name,
      environmentId: environment?.id ?? null,
      environmentName: environment?.name ?? null,
      status: "running",
      iterations,
      delayMs,
      stopOnFailure: command.input.stopOnFailure ?? false,
      folderId,
      folderName: folder?.item.name ?? null,
      totals: { ...EMPTY_TOTALS },
      results: [],
      startedAt: this.clock.now(),
      finishedAt: null,
      error: null,
      startedBy: command.actorId,
    };
    await this.runs.save(run);
    await this.queue.enqueue(run.id);
    return { runId: run.id };
  }
}

@CommandHandler(CancelCollectionRunCommand)
export class CancelCollectionRunHandler implements ICommandHandler<CancelCollectionRunCommand, void> {
  constructor(
    @Inject(PROJECT_REPOSITORY) private readonly projects: ProjectRepositoryPort,
    @Inject(COLLECTION_RUN_REPOSITORY) private readonly runs: CollectionRunRepositoryPort,
    @Inject(COLLECTION_RUN_QUEUE) private readonly queue: CollectionRunQueuePort,
    @Inject(CLOCK) private readonly clock: ClockPort,
  ) {}

  async execute(command: CancelCollectionRunCommand): Promise<void> {
    const run = await ownedRun(this.projects, this.runs, command.organizationId, command.projectId, command.runId);
    if (run.status !== "running") throw new ConflictError("Esa corrida ya terminó", "run-not-running");
    await this.queue.cancel(run.id);
    // La marca se guarda aquí también: la que está en vuelo acaba, y si la corrida ni siquiera
    // llegó a arrancar —estaba en la fila— nadie la volvería a tocar para cerrarla.
    await this.runs.save({ ...run, status: "cancelled", finishedAt: this.clock.now() });
  }
}

@CommandHandler(DeleteCollectionRunCommand)
export class DeleteCollectionRunHandler implements ICommandHandler<DeleteCollectionRunCommand, void> {
  constructor(
    @Inject(PROJECT_REPOSITORY) private readonly projects: ProjectRepositoryPort,
    @Inject(COLLECTION_RUN_REPOSITORY) private readonly runs: CollectionRunRepositoryPort,
  ) {}

  async execute(command: DeleteCollectionRunCommand): Promise<void> {
    await ownedRun(this.projects, this.runs, command.organizationId, command.projectId, command.runId);
    await this.runs.delete(command.projectId, command.runId);
  }
}
