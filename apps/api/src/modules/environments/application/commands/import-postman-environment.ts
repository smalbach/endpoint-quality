import { randomUUID } from "node:crypto";
import { Inject } from "@nestjs/common";
import { CommandHandler, type ICommand, type ICommandHandler } from "@nestjs/cqrs";
import type { PostmanEnvironmentImportResult } from "@eq/contracts";

import { InvalidInputError } from "@/shared/errors/domain-error";
import { CLOCK, type ClockPort } from "@/shared/clock/clock.port";
import { SECRET_CIPHER, type SecretCipherPort } from "@/shared/crypto/secret-cipher";
import { PROJECT_REPOSITORY, type ProjectRepositoryPort } from "@/modules/projects/domain/ports";
import { ownedProject } from "@/modules/projects/application/commands/update-project";
import { readPostmanEnvironment, type ImportedVariable } from "../../domain/import-postman-environment";
import type { Environment, EnvironmentVariables } from "../../domain/model";
import { ENVIRONMENT_REPOSITORY, type EnvironmentRepositoryPort } from "../../domain/ports";

export class ImportPostmanEnvironmentCommand implements ICommand {
  constructor(
    readonly organizationId: string,
    readonly projectId: string,
    readonly input: { text: string; name?: string; baseUrl?: string },
  ) {}
}

export type ImportPostmanEnvironmentOutcome = PostmanEnvironmentImportResult;

/**
 * A Postman environment file, as an environment of this project.
 *
 * **Created or updated by name**, the same rule the flow import follows and for the same reason:
 * re-exporting an environment after adding a variable is the ordinary case, and a second «Catalog
 * API — local» would leave somebody to work out which of the two a run is using.
 *
 * What an update does **not** touch is the part that is a decision taken here and not in Postman:
 * `writesAllowed`, `authEnforced`, and — crucially — **a value already stored for a variable the
 * file leaves empty**. A committed environment file has its secrets blanked, which is exactly
 * right of it; letting that blank overwrite the token somebody typed last week would make the
 * second import of the same file a way to break a working environment.
 *
 * Nothing here decrypts anything. A secret that is being kept is carried over as the ciphertext it
 * already is, and a new one is encrypted on the way in.
 */
@CommandHandler(ImportPostmanEnvironmentCommand)
export class ImportPostmanEnvironmentHandler implements ICommandHandler<
  ImportPostmanEnvironmentCommand,
  ImportPostmanEnvironmentOutcome
> {
  constructor(
    @Inject(PROJECT_REPOSITORY) private readonly projects: ProjectRepositoryPort,
    @Inject(ENVIRONMENT_REPOSITORY) private readonly environments: EnvironmentRepositoryPort,
    @Inject(CLOCK) private readonly clock: ClockPort,
    @Inject(SECRET_CIPHER) private readonly cipher: SecretCipherPort,
  ) {}

  async execute(command: ImportPostmanEnvironmentCommand): Promise<ImportPostmanEnvironmentOutcome> {
    const project = await ownedProject(this.projects, command.organizationId, command.projectId);
    const draft = readPostmanEnvironment(command.input.text);
    if (!draft) {
      throw new InvalidInputError(
        "El fichero no es un entorno de Postman",
        [{ field: "text", detail: "No es JSON. Exporta el entorno desde Postman y vuelve a intentarlo" }],
        "postman-invalid",
      );
    }
    const total = Object.keys(draft.variables).length + Object.keys(draft.disabledVariables).length;
    if (!total) {
      throw new InvalidInputError(
        "El fichero no trae ninguna variable",
        [{ field: "text", detail: "Se leyó como Postman y no contiene valores con nombre" }],
        "nothing-to-import",
      );
    }

    const name = (command.input.name?.trim() || draft.name.trim() || "Entorno importado").slice(0, 80);
    const previous = await this.environments.findByName(project.id, name);
    // The file's own base URL, unless the caller said otherwise — which is what makes a Postman
    // `http://localhost:8000` reachable from wherever this API actually runs.
    const baseUrl = command.input.baseUrl?.trim() || draft.baseUrl || previous?.baseUrl || "";
    if (!baseUrl) {
      throw new InvalidInputError(
        "El entorno no dice contra qué URL se ejecuta",
        [
          {
            field: "baseUrl",
            detail: "Ninguna variable del fichero es una URL absoluta (baseUrl, host, url…). Escríbela.",
          },
        ],
        "base-url-missing",
      );
    }

    const notes = [...draft.notes];
    if (draft.baseUrlFrom && !command.input.baseUrl) {
      notes.push(`La URL base sale de la variable «${draft.baseUrlFrom}», que además se conserva como variable.`);
    }

    const kept: string[] = [];
    const merge = (rows: Record<string, ImportedVariable>, stored: EnvironmentVariables): EnvironmentVariables =>
      Object.fromEntries(
        Object.entries(rows).map(([variable, row]) => {
          const before = stored[variable];
          // An empty value in the file never wins over one already here: that is how a committed
          // file with its secrets blanked stops being a way to wipe them.
          if (!row.initial && before && (before.initial || before.current)) {
            kept.push(variable);
            return [variable, { ...before, sensitive: row.sensitive || before.sensitive }];
          }
          const value = row.sensitive && row.initial ? this.cipher.encrypt(row.initial) : row.initial;
          return [variable, { initial: value, current: value, sensitive: row.sensitive }];
        }),
      );

    const before = previous ? { ...previous.variables, ...previous.disabledVariables } : ({} as EnvironmentVariables);
    const variables = merge(draft.variables, before);
    const disabledVariables = merge(draft.disabledVariables, before);
    if (kept.length) {
      notes.push(`Venían en blanco y se conservó lo que ya había aquí: ${kept.join(", ")}.`);
    }

    const environment: Environment = {
      id: previous?.id ?? randomUUID(),
      projectId: project.id,
      name,
      baseUrl: baseUrl.replace(/\/+$/, ""),
      specUrl: previous?.specUrl ?? null,
      // What the file does not bring is merged over what is here, so a variable somebody added by
      // hand survives an import that does not mention it.
      variables: { ...(previous?.variables ?? {}), ...variables },
      disabledVariables: { ...(previous?.disabledVariables ?? {}), ...disabledVariables },
      // Two decisions that are this project's and never Postman's: whether a run may write to the
      // target, and whether the target really enforces authorization.
      writesAllowed: previous?.writesAllowed ?? false,
      authEnforced: previous?.authEnforced ?? false,
      createdAt: previous?.createdAt ?? this.clock.now(),
    };
    await this.environments.save(environment);
    if (!project.activeEnvironmentId) {
      await this.projects.save({ ...project, activeEnvironmentId: environment.id });
    }

    return {
      id: environment.id,
      name: environment.name,
      action: previous ? "updated" : "created",
      baseUrl: environment.baseUrl,
      variables: Object.keys(variables).length,
      disabledVariables: Object.keys(disabledVariables).length,
      secrets: Object.values(variables).filter((variable) => variable.sensitive).length,
      skipped: draft.skipped,
      notes,
    };
  }
}
