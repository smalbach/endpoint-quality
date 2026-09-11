import { randomUUID } from "node:crypto";
import { Inject } from "@nestjs/common";
import { CommandHandler, type ICommand, type ICommandHandler } from "@nestjs/cqrs";
import type { Operation } from "@eq/runner-core";

import { ConflictError, InvalidInputError } from "@/shared/errors/domain-error";
import { CLOCK, type ClockPort } from "@/shared/clock/clock.port";
import { PROJECT_REPOSITORY, type ProjectRepositoryPort } from "@/modules/projects/domain/ports";
import { SPEC_REPOSITORY, type SpecRepositoryPort } from "@/modules/specs/domain/ports";
import { ownedProject } from "@/modules/projects/application/commands/update-project";
import {
  expectedStatusFor,
  matchOperation,
  parseCurlDocument,
  parseInsomniaExport,
  parsePostmanCollection,
  pathOf,
  queryOf,
  type ImportedRequests,
  type OperationMatch,
  type ParsedRequest,
  type SkippedRequest,
} from "../../domain/import-requests";
import { WORKFLOW_REPOSITORY, type WorkflowRepositoryPort } from "../../domain/ports";

export const IMPORT_FORMATS = ["curl", "postman", "insomnia"] as const;
export type ImportFormat = (typeof IMPORT_FORMATS)[number];

export class ImportRequestTemplatesCommand implements ICommand {
  constructor(
    readonly organizationId: string,
    readonly projectId: string,
    readonly input: { format: ImportFormat; text: string },
    readonly actorId: string,
  ) {}
}

/** What the import did, per request, so the editor can show a list instead of a number. */
export type ImportOutcome = {
  imported: { id: string; name: string; operationId: string }[];
  skipped: SkippedRequest[];
};

const PARSERS: Record<ImportFormat, (text: string) => ImportedRequests> = {
  curl: parseCurlDocument,
  postman: parsePostmanCollection,
  insomnia: parseInsomniaExport,
};

/**
 * Bringing in requests somebody already has, without letting them invent an endpoint.
 *
 * The whole design is in the second half of that sentence. A `curl` in a ticket or a colleague's
 * Postman collection is the fastest way to get this tool pointed at something real, and it is also
 * the fastest way to break the property the product rests on: that the endpoints are the
 * contract's, so a request against one the contract does not declare is *evidence*, not a new row.
 * So every imported request has to land on an operation the active contract already declares, and
 * one that does not comes back named in `skipped` — which is worth reading on its own, because a
 * collection with four unmatched requests is either stale or a list of undocumented endpoints.
 *
 * **Nothing is written until everything has been read.** A collection of forty requests where the
 * thirty-first collides with an existing name must not leave thirty rows behind and a 409; the
 * names are resolved against what is already stored and against each other first, and only then
 * does anything reach the repository.
 */
@CommandHandler(ImportRequestTemplatesCommand)
export class ImportRequestTemplatesHandler implements ICommandHandler<ImportRequestTemplatesCommand, ImportOutcome> {
  constructor(
    @Inject(PROJECT_REPOSITORY) private readonly projects: ProjectRepositoryPort,
    @Inject(SPEC_REPOSITORY) private readonly specs: SpecRepositoryPort,
    @Inject(WORKFLOW_REPOSITORY) private readonly workflows: WorkflowRepositoryPort,
    @Inject(CLOCK) private readonly clock: ClockPort,
  ) {}

