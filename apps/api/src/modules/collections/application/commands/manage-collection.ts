import { randomUUID } from "node:crypto";
import { Inject } from "@nestjs/common";
import { CommandHandler, type ICommand, type ICommandHandler } from "@nestjs/cqrs";

import { ConflictError, InvalidInputError, NotFoundError } from "@/shared/errors/domain-error";
import { CLOCK, type ClockPort } from "@/shared/clock/clock.port";
import { PROJECT_REPOSITORY, type ProjectRepositoryPort } from "@/modules/projects/domain/ports";
import { ownedProject } from "@/modules/projects/application/commands/update-project";
import { redactAuth } from "@/modules/workflows/domain/postman-auth";
import { EMPTY_DOCUMENT, type CollectionDocument, type CollectionItem, type CollectionRow } from "../../domain/model";
import { safeParseCollectionDocument } from "../../domain/schema";
import { COLLECTION_REPOSITORY, type CollectionRepositoryPort } from "../../domain/ports";

export type CollectionInput = {
  name?: string;
  description?: string;
  document?: CollectionDocument;
};

export class CreateCollectionCommand implements ICommand {
  constructor(
    readonly organizationId: string,
    readonly projectId: string,
    readonly input: CollectionInput,
    readonly actorId: string,
  ) {}
}
export class UpdateCollectionCommand implements ICommand {
  constructor(
    readonly organizationId: string,
    readonly projectId: string,
    readonly collectionId: string,
    readonly input: CollectionInput,
    readonly actorId: string,
  ) {}
}
export class DeleteCollectionCommand implements ICommand {
  constructor(
    readonly organizationId: string,
    readonly projectId: string,
    readonly collectionId: string,
  ) {}
}

/** La colección de ese proyecto, o un 404 que no confirma que el id exista en otro. */
export async function ownedCollection(
  projects: ProjectRepositoryPort,
  collections: CollectionRepositoryPort,
  organizationId: string,
  projectId: string,
  collectionId: string,
): Promise<CollectionRow> {
  await ownedProject(projects, organizationId, projectId);
  const collection = await collections.find(projectId, collectionId);
  if (!collection) throw new NotFoundError("La colección no existe", "collection-not-found");
  return collection;
}

/**
 * Los secretos escritos a mano, vaciados en todo el documento antes de guardarlo.
 *
 * El documento va a una columna `jsonb` sin cifrar, así que una contraseña escrita en el bloque
 * `auth` de una petición sería una contraseña en claro en la base — exactamente lo que la tabla de
 * credenciales y las variables sensibles existen para evitar. La misma regla que ya aplican
 * endpoints y flujos, en cada puerta que escribe una colección: guardarla, importarla, o editar
 * una petición. El hueco vacío se queda como marca de que falta.
 */
export function withoutLiteralSecrets(document: CollectionDocument): CollectionDocument {
  const clean = (items: CollectionItem[]): CollectionItem[] =>
    items.map((item) => ({
      ...item,
      auth: item.auth ? redactAuth(item.auth).auth : null,
      request: item.request ? { ...item.request, auth: redactAuth(item.request.auth).auth } : null,
      items: clean(item.items),
    }));
  return { ...document, auth: redactAuth(document.auth).auth, items: clean(document.items) };
}

/** El documento, validado y sin secretos literales, o un 422 que dice qué campo está mal. */
export function checkedDocument(document: CollectionDocument): CollectionDocument {
  const parsed = safeParseCollectionDocument(document);
  if (!parsed.ok) throw new InvalidInputError("La colección no es válida", parsed.issues, "collection-invalid");
  return withoutLiteralSecrets(document);
}

/** Un nombre libre en el proyecto: dos colecciones con el mismo nombre son dos que nadie distingue. */
async function freeName(
  collections: CollectionRepositoryPort,
  projectId: string,
  name: string,
  exceptId?: string,
): Promise<void> {
  const clash = await collections.findByName(projectId, name);
  if (clash && clash.id !== exceptId)
    throw new ConflictError(`Ya hay una colección llamada «${name}»`, "collection-name-taken");
}

