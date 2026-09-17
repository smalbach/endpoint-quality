import { randomUUID } from "node:crypto";
import { QueryBus, QueryHandler, type IQuery, type IQueryHandler } from "@nestjs/cqrs";
import type { PostmanExportResult } from "@eq/contracts";

import { InvalidInputError } from "@/shared/errors/domain-error";
import type { ProjectBundle } from "../../domain/project-bundle";
import { toPostmanDump, toPostmanExport } from "../../domain/postman-export";
import { ExportProjectQuery } from "./export-project";

/** Qué fichero se quiere, con los mismos nombres que usa el menú de Postman. */
export const POSTMAN_EXPORT_KINDS = ["collection", "endpoints", "environments", "dump"] as const;
export type PostmanExportKind = (typeof POSTMAN_EXPORT_KINDS)[number];

export class ExportPostmanQuery implements IQuery {
  constructor(
    readonly organizationId: string,
    readonly projectId: string,
    readonly kind: string,
    /** Cuando viene, solo estos flujos. Igual que en la exportación propia. */
    readonly workflowIds: string[],
  ) {}
}

/**
 * El proyecto en formato Postman: una colección, sus entornos, o el volcado con todo.
 *
 * El import ya leía una colección y la salida no existía, así que esto era una puerta de un solo
 * sentido. Un formato que se lee y no se escribe es un formato en el que nadie mete su trabajo: no
 * podías llevártelo, ni pasarlo por `newman` en un pipeline, ni dárselo a quien no use esto.
 *
 * **No lee la base de datos.** Pide la exportación propia —una consulta que ya existe, con sus
 * permisos y sus reglas sobre qué secretos no viajan— y traduce lo que vuelve. Leer las tablas otra
 * vez aquí sería un segundo lector libre de discrepar del primero sobre qué sale de un proyecto, y
 * la discrepancia sería un secreto en un fichero.
 *
 * Los ids se generan aquí y no en el traductor, que se queda siendo una función pura y por tanto
 * comprobable: el mismo proyecto produce el mismo fichero salvo esos ids.
 */
@QueryHandler(ExportPostmanQuery)
export class ExportPostmanHandler implements IQueryHandler<ExportPostmanQuery, PostmanExportResult> {
  constructor(private readonly queryBus: QueryBus) {}

  async execute(query: ExportPostmanQuery): Promise<PostmanExportResult> {
    const kind = query.kind || "collection";
    if (!(POSTMAN_EXPORT_KINDS as readonly string[]).includes(kind)) {
      throw new InvalidInputError(
        "Ese formato de exportación no existe",
        [{ field: "kind", detail: `usa ${POSTMAN_EXPORT_KINDS.join(", ")}` }],
        "unknown-postman-kind",
      );
    }

    const bundle = await this.queryBus.execute<ExportProjectQuery, ProjectBundle>(
      new ExportProjectQuery(query.organizationId, query.projectId, [], query.workflowIds),
    );
    const exported = toPostmanExport(
      bundle,
      { collectionId: randomUUID(), environmentIds: (bundle.environments ?? []).map(() => randomUUID()) },
      {
        contents: kind === "endpoints" ? "endpoints" : "flows",
        // Solo los ficheros que llevan variables las traducen, y por tanto solo ellos avisan de
        // las que salen vacías.
        environments: kind === "environments" || kind === "dump",
      },
    );

    const name = bundle.project?.name || "proyecto";
    if (kind === "environments") {
      return {
        kind,
        filename: `${slug(name)}.postman_environments.json`,
        // Varios entornos no caben en un fichero de entorno de Postman, que describe uno. Cuando
        // hay más de uno sale el volcado, que es el fichero de Postman que sí los admite todos.
        file:
          exported.environments.length === 1
            ? exported.environments[0]
            : { collections: [], environments: exported.environments },
        counts: { collections: 0, environments: exported.environments.length },
        skipped: exported.skipped,
      };
    }
    if (kind === "dump") {
      return {
        kind,
        filename: `${slug(name)}.postman_dump.json`,
        file: toPostmanDump(exported),
        counts: { collections: 1, environments: exported.environments.length },
        skipped: exported.skipped,
      };
    }
    return {
      kind: kind === "endpoints" ? "endpoints" : "collection",
      filename: `${slug(name)}${kind === "endpoints" ? "-endpoints" : ""}.postman_collection.json`,
      file: exported.collection,
      counts: { collections: 1, environments: 0 },
      skipped: exported.skipped,
    };
  }
}

/** El nombre del proyecto como nombre de fichero. Lo mismo que hace la exportación propia. */
const slug = (name: string): string =>
  name
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^A-Za-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase() || "proyecto";
