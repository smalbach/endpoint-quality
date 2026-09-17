import { CommandBus, CommandHandler, type ICommand, type ICommandHandler } from "@nestjs/cqrs";
import { Inject } from "@nestjs/common";
import { detectImport, targetsOf, type DetectedPiece } from "@eq/import-detect";
import type {
  ImportAnythingResult,
  ImportedItemResult,
  PostmanEnvironmentImportResult,
  PostmanFlowsImportResult,
  ProjectBundleImportResultView,
} from "@eq/contracts";

import { InvalidInputError } from "@/shared/errors/domain-error";
import { SAFE_FETCH, type SafeFetchPort } from "@/shared/http/safe-fetch";
import { ImportSpecVersionCommand } from "@/modules/specs/application/commands/import-spec-version";
import { ImportEndpointFileCommand } from "@/modules/endpoints/application/commands/import-endpoints";
import { ImportPostmanFlowsCommand } from "@/modules/workflows/application/commands/import-postman-flows";
import { ImportPostmanEnvironmentCommand } from "@/modules/environments/application/commands/import-postman-environment";
import { PROJECT_REPOSITORY, type ProjectRepositoryPort } from "../../domain/ports";
import { ImportProjectBundleCommand } from "./import-project-bundle";
import { ownedProject } from "./update-project";

/** One thing handed over: a file's name and text, or a paste with no name. */
export type ImportSource = { name?: string; text: string };

export class ImportAnythingCommand implements ICommand {
  constructor(
    readonly organizationId: string,
    readonly projectId: string,
    readonly input: {
      /** Files or pastes. */
      sources?: ImportSource[];
      /** A link to read one from, through the same SSRF guard as every other request. */
      url?: string;
      /** Only say what was found and where it would go. Nothing is written. */
      dryRun?: boolean;
      /** The base URL any environment in the batch is stored with, overriding the file's. */
      baseUrl?: string;
    },
    readonly actorId: string,
  ) {}
}

/**
 * One import, the way Postman does it: hand over the things, it works out what they are.
 *
 * The panels this replaces asked the person to answer a question the file already answers — and
 * there were **six** of them: a file of endpoints on the endpoints page, a Postman collection in
 * the flows drawer, an exported project in the same drawer behind a different button, a contract
 * in the settings, and two more. Six doors, each reading a subset of the formats, each silent
 * about the parts of the file it threw away. Dropping a collection on the endpoints door produced
 * endpoints and no flows, and nothing said so.
 *
 * So this is a router and not a reader. Every format was already understood by the module that
 * owns its destination — the contract by `specs`, the endpoints by `endpoints`, the graphs by
 * `workflows`, the variables by `environments`, a whole exported project by its own bundle
 * importer — and re-reading any of them here would be a second parser free to disagree with the
 * first. What is new is `detectImport`, which lives in a package of its own so the browser can
 * name what you dropped before anything is sent, and the order below.
 *
 * **The order is not incidental.** A contract first, because whether the project has one decides
 * whether a collection's requests become saved requests of the contract's operations or loose
 * `fetch` calls — so a dump holding both an OpenAPI document and a collection produces linked
 * flows, and the same two files imported in the other order would not. Then the environments,
 * which is what the flows will need to run. Then the collections.
 *
 * **One failure does not sink the batch.** Four files where the second is a v1 collection has to
 * import the other three and name the second, which is why every piece is caught and reported
 * rather than thrown.
 */
@CommandHandler(ImportAnythingCommand)
export class ImportAnythingHandler implements ICommandHandler<ImportAnythingCommand, ImportAnythingResult> {
  constructor(
    private readonly commandBus: CommandBus,
    @Inject(PROJECT_REPOSITORY) private readonly projects: ProjectRepositoryPort,
    @Inject(SAFE_FETCH) private readonly http: SafeFetchPort,
  ) {}