  async execute(command: ImportRequestTemplatesCommand): Promise<ImportOutcome> {
    const project = await ownedProject(this.projects, command.organizationId, command.projectId);
    if (!project.activeSpecVersionId) {
      // Refused rather than imported as unmatched. Without a contract every single request would
      // come back skipped, which reads as «tu colección está mal» when the answer is «este
      // proyecto todavía no ha importado su contrato».
      throw new ConflictError("El proyecto todavía no tiene contrato importado", "no-active-spec");
    }

    const parsed = PARSERS[command.input.format](command.input.text);
    if (!parsed.requests.length && !parsed.skipped.length) {
      throw new InvalidInputError(
        "No se encontró ninguna petición en lo que enviaste",
        [{ field: "text", detail: `No hay nada que leer como ${command.input.format}` }],
        "nothing-to-import",
      );
    }

    const operations: Operation[] = await this.specs.listOperations(project.activeSpecVersionId);
    const taken = new Set((await this.workflows.listTemplates(project.id)).map((template) => template.name));

    const skipped = [...parsed.skipped];
    const rows: { id: string; name: string; match: OperationMatch; request: ParsedRequest }[] = [];
    for (const request of parsed.requests) {
      const match = matchOperation(request, operations);
      if (!match) {
        skipped.push({
          name: request.name,
          method: request.method,
          url: request.url,
          reason: `el contrato activo no declara ${request.method} ${pathOf(request.url)}`,
        });
        continue;
      }
      const name = uniqueName(request.name, taken);
      taken.add(name);
      rows.push({ id: randomUUID(), name, match, request });
    }

    const now = this.clock.now();
    for (const row of rows) {
      const match = row.match;
      await this.workflows.saveTemplate({
        id: row.id,
        projectId: project.id,
        name: row.name,
        operationId: match.operation.id,
        description: null,
        expectedStatus: expectedStatusFor(match.operation),
        // The path placeholders and the query string, together: both are `parameters` here, and
        // which of the two a name came from is the path template's business, not this one's.
        parameters: { ...match.parameters, ...queryOf(row.request.url) },
        disabledParameters: {},
        headers: importableHeaders(row.request.headers),
        disabledHeaders: {},
        body: row.request.body,
        // `default`, always. The three other values exist to be *rejected on purpose*, and an
        // importer cannot tell «this request carried no token» from «this case is testing what
        // happens without one».
        auth: "default",
        createdAt: now,
        updatedAt: now,
        updatedBy: command.actorId,
      });
    }

    return {
      imported: rows.map(({ id, name, match }) => ({ id, name, operationId: match.operation.id })),
      skipped,
    };
  }
}

/**
 * Headers worth keeping, which is not all of them.
 *
 * Three kinds are dropped. **The credential**, because it is the environment's to hold and an
 * imported `Authorization` would be somebody's token in a `jsonb` column — with the added trap
 * that it overrides the credential the run was meant to present, so every auth case would
 * silently pass. **What the executor decides**, `Content-Type` and `Accept`, because they are
 * derived from the payload and a stale one from an old export would contradict what is actually
 * sent. **What the transport owns** — `Host`, `Content-Length`, the `Sec-Fetch-*` family a browser
 * adds to a «Copy as cURL» — because they describe the copy, not the request.
 */
const DROPPED_HEADER =
  /^(authorization|cookie|proxy-authorization|content-type|content-length|accept|accept-encoding|host|connection|origin|referer|user-agent|sec-.*|upgrade-insecure-requests|pragma|cache-control)$/i;

export function importableHeaders(headers: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(headers).filter(([name]) => !DROPPED_HEADER.test(name.trim())));
}

/**
 * A name no other saved request in this project has.
 *
 * The name is how a step is read in a failed case, and the project enforces it unique — so an
 * import of a collection whose names overlap what is already there has to resolve the collision
 * rather than fail on it. Numbered, because that is what a person would do, and because the
 * alternative — overwriting what is already stored — would silently discard a request somebody
 * had edited by hand.
 */
export function uniqueName(name: string, taken: Set<string>): string {
  const base = (name.trim() || "Petición importada").slice(0, 110);
  if (!taken.has(base)) return base;
  for (let suffix = 2; suffix < 1000; suffix += 1) {
    const candidate = `${base} (${suffix})`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${base} ${randomUUID().slice(0, 8)}`;
}
