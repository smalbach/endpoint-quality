import { randomUUID } from "node:crypto";
import { Inject } from "@nestjs/common";
import { CommandHandler, type ICommand, type ICommandHandler } from "@nestjs/cqrs";

import type { PostmanCollectionImportResult } from "@eq/contracts";
import { InvalidInputError } from "@/shared/errors/domain-error";
import { CLOCK, type ClockPort } from "@/shared/clock/clock.port";
import { PROJECT_REPOSITORY, type ProjectRepositoryPort } from "@/modules/projects/domain/ports";
import { ownedProject } from "@/modules/projects/application/commands/update-project";
import { countItems, type CollectionRow } from "../../domain/model";
import { readPostmanFile } from "../../domain/postman";
import { COLLECTION_REPOSITORY, type CollectionRepositoryPort } from "../../domain/ports";
import { checkedDocument } from "./manage-collection";

export class ImportPostmanCollectionCommand implements ICommand {
  constructor(
    readonly organizationId: string,
    readonly projectId: string,
    readonly input: { text: string; name?: string },
    readonly actorId: string,
  ) {}
}

/**
 * Una colección de Postman, como la colección que es.
 *
 * Es lo que este producto no hacía: el fichero entraba partido en flujos —un grafo por carpeta,
 * las aristas deducidas del orden de las peticiones— y a partir de ahí ya no era la colección de
 * nadie. No se podía volver a exportar, no se editaba como en el producto del que venía, y correrla
 * no era correrla de arriba abajo sino recorrer un grafo. Aquí el árbol se guarda tal cual: una
 * carpeta es una carpeta, una petición es una petición, y el orden es el del fichero.
 *
 * **Nada se escribe hasta haber leído el fichero entero.** Una colección de nueve carpetas donde
 * la séptima trae una petición ilegible no puede dejar seis carpetas guardadas y un error.
 *
 * **Creada o actualizada, por nombre.** Importar la misma colección dos veces es el caso normal —
 * los tests cambiaron, la carpeta creció— y una segunda importación que dejara «Catalog API
 * (copia 2)» obligaría a alguien a averiguar cuál de las tres es la buena.
 */
@CommandHandler(ImportPostmanCollectionCommand)
export class ImportPostmanCollectionHandler
  implements ICommandHandler<ImportPostmanCollectionCommand, PostmanCollectionImportResult>
{
  constructor(
    @Inject(PROJECT_REPOSITORY) private readonly projects: ProjectRepositoryPort,
    @Inject(COLLECTION_REPOSITORY) private readonly collections: CollectionRepositoryPort,
    @Inject(CLOCK) private readonly clock: ClockPort,
  ) {}

  async execute(command: ImportPostmanCollectionCommand): Promise<PostmanCollectionImportResult> {
    await ownedProject(this.projects, command.organizationId, command.projectId);

    const read = readPostmanFile(command.input.text);
    if (!read) {
      throw new InvalidInputError(
        "El fichero no es una colección de Postman",
        [{ field: "text", detail: "No es JSON. Expórtala como v2.1 y vuelve a intentarlo" }],
        "postman-invalid",
      );
    }
    const counted = countItems(read.document.items);
    if (!counted.requests) {
      throw new InvalidInputError(
        "La colección no trae ninguna petición",
        [{ field: "text", detail: "Se leyó como Postman v2.1 y no contiene peticiones con URL" }],
        "nothing-to-import",
      );
    }

    const name = (command.input.name ?? read.name).trim() || "Colección importada";
    const document = checkedDocument(read.document);
    const existing = await this.collections.findByName(command.projectId, name);
    const now = this.clock.now();
    const row: CollectionRow = existing
      ? { ...existing, description: read.description, document, updatedAt: now, updatedBy: command.actorId }
      : {
          id: randomUUID(),
          projectId: command.projectId,
          name,
          description: read.description,
          document,
          createdAt: now,
          updatedAt: now,
          updatedBy: command.actorId,
        };
    await this.collections.save(row);

    return {
      id: row.id,
      name,
      action: existing ? "updated" : "created",
      folders: counted.folders,
      requests: counted.requests,
      skipped: read.skipped,
      notes: read.notes,
    };
  }
}