  async execute(command: ImportAnythingCommand): Promise<ImportAnythingResult> {
    // Before anything is read, let alone written. Without it a bad project id reached four
    // handlers and came back as four Postgres messages inside a 201, which reads as «el import
    // funcionó pero todo falló» instead of «ese proyecto no existe».
    await ownedProject(this.projects, command.organizationId, command.projectId);

    const sources = [...(command.input.sources ?? [])];
    if (command.input.url) sources.push(await this.read(command.input.url));
    if (!sources.length) {
      throw new InvalidInputError(
        "No hay nada que importar",
        [{ field: "sources", detail: "Adjunta un fichero, pega el texto o da una URL" }],
        "nothing-to-import",
      );
    }

    const detected = sources.map((source) => detectImport(source.name ?? "", source.text));
    const items: ImportedItemResult[] = detected.map((entry) => ({
      name: entry.name,
      kind: entry.kind,
      pieces: entry.pieces.map((piece) => ({ kind: piece.kind, name: piece.name, detail: piece.detail })),
      reason: entry.reason,
      results: [],
    }));
    // Read-only: what was found and where it would go, with nothing written. The dialog now
    // detects locally and does not need this, but a caller that is not the dialog — a script, a
    // pipeline — still wants to ask before it writes.
    if (command.input.dryRun) return { items, dryRun: true };

    // Every piece of every source, in the order the destinations depend on each other.
    const ordered: { piece: DetectedPiece; item: ImportedItemResult }[] = [];
    const RANK: Record<DetectedPiece["kind"], number> = {
      openapi: 0,
      "postman-environment": 1,
      "postman-collection": 2,
      insomnia: 3,
      curl: 4,
      // Last: an exported project brings its own contract, environments and flows, and the merge
      // rules that keep what is already here are its own. It has no business running before the
      // pieces whose linking it would change.
      "eq-bundle": 5,
    };
    for (const [index, entry] of detected.entries()) {
      for (const piece of entry.pieces) ordered.push({ piece, item: items[index] });
    }
    ordered.sort((left, right) => RANK[left.piece.kind] - RANK[right.piece.kind]);

    for (const { piece, item } of ordered) {
      try {
        item.results.push(...(await this.importPiece(command, piece)));
      } catch (error) {
        item.results.push({
          target: targetsOf(piece.kind)[0],
          name: piece.name,
          summary: null,
          error: message(error),
        });
      }
    }
    return { items, dryRun: false };
  }

