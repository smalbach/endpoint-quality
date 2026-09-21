import { Inject } from "@nestjs/common";
import { CommandBus, CommandHandler, type ICommand, type ICommandHandler } from "@nestjs/cqrs";

import { InvalidInputError } from "@/shared/errors/domain-error";
import { PROJECT_REPOSITORY, type ProjectRepositoryPort } from "@/modules/projects/domain/ports";
import {
  SendEndpointRequestCommand,
  type SentRequestView,
} from "@/modules/endpoints/application/commands/send-endpoint-request";
import { findItem, resolveItemAuth, type CollectionItem, type CollectionRequest } from "../../domain/model";
import { collectionRequestSchema } from "../../domain/schema";
import { COLLECTION_REPOSITORY, type CollectionRepositoryPort } from "../../domain/ports";
import { composeScript } from "../../infrastructure/collection-runner";
import { ownedCollection } from "./manage-collection";

export type SendCollectionRequestInput = {
  environmentId: string | null;
  /** Dónde vive, para heredar de sus carpetas. Null en una petición que todavía no se ha guardado. */
  itemId: string | null;
  request: CollectionRequest;
  preRequestScript: string;
  postResponseScript: string;
};

export class SendCollectionRequestCommand implements ICommand {
  constructor(
    readonly organizationId: string,
    readonly projectId: string,
    readonly collectionId: string,
    readonly input: SendCollectionRequestInput,
    readonly actorId: string,
  ) {}
}

/**
 * «Enviar» desde el editor de la colección: una petición, ahora, contestada en la misma respuesta.
 *
 * Lo único que hace de más que el botón de enviar de un endpoint es **lo que la colección añade**:
 * los scripts de la colección y de las carpetas que contienen la petición, y de quién hereda la
 * autenticación. Eso se compone aquí, con las mismas funciones que usa el runner, para que enviar
 * a mano y correr la colección no puedan significar cosas distintas — que es exactamente el fallo
 * que se nota el día en que una petición pasa en pantalla y falla en la corrida.
 *
 * Después delega: quien manda es el mismo comando de siempre, con su guardia SSRF, su
 * `writesAllowed`, su cadena de credenciales y sus scripts en un proceso aislado.
 */
@CommandHandler(SendCollectionRequestCommand)
export class SendCollectionRequestHandler implements ICommandHandler<SendCollectionRequestCommand, SentRequestView> {
  constructor(
    private readonly commandBus: CommandBus,
    @Inject(PROJECT_REPOSITORY) private readonly projects: ProjectRepositoryPort,
    @Inject(COLLECTION_REPOSITORY) private readonly collections: CollectionRepositoryPort,
  ) {}

  async execute(command: SendCollectionRequestCommand): Promise<SentRequestView> {
    const collection = await ownedCollection(
      this.projects,
      this.collections,
      command.organizationId,
      command.projectId,
      command.collectionId,
    );
    const parsed = collectionRequestSchema.safeParse(command.input.request);
    if (!parsed.success)
      throw new InvalidInputError(
        "La petición no es válida",
        parsed.error.issues.map((issue) => ({
          field: issue.path.length ? `request.${issue.path.join(".")}` : "request",
          detail: issue.message,
        })),
        "collection-request-invalid",
      );
    const request = parsed.data as CollectionRequest;

    const found = command.input.itemId ? findItem(collection.document.items, command.input.itemId) : null;
    const trail: CollectionItem[] = found?.trail ?? [];

    const input = {
      environmentId: command.input.environmentId,
      method: request.method,
      path: request.url,
      pathParameters: request.pathParameters.map((parameter) => ({ name: parameter.name, value: parameter.value })),
      query: request.query.map((row) => ({ name: row.name, value: row.value, enabled: row.enabled })),
      headers: request.headers,
      body: request.body,
      auth: resolveItemAuth(request.auth, trail, collection.document.auth),
      preRequestScript: composeScript([
        { label: "Colección", code: collection.document.preRequestScript },
        ...trail.map((folder) => ({ label: `Carpeta ${folder.name}`, code: folder.preRequestScript })),
        { label: "Petición", code: command.input.preRequestScript },
      ]),
      postResponseScript: composeScript([
        { label: "Colección", code: collection.document.postResponseScript },
        ...trail.map((folder) => ({ label: `Carpeta ${folder.name}`, code: folder.postResponseScript })),
        { label: "Petición", code: command.input.postResponseScript },
      ]),
      // Las variables de la colección, para que un `{{chk_run}}` escrito en la URL valga algo al
      // enviar a mano. Lo que el script escriba aquí no se guarda: enviar no es correr.
      variables: Object.fromEntries(
        collection.document.variables.filter((variable) => variable.enabled).map((v) => [v.key, v.value]),
      ),
    };

    return this.commandBus.execute<SendEndpointRequestCommand, SentRequestView>(
      new SendEndpointRequestCommand(
        command.organizationId,
        command.projectId,
        JSON.stringify(input),
        [],
        command.actorId,
      ),
    );
  }
}