@CommandHandler(CreateCollectionCommand)
export class CreateCollectionHandler implements ICommandHandler<CreateCollectionCommand, { id: string }> {
  constructor(
    @Inject(PROJECT_REPOSITORY) private readonly projects: ProjectRepositoryPort,
    @Inject(COLLECTION_REPOSITORY) private readonly collections: CollectionRepositoryPort,
    @Inject(CLOCK) private readonly clock: ClockPort,
  ) {}

  async execute(command: CreateCollectionCommand): Promise<{ id: string }> {
    await ownedProject(this.projects, command.organizationId, command.projectId);
    const name = (command.input.name ?? "").trim();
    if (!name) throw new InvalidInputError("La colección necesita un nombre", [{ field: "name", detail: "Ponle uno" }]);
    await freeName(this.collections, command.projectId, name);

    const now = this.clock.now();
    const row: CollectionRow = {
      id: randomUUID(),
      projectId: command.projectId,
      name,
      description: command.input.description ?? "",
      document: command.input.document ? checkedDocument(command.input.document) : EMPTY_DOCUMENT,
      createdAt: now,
      updatedAt: now,
      updatedBy: command.actorId,
    };
    await this.collections.save(row);
    return { id: row.id };
  }
}

/**
 * Guardar la colección: el documento entero, no un parche por nodo.
 *
 * Una colección es un fichero, y mover una petición de carpeta o reordenar dos toca el árbol
 * entero; una API por nodo obligaría al editor a mandar la misma operación en tres llamadas que
 * pueden quedarse a medias. Lo que se paga es lo de siempre con un documento: dos pestañas
 * editando a la vez, la última gana — igual que con la definición de un flujo.
 */
@CommandHandler(UpdateCollectionCommand)
export class UpdateCollectionHandler implements ICommandHandler<UpdateCollectionCommand, void> {
  constructor(
    @Inject(PROJECT_REPOSITORY) private readonly projects: ProjectRepositoryPort,
    @Inject(COLLECTION_REPOSITORY) private readonly collections: CollectionRepositoryPort,
    @Inject(CLOCK) private readonly clock: ClockPort,
  ) {}

  async execute(command: UpdateCollectionCommand): Promise<void> {
    const collection = await ownedCollection(
      this.projects,
      this.collections,
      command.organizationId,
      command.projectId,
      command.collectionId,
    );
    const name = command.input.name === undefined ? collection.name : command.input.name.trim();
    if (!name) throw new InvalidInputError("La colección necesita un nombre", [{ field: "name", detail: "Ponle uno" }]);
    if (name !== collection.name) await freeName(this.collections, command.projectId, name, collection.id);

    await this.collections.save({
      ...collection,
      name,
      description: command.input.description ?? collection.description,
      document: command.input.document ? checkedDocument(command.input.document) : collection.document,
      updatedAt: this.clock.now(),
      updatedBy: command.actorId,
    });
  }
}

@CommandHandler(DeleteCollectionCommand)
export class DeleteCollectionHandler implements ICommandHandler<DeleteCollectionCommand, void> {
  constructor(
    @Inject(PROJECT_REPOSITORY) private readonly projects: ProjectRepositoryPort,
    @Inject(COLLECTION_REPOSITORY) private readonly collections: CollectionRepositoryPort,
  ) {}

  async execute(command: DeleteCollectionCommand): Promise<void> {
    await ownedCollection(
      this.projects,
      this.collections,
      command.organizationId,
      command.projectId,
      command.collectionId,
    );
    // Las corridas se quedan: una corrida es un hecho sobre un rato, y borrar la colección no
    // borra lo que midió. Por eso `collectionId` no tiene clave foránea.
    await this.collections.delete(command.projectId, command.collectionId);
  }
}