  /** One piece, into the module that owns its destination. */
  private async importPiece(
    command: ImportAnythingCommand,
    piece: DetectedPiece,
  ): Promise<ImportedItemResult["results"]> {
    const { organizationId, projectId, actorId } = command;
    switch (piece.kind) {
      case "openapi": {
        const result = await this.commandBus.execute<
          ImportSpecVersionCommand,
          { operationCount: number; unchanged: boolean; activated: boolean }
        >(new ImportSpecVersionCommand(organizationId, projectId, { kind: "inline", raw: piece.text }, actorId, true));
        return [
          {
            target: "contract",
            name: piece.name,
            summary: result.unchanged
              ? `sin cambios · ${result.operationCount} operaciones`
              : `${result.operationCount} operaciones${result.activated ? " · activado" : ""}`,
            error: null,
          },
        ];
      }
      case "postman-environment": {
        const result = await this.commandBus.execute<ImportPostmanEnvironmentCommand, PostmanEnvironmentImportResult>(
          new ImportPostmanEnvironmentCommand(organizationId, projectId, {
            text: piece.text,
            ...(command.input.baseUrl ? { baseUrl: command.input.baseUrl } : {}),
          }),
        );
        return [
          {
            target: "environment",
            name: result.name,
            summary: `${result.action === "created" ? "nuevo" : "actualizado"} · ${result.variables} variables (${result.secrets} secretas) · ${result.baseUrl}`,
            error: null,
          },
        ];
      }
      case "eq-bundle": {
        // Everything the file carries **except its settings**: a project's name, base URL and auth
        // are its identity, and somebody dropping a file into a project they already have is
        // bringing content, not renaming what they are standing in.
        const result = await this.commandBus.execute<ImportProjectBundleCommand, ProjectBundleImportResultView>(
          new ImportProjectBundleCommand(
            organizationId,
            projectId,
            JSON.parse(piece.text),
            BUNDLE_PARTS_WITHOUT_SETTINGS,
            actorId,
          ),
        );
        const counted: [string, number | string | null][] = [
          ["contrato", result.contract],
          ["endpoints", result.endpoints],
          ["peticiones", result.requestTemplates],
          ["flujos", result.workflows],
          ["entornos", result.environments],
          ["roles", result.roles],
          ["suites", result.suites],
          ["planes", result.performancePlans],
        ];
        return [
          {
            target: "project",
            name: piece.name,
            summary:
              counted
                .filter(([, value]) => value)
                .map(([label, value]) => (typeof value === "number" ? `${value} ${label}` : `${label} ${value}`))
                .join(" · ") || "no trajo nada nuevo",
            error: null,
            ...(result.skipped.length
              ? { notes: result.skipped.map((entry) => `${entry.what}: ${entry.detail}`) }
              : {}),
          },
        ];
      }
      case "postman-collection":
      case "insomnia":
      case "curl": {
        const results: ImportedItemResult["results"] = [];
        // The URLs, as endpoints of the project. `.json` and `.txt` are what the reader tells
        // JSON from a page of `curl` by, so the name it is given has to match the piece.
        const filename = piece.kind === "curl" ? `${piece.name || "pegado"}.txt` : `${piece.name || "pegado"}.json`;
        try {
          const endpoints = await this.commandBus.execute<
            ImportEndpointFileCommand,
            { imported: unknown[]; skipped: { reason: string }[] }
          >(new ImportEndpointFileCommand(organizationId, projectId, filename, piece.text, actorId));
          // «46 sin importar» reads as a failure and means «el proyecto ya los tenía», which is the
          // normal outcome of importing a collection over its own contract. The two are counted
          // apart so nobody goes looking for a problem that is not there.
          const present = endpoints.skipped.filter((entry) => /ya tiene/i.test(entry.reason)).length;
          const rest = endpoints.skipped.length - present;
          results.push({
            target: "endpoints",
            name: piece.name,
            summary: [
              `${endpoints.imported.length} nuevos`,
              present ? `${present} ya estaban` : "",
              rest ? `${rest} sin importar` : "",
            ]
              .filter(Boolean)
              .join(" · "),
            error: null,
          });
        } catch (error) {
          results.push({ target: "endpoints", name: piece.name, summary: null, error: message(error) });
        }
        // And the graphs, which only a Postman collection describes: the folders and the scripts.
        if (piece.kind === "postman-collection") {
          try {
            const flows = await this.commandBus.execute<ImportPostmanFlowsCommand, PostmanFlowsImportResult>(
              new ImportPostmanFlowsCommand(organizationId, projectId, { text: piece.text }, actorId),
            );
            results.push({
              target: "flows",
              name: piece.name,
              summary: flows.flows
                .map(
                  (flow) =>
                    `${flow.name} (${flow.action === "created" ? "nuevo" : "actualizado"}, ${flow.steps} nodos)`,
                )
                .join(" · "),
              error: null,
              notes: flows.notes,
            });
          } catch (error) {
            results.push({ target: "flows", name: piece.name, summary: null, error: message(error) });
          }
        }
        return results;
      }
    }
  }

  /**
   * A link, read through the guard every other outbound request goes through.
   *
   * The same reason the contract import has one: a URL somebody pastes is a URL this process is
   * being asked to fetch, and without the guard «importa esto» is a way to make the server read
   * something on its own network.
   */
  private async read(url: string): Promise<ImportSource> {
    let response: Awaited<ReturnType<SafeFetchPort["request"]>>;
    try {
      response = await this.http.request(url, {
        method: "GET",
        headers: { Accept: "application/json, text/yaml, */*" },
      });
    } catch (error) {
      throw new InvalidInputError(
        "No se pudo leer la URL",
        [{ field: "url", detail: message(error) }],
        "url-unreadable",
      );
    }
    if (response.status >= 400) {
      throw new InvalidInputError(
        "La URL no contestó con el documento",
        [{ field: "url", detail: `Contestó ${response.status}` }],
        "url-unreadable",
      );
    }
    // The last segment of the path as the name, which is what a browser would have called it.
    const name = url.split("?")[0].split("/").filter(Boolean).pop() ?? url;
    return { name, text: response.body };
  }
}

/** Named rather than inlined so the one part deliberately left out is visible from the outside. */
const BUNDLE_PARTS_WITHOUT_SETTINGS = [
  "contract",
  "config",
  "endpoints",
  "roles",
  "flows",
  "environments",
  "performance",
];

const message = (error: unknown): string => (error instanceof Error ? error.message : "No se pudo importar");
