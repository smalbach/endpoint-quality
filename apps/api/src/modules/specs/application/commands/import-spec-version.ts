import { randomUUID } from "node:crypto";
import { Inject } from "@nestjs/common";
import { CommandHandler, EventBus, type ICommand, type ICommandHandler } from "@nestjs/cqrs";
import { fingerprint, importSpec, type ImportProblem } from "@eq/spec-import";

import { Logger } from "@nestjs/common";

import { ConflictError, InvalidInputError } from "@/shared/errors/domain-error";
import { CLOCK, type ClockPort } from "@/shared/clock/clock.port";
import { SAFE_FETCH, type SafeFetchPort } from "@/shared/http/safe-fetch";
import { SECRET_CIPHER, type SecretCipherPort } from "@/shared/crypto/secret-cipher";
import { PROJECT_REPOSITORY, type ProjectRepositoryPort } from "@/modules/projects/domain/ports";
import { ownedProject } from "@/modules/projects/application/commands/update-project";
import { SPEC_REPOSITORY, type SpecRepositoryPort } from "../../domain/ports";
import { SpecVersionImportedEvent } from "../events/spec-version-imported.event";
import { SpecVersionActivatedEvent } from "../events/spec-version-activated.event";

export type SpecSourceInput =
  | { kind: "url"; url: string; headers?: Record<string, string> }
  | { kind: "inline"; raw: string }
  | { kind: "upload"; filename: string; raw: string };

export class ImportSpecVersionCommand implements ICommand {
  constructor(
    readonly organizationId: string,
    readonly projectId: string,
    /** Undefined re-reads wherever the project read last time, with the credentials it stored
     * then. A drift check on a schedule is the reason this can be omitted. */
    readonly source: SpecSourceInput | undefined,
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
    @Inject(SECRET_CIPHER) private readonly cipher: SecretCipherPort,
    @Inject(CLOCK) private readonly clock: ClockPort,
    private readonly eventBus: EventBus,
  ) {}

  private readonly logger = new Logger("SpecImport");

