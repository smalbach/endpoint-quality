import { randomUUID } from "node:crypto";
import { Inject } from "@nestjs/common";
import { CommandHandler, EventBus, type ICommand, type ICommandHandler } from "@nestjs/cqrs";
import { fingerprint, importSpec, type ImportProblem } from "@eq/spec-import";

import { InvalidInputError } from "@/shared/errors/domain-error";
import { CLOCK, type ClockPort } from "@/shared/clock/clock.port";
import { SAFE_FETCH, type SafeFetchPort } from "@/shared/http/safe-fetch";
import { PROJECT_REPOSITORY, type ProjectRepositoryPort } from "@/modules/projects/domain/ports";
import { ownedProject } from "@/modules/projects/application/commands/update-project";
import { SPEC_REPOSITORY, type SpecRepositoryPort } from "../../domain/ports";
import { SpecVersionImportedEvent } from "../events/spec-version-imported.event";

export type SpecSourceInput =
  | { kind: "url"; url: string; headers?: Record<string, string> }
  | { kind: "inline"; raw: string }
  | { kind: "upload"; filename: string; raw: string };

export class ImportSpecVersionCommand implements ICommand {
  constructor(
    readonly organizationId: string,
    readonly projectId: string,
    readonly source: SpecSourceInput,
    readonly importedBy: string,
    /** Whether the imported version becomes the one runs use. False imports it for comparison
     * only, which is what a drift check does. */
    readonly activate: boolean,
  ) {}
}

export type ImportSpecVersionResult = {
  specVersionId: string;
  hash: string;
  operationCount: number;
  problems: ImportProblem[];
  /** True when this exact document was already imported. The existing version is returned rather
   * than a duplicate created. */
  unchanged: boolean;
  activated: boolean;
};

/**
 * Reads a contract into the project, as a snapshot.
 *
 * This is the command that retires `scripts/gen_dashboard_endpoints.py`. There, the operation
 * table was generated into a TypeScript file in another repository and compiled into the
 * dashboard's bundle; when the contract moved, the copy went stale in silence and the tool
 * reported green against a spec that no longer existed.
 *
 * Three decisions worth knowing:
 *
 * - **The raw document is stored, not only the operations.** Schema validation during a run
 *   reads the document itself, and re-fetching it mid-run would mean asserting against a
 *   contract that can change while the matrix is walking it.
 * - **The same bytes resolve to the same version.** A re-import of an unchanged document returns
 *   the existing row instead of piling up identical snapshots, which is what lets a drift check
 *   run on a schedule without growing the table.
 * - **A URL is fetched through the SSRF guard.** This is the first place the server requests an
 *   address a customer typed, and "importa el contrato desde esta URL" is otherwise a form field
 *   that reads the cloud metadata endpoint.
 */
@CommandHandler(ImportSpecVersionCommand)
export class ImportSpecVersionHandler implements ICommandHandler<ImportSpecVersionCommand, ImportSpecVersionResult> {
  constructor(
    @Inject(PROJECT_REPOSITORY) private readonly projects: ProjectRepositoryPort,
    @Inject(SPEC_REPOSITORY) private readonly specs: SpecRepositoryPort,
    @Inject(SAFE_FETCH) private readonly http: SafeFetchPort,
    @Inject(CLOCK) private readonly clock: ClockPort,
    private readonly eventBus: EventBus,
  ) {}

  async execute(command: ImportSpecVersionCommand): Promise<ImportSpecVersionResult> {
    const project = await ownedProject(this.projects, command.organizationId, command.projectId);
    const raw = await this.read(command.source);
    if (!raw.trim()) throw new InvalidInputError("El documento está vacío", [{ field: "source", detail: "No se recibió contenido" }]);

    const hash = fingerprint(raw);
    const existing = await this.specs.findVersionByHash(project.id, hash);
    if (existing) {
      // Identical bytes. Activation is still honoured, because "import this and use it" is a
      // reasonable thing to ask about a version that happens to already be on file.
      const activated = command.activate && project.activeSpecVersionId !== existing.id;
      if (activated) await this.projects.save({ ...project, activeSpecVersionId: existing.id });
      return { specVersionId: existing.id, hash, operationCount: existing.operationCount, problems: existing.problems, unchanged: true, activated };
    }

    const parsed = importSpec(raw);
    const errors = parsed.problems.filter((problem) => problem.severity === "error");
    if (errors.length) {
      // Errors stop the import; warnings do not. A document with one unnamed operation is worth
      // importing — the other forty-five are usable — but one that is not OpenAPI 3 at all would
      // produce an operation table that silently means nothing.
      throw new InvalidInputError(
        "El documento no se pudo importar",
        errors.map((problem) => ({ field: problem.pointer, detail: problem.message })),
        "spec-invalid",
      );
    }

    const now = this.clock.now();
    const specVersionId = randomUUID();
    const sourceId = await this.recordSource(project.id, command.source, now);

    await this.specs.saveVersion(
      {
        id: specVersionId,
        projectId: project.id,
        sourceId,
        hash,
        raw,
        format: raw.trim().startsWith("{") ? "json" : "yaml",
        openapiVersion: parsed.openapiVersion,
        title: parsed.title,
        contractVersion: parsed.version,
        operationCount: parsed.operations.length,
        problems: parsed.problems,
        importedBy: command.importedBy,
        importedAt: now,
      },
      // Spread first, then the row fields: `operation.id` is the contract's operationId and
      // must survive, while `rowId` is this table's key.
      parsed.operations.map((operation, position) => ({ ...operation, rowId: randomUUID(), specVersionId, position })),
    );

    // The first successful import activates itself whatever the flag says: a project whose only
    // contract is not the active one has nothing to run, and no operator ever means that.
    const activate = command.activate || project.activeSpecVersionId === null;
    if (activate) await this.projects.save({ ...project, activeSpecVersionId: specVersionId });

    this.eventBus.publish(new SpecVersionImportedEvent(project.id, specVersionId, hash, parsed.operations.length, now));

    return { specVersionId, hash, operationCount: parsed.operations.length, problems: parsed.problems, unchanged: false, activated: activate };
  }

  private async read(source: SpecSourceInput): Promise<string> {
    if (source.kind !== "url") return source.raw;
    const response = await this.http.get(source.url, { headers: source.headers });
    if (response.status >= 400) {
      throw new InvalidInputError(
        `El contrato respondió ${response.status}`,
        [{ field: "url", detail: `${source.url} devolvió ${response.status}` }],
        "spec-unreachable",
      );
    }
    return response.body;
  }

  private async recordSource(projectId: string, source: SpecSourceInput, now: Date): Promise<string> {
    const id = randomUUID();
    await this.specs.saveSource({
      id,
      projectId,
      kind: source.kind,
      location: source.kind === "url" ? source.url : source.kind === "upload" ? source.filename : "",
      // Headers for a contract behind auth are a credential. P3 encrypts them with the same
      // cipher as the target credentials; until there is a key to do it with, they are not
      // persisted at all rather than persisted in the clear.
      headersCiphertext: null,
      createdAt: now,
    });
    return id;
  }
}
