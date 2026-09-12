import { randomUUID } from "node:crypto";
import { Inject } from "@nestjs/common";
import { CommandHandler, type ICommand, type ICommandHandler } from "@nestjs/cqrs";

import { CLOCK, type ClockPort } from "@/shared/clock/clock.port";
import { InvalidInputError } from "@/shared/errors/domain-error";
import { PROJECT_REPOSITORY, type ProjectRepositoryPort } from "@/modules/projects/domain/ports";
import { SPEC_REPOSITORY, type SpecRepositoryPort } from "@/modules/specs/domain/ports";
import {
  applyEndpointInput,
  blankEndpoint,
  endpointKey,
  viewEndpoint,
  type Endpoint,
  type EndpointView,
} from "../../domain/model";
import { ENDPOINT_REPOSITORY, type EndpointRepositoryPort } from "../../domain/ports";
import {
  detectFormat,
  draftFromCurl,
  parseEndpointFile,
  type EndpointDraft,
  type ImportFileFormat,
  type ImportSkip,
} from "../../domain/import-endpoints";
import { assertUnique, takenKeys, writableProject } from "./manage-endpoints";
import { contractKeysOf } from "../queries/list-endpoints";

export type ImportEndpointsResult = {
  format: ImportFileFormat;
  imported: { id: string; method: string; path: string }[];
  skipped: ImportSkip[];
};

export class ImportEndpointFileCommand implements ICommand {
  constructor(
    readonly organizationId: string,
    readonly projectId: string,
    readonly filename: string,
    readonly text: string,
    readonly actorId: string,
  ) {}
}

/**
 * A file, read into endpoints, all or nothing.
 *
 * The analyzer answered with a count and saved duplicates; this answers with the list of what came
 * in and of what did not, with the reason, and never saves a second `GET /users`. Nothing is written
 * until the whole file has been read and checked.
 */
@CommandHandler(ImportEndpointFileCommand)
export class ImportEndpointFileHandler implements ICommandHandler<ImportEndpointFileCommand, ImportEndpointsResult> {
  constructor(
    @Inject(PROJECT_REPOSITORY) private readonly projects: ProjectRepositoryPort,
    @Inject(ENDPOINT_REPOSITORY) private readonly endpoints: EndpointRepositoryPort,
    @Inject(CLOCK) private readonly clock: ClockPort,
  ) {}

  async execute(command: ImportEndpointFileCommand): Promise<ImportEndpointsResult> {
    const project = await writableProject(this.projects, command.organizationId, command.projectId);
    if (!command.text.trim())
      throw new InvalidInputError(
        "El fichero está vacío",
        [{ field: "file", detail: "No hay nada que leer" }],
        "file-empty",
      );
    const format = detectFormat(command.filename, command.text);
    if (!format) {
      throw new InvalidInputError(
        "No se reconoce el formato del fichero",
        [
          {
            field: "file",
            detail: "Se admiten OpenAPI (JSON o YAML), Postman v2.1, Insomnia v4 y markdown con comandos curl",
          },
        ],
        "import-format-unknown",
      );
    }

    const parsed = parseEndpointFile(format, command.text);
    if (!parsed.drafts.length && !parsed.skipped.length) {
      throw new InvalidInputError(
        "No se encontró ningún endpoint en el fichero",
        [{ field: "file", detail: `Se leyó como ${format} y no contiene peticiones` }],
        "nothing-to-import",
      );
    }

    const taken = await takenKeys(this.endpoints, project.id);
    const seen = new Set<string>();
    const skipped = [...parsed.skipped];
    const accepted: EndpointDraft[] = [];
    for (const draft of parsed.drafts) {
      const key = endpointKey(draft.method, draft.path);
      if (taken.has(key))
        skipped.push({
          method: draft.method,
          path: draft.path,
          name: draft.description ?? "",
          reason: "El proyecto ya tiene este endpoint",
        });
      else if (seen.has(key))
        skipped.push({
          method: draft.method,
          path: draft.path,
          name: draft.description ?? "",
          reason: "Repetido en el fichero",
        });
      else accepted.push(draft);
      seen.add(key);
    }

    const rows = await materialize(this.endpoints, project.id, accepted, "import", this.clock.now(), command.actorId);
    await this.endpoints.saveMany(rows);
    return { format, imported: rows.map(({ id, method, path }) => ({ id, method, path })), skipped };
  }
}

/** Drafts as rows of the project, numbered after the ones it already has. */
export async function materialize(
  endpoints: EndpointRepositoryPort,
  projectId: string,
  drafts: EndpointDraft[],
  origin: Endpoint["origin"],
  now: Date,
  actorId: string,
): Promise<Endpoint[]> {
  const first = await endpoints.nextOrderIndex(projectId);
  return drafts.map(({ operationId, ...draft }, index) => ({
    ...applyEndpointInput(
      blankEndpoint({ id: randomUUID(), projectId, origin, orderIndex: first + index, now, actorId }),
      draft,
    ),
    operationId,
  }));
}

export class ImportEndpointCurlCommand implements ICommand {
  constructor(
    readonly organizationId: string,
    readonly projectId: string,
    readonly curl: string,
    readonly actorId: string,
  ) {}
}

@CommandHandler(ImportEndpointCurlCommand)
export class ImportEndpointCurlHandler implements ICommandHandler<ImportEndpointCurlCommand, EndpointView> {
  constructor(
    @Inject(PROJECT_REPOSITORY) private readonly projects: ProjectRepositoryPort,
    @Inject(SPEC_REPOSITORY) private readonly specs: SpecRepositoryPort,
    @Inject(ENDPOINT_REPOSITORY) private readonly endpoints: EndpointRepositoryPort,
    @Inject(CLOCK) private readonly clock: ClockPort,
  ) {}

  async execute(command: ImportEndpointCurlCommand): Promise<EndpointView> {
    const project = await writableProject(this.projects, command.organizationId, command.projectId);
    const draft = draftFromCurl(command.curl);
    if (typeof draft === "string")
      throw new InvalidInputError("El cURL no se pudo leer", [{ field: "curl", detail: draft }], "curl-invalid");
    const [row] = await materialize(this.endpoints, project.id, [draft], "import", this.clock.now(), command.actorId);
    await assertUnique(this.endpoints, project.id, row);
    await this.endpoints.save(row);
    return viewEndpoint(row, await contractKeysOf(this.specs, project));
  }
}