  async execute(command: ImportSpecVersionCommand): Promise<ImportSpecVersionResult> {
    const project = await ownedProject(this.projects, command.organizationId, command.projectId);
    const source = command.source ?? (await this.rememberedSource(project.id));
    const raw = await this.read(project.id, source);
    if (!raw.trim())
      throw new InvalidInputError("El documento está vacío", [{ field: "source", detail: "No se recibió contenido" }]);

    const hash = fingerprint(raw);
    const existing = await this.specs.findVersionByHash(project.id, hash);
    if (existing) {
      // Identical bytes. Activation is still honoured, because "import this and use it" is a
      // reasonable thing to ask about a version that happens to already be on file.
      const activated = command.activate && project.activeSpecVersionId !== existing.id;
      if (activated) {
        await this.projects.save({ ...project, activeSpecVersionId: existing.id });
        this.eventBus.publish(new SpecVersionActivatedEvent(project.id, existing.id, command.importedBy));
      }
      return {
        specVersionId: existing.id,
        hash,
        operationCount: existing.operationCount,
        problems: existing.problems,
        unchanged: true,
        activated,
      };
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
    const sourceId = await this.recordSource(project.id, source, now);

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
    if (activate) this.eventBus.publish(new SpecVersionActivatedEvent(project.id, specVersionId, command.importedBy));

    return {
      specVersionId,
      hash,
      operationCount: parsed.operations.length,
      problems: parsed.problems,
      unchanged: false,
      activated: activate,
    };
  }

  /**
   * Where this project read its contract last time.
   *
   * Only a URL can be re-read. An inline document or an upload lives in the request that brought
   * it, and saying so is more useful than fetching an empty location and reporting that the
   * contract is empty.
   */
  private async rememberedSource(projectId: string): Promise<SpecSourceInput> {
    const stored = await this.specs.findLatestSource(projectId);
    if (!stored)
      throw new ConflictError(
        "El proyecto no tiene ninguna fuente guardada: indica de dónde leer el contrato",
        "no-spec-source",
      );
    if (stored.kind !== "url" || !stored.location) {
      throw new ConflictError(
        `La última importación de este proyecto fue ${stored.kind === "upload" ? "un fichero subido" : "un documento pegado"}, que no se puede volver a leer solo: adjunta el contrato`,
        "spec-source-not-repeatable",
      );
    }
    return { kind: "url", url: stored.location };
  }

  /**
   * The document, fetched with the credentials the project already gave us if the caller did not
   * bring their own.
   *
   * **Only for the exact same location.** Reusing a stored header against a URL the caller just
   * typed would let anybody with editor rights point the import at their own server and receive
   * somebody's staging token in the request. The match has to be on the location for the same
   * project, or nothing is sent.
   */
  private async read(projectId: string, source: SpecSourceInput): Promise<string> {
    if (source.kind !== "url") return source.raw;
    const headers = source.headers ?? (await this.storedHeaders(projectId, source.url));
    const response = await this.http.get(source.url, { headers });
    if (response.status >= 400) {
      throw new InvalidInputError(
        `El contrato respondió ${response.status}`,
        [{ field: "url", detail: `${source.url} devolvió ${response.status}` }],
        "spec-unreachable",
      );
    }
    return response.body;
  }

  private async storedHeaders(projectId: string, url: string): Promise<Record<string, string> | undefined> {
    const stored = await this.specs.findSourceByLocation(projectId, "url", url);
    if (!stored?.headersCiphertext) return undefined;
    try {
      return JSON.parse(this.cipher.decrypt(stored.headersCiphertext)) as Record<string, string>;
    } catch {
      // A ciphertext that will not open means the key changed. The import is still attempted
      // without the headers, so it fails on the contract's own 401 with a message about the
      // contract — which is closer to the truth than a 500 about a cipher.
      this.logger.warn(`Las cabeceras guardadas de ${url} no se pudieron descifrar: ¿cambió SECRETS_KEY?`);
      return undefined;
    }
  }

  /**
   * One row per location, not one per import.
   *
   * A project re-importing the same URL nightly would otherwise accumulate a source row a night,
   * each pointing at the same place, and the headers stored against the newest would be the only
   * ones anybody could find.
   */
  private async recordSource(projectId: string, source: SpecSourceInput, now: Date): Promise<string> {
    const location = source.kind === "url" ? source.url : source.kind === "upload" ? source.filename : "";
    const existing = await this.specs.findSourceByLocation(projectId, source.kind, location);
    const headers = source.kind === "url" ? source.headers : undefined;

    const id = existing?.id ?? randomUUID();
    await this.specs.saveSource({
      id,
      projectId,
      kind: source.kind,
      location,
      // Encrypted with the same cipher as the target credentials — a header carrying a bearer
      // token is exactly as much of a credential as the token itself. New headers replace the
      // stored ones; **no headers leaves what was there**, so a drift check that omits them is
      // not the same thing as an operator revoking them.
      headersCiphertext: this.encryptHeaders(headers) ?? existing?.headersCiphertext ?? null,
      createdAt: existing?.createdAt ?? now,
    });
    return id;
  }

  private encryptHeaders(headers: Record<string, string> | undefined): string | null {
    if (!headers || !Object.keys(headers).length) return null;
    try {
      return this.cipher.encrypt(JSON.stringify(headers));
    } catch {
      // No `SECRETS_KEY`. The import still succeeds — refusing it would be failing an operation
      // the operator asked for because of one we offered — but the headers are not written in
      // the clear, and the next import will ask for them again.
      this.logger.warn(
        "SECRETS_KEY no está configurada: las cabeceras del contrato no se guardan y habrá que repetirlas en cada importación",
      );
      return null;
    }
  }
}
