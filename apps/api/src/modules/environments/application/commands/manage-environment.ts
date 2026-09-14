import { randomUUID } from "node:crypto";
import { Inject } from "@nestjs/common";
import { CommandHandler, type ICommand, type ICommandHandler } from "@nestjs/cqrs";

import { VARIABLE_NAME } from "@eq/runner-core";

import { ConflictError, InvalidInputError, NotFoundError } from "@/shared/errors/domain-error";
import { CLOCK, type ClockPort } from "@/shared/clock/clock.port";
import { SECRET_CIPHER, type SecretCipherPort } from "@/shared/crypto/secret-cipher";
import { PROJECT_REPOSITORY, type ProjectRepositoryPort } from "@/modules/projects/domain/ports";
import { ownedProject } from "@/modules/projects/application/commands/update-project";
import {
  MASKED_VALUE,
  maskVariables,
  type Environment,
  type EnvironmentVariable,
  type EnvironmentVariables,
} from "../../domain/model";
import { ENVIRONMENT_REPOSITORY, type EnvironmentRepositoryPort } from "../../domain/ports";

/**
 * A variable as it arrives.
 *
 * `current` is optional and falls back to `initial`: a variable created with one value has the
 * same value in both, which is what «this is its value» means before anybody has overridden it.
 */
export type VariableInput = string | { initial?: unknown; current?: unknown; sensitive?: unknown };

export type EnvironmentInput = {
  name?: string;
  baseUrl?: string;
  specUrl?: string | null;
  variables?: Record<string, VariableInput>;
  disabledVariables?: Record<string, VariableInput>;
  writesAllowed?: boolean;
  authEnforced?: boolean;
};

export class CreateEnvironmentCommand implements ICommand {
  constructor(
    readonly organizationId: string,
    readonly projectId: string,
    readonly input: EnvironmentInput,
  ) {}
}
export class UpdateEnvironmentCommand implements ICommand {
  constructor(
    readonly organizationId: string,
    readonly projectId: string,
    readonly environmentId: string,
    readonly input: EnvironmentInput,
  ) {}
}
export class DeleteEnvironmentCommand implements ICommand {
  constructor(
    readonly organizationId: string,
    readonly projectId: string,
    readonly environmentId: string,
  ) {}
}

/** Loads an environment and refuses to admit it exists outside its project. Folded into the 404
 * for the same reason as everywhere else: a 403 would confirm the id is real. */
export async function ownedEnvironment(
  projects: ProjectRepositoryPort,
  environments: EnvironmentRepositoryPort,
  organizationId: string,
  projectId: string,
  environmentId: string,
): Promise<Environment> {
  await ownedProject(projects, organizationId, projectId);
  const environment = await environments.findById(environmentId);
  if (!environment || environment.projectId !== projectId)
    throw new NotFoundError("El entorno no existe", "environment-not-found");
  return environment;
}

/** A base URL has to be absolute and http(s). The SSRF guard checks the address at request time;
 * this rejects the shape at write time so the mistake surfaces where it was made. */
function normalizeBaseUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new InvalidInputError("La URL base no es válida", [
      { field: "baseUrl", detail: "Debe ser una URL absoluta" },
    ]);
  }
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new InvalidInputError("La URL base no es válida", [
      { field: "baseUrl", detail: "Solo se admiten http y https" },
    ]);
  }
  // Trailing slash removed once, here, so every path join downstream is `${baseUrl}${path}` and
  // nothing has to guess whether it will produce a double slash.
  return url.toString().replace(/\/+$/, "");
}

/**
 * One stored value, which is where the mask earns its keep.
 *
 * The editor is never shown a secret, so what it sends back for one it did not touch is eight
 * dots. Taking that literally is the bug the obvious implementation has: the secret becomes the
 * string `••••••••` and the run starts presenting it as a token. So the mask is read as **«leave
 * it as it was»**, and the previous ciphertext is carried over untouched.
 *
 * That also makes unticking the box work. The mask plus `sensitive: false` is «stop hiding this»,
 * and the only value that can mean is the one already stored — decrypted, because a plain
 * variable holding ciphertext would be substituted into a request verbatim.
 */
function storedValue(
  name: string,
  field: "initial" | "current",
  raw: string,
  sensitive: boolean,
  previous: EnvironmentVariable | undefined,
  cipher: SecretCipherPort,
): string {
  if (raw !== MASKED_VALUE) return sensitive && raw ? cipher.encrypt(raw) : raw;
  if (!previous?.sensitive || !previous[field])
    throw new InvalidInputError("Esa variable no tiene ningún valor oculto que conservar", [
      { field: `variables.${name}.${field}`, detail: "Escriba el valor: la máscara no es uno" },
    ]);
  return sensitive ? previous[field] : cipher.decrypt(previous[field]);
}

function normalizeVariables(
  value: Record<string, VariableInput>,
  previous: EnvironmentVariables,
  cipher: SecretCipherPort,
  field = "variables",
): EnvironmentVariables {
  // A bare string is the same variable with one value and no secret. Kept because that is what a
  // `.env` pasted into `curl` looks like, and refusing it would make the shorter, more common
  // request the one that needs a manual.
  const entries = Object.entries(value).map(
    ([key, item]) => [key, typeof item === "string" ? { initial: item } : item] as const,
  );
  const invalid = entries.find(
    ([key, item]) =>
      !VARIABLE_NAME.test(key.trim()) ||
      !item ||
      typeof item !== "object" ||
      typeof item.initial !== "string" ||
      (item.current !== undefined && typeof item.current !== "string") ||
      (item.sensitive !== undefined && typeof item.sensitive !== "boolean"),
  );
  if (invalid)
    throw new InvalidInputError("Las variables del entorno no son válidas", [
      { field: `${field}.${invalid[0]}`, detail: "Use un nombre válido y valores de texto" },
    ]);
  return Object.fromEntries(
    entries.map(([key, item]) => {
      const name = key.trim();
      const sensitive = item.sensitive === true;
      const initial = item.initial as string;
      const current = (item.current as string | undefined) ?? initial;
      return [
        name,
        {
          initial: storedValue(name, "initial", initial, sensitive, previous[name], cipher),
          current: storedValue(name, "current", current, sensitive, previous[name], cipher),
          sensitive,
        },
      ];
    }),
  );
}

/**
 * The two maps together, and disjoint.
 *
 * A switched-off variable is parked next to the map instead of flagged inside it, so that
 * `variables` stays exactly what a run substitutes and nothing downstream has to filter. The one
 * rule that buys is this: a name is in one map or in the other. Both would have to mean one of
 * the two, and whichever the code happened to pick would be a coin flip nobody could see.
 */
function normalizeBoth(
  variables: Record<string, VariableInput>,
  disabled: Record<string, VariableInput>,
  previous: EnvironmentVariables,
  cipher: SecretCipherPort,
): { variables: EnvironmentVariables; disabledVariables: EnvironmentVariables } {
  const active = normalizeVariables(variables, previous, cipher);
  const parked = normalizeVariables(disabled, previous, cipher, "disabledVariables");
  const both = Object.keys(parked).find((name) => name in active);
  if (both)
    throw new InvalidInputError("Una variable está activa y apagada a la vez", [
      { field: `disabledVariables.${both}`, detail: "Ya hay una variable activa con ese nombre" },
    ]);
  return { variables: active, disabledVariables: parked };
}

@CommandHandler(CreateEnvironmentCommand)
export class CreateEnvironmentHandler implements ICommandHandler<CreateEnvironmentCommand, { environmentId: string }> {
  constructor(
    @Inject(PROJECT_REPOSITORY) private readonly projects: ProjectRepositoryPort,
    @Inject(ENVIRONMENT_REPOSITORY) private readonly environments: EnvironmentRepositoryPort,
    @Inject(CLOCK) private readonly clock: ClockPort,
    @Inject(SECRET_CIPHER) private readonly cipher: SecretCipherPort,
  ) {}

  async execute(command: CreateEnvironmentCommand) {
    const project = await ownedProject(this.projects, command.organizationId, command.projectId);
    const name = (command.input.name ?? "").trim();
    if (!name) throw new InvalidInputError("El entorno necesita un nombre", [{ field: "name", detail: "Requerido" }]);
    if (await this.environments.findByName(project.id, name))
      throw new ConflictError("Ya hay un entorno con ese nombre", "environment-name-taken");

    const environment: Environment = {
      id: randomUUID(),
      projectId: project.id,
      name,
      baseUrl: normalizeBaseUrl(command.input.baseUrl ?? ""),
      specUrl: command.input.specUrl ?? null,
      // No previous values to carry over: an environment being created has nothing hidden yet, so
      // a mask arriving here is somebody's literal eight dots and is rejected as one.
      ...normalizeBoth(command.input.variables ?? {}, command.input.disabledVariables ?? {}, {}, this.cipher),
      // Both default to off. A run that writes to a target, and a matrix of 401 cases against a
      // backend that grants everything, are each a decision — not something inherited by
      // creating an environment.
      writesAllowed: command.input.writesAllowed ?? false,
      authEnforced: command.input.authEnforced ?? false,
      createdAt: this.clock.now(),
    };
    await this.environments.save(environment);
    // The first environment of a project is the active one. A project with environments and none
    // active is a state every screen would have to explain.
    if (!project.activeEnvironmentId) await this.projects.save({ ...project, activeEnvironmentId: environment.id });
    return { environmentId: environment.id };
  }
}

@CommandHandler(UpdateEnvironmentCommand)
export class UpdateEnvironmentHandler implements ICommandHandler<UpdateEnvironmentCommand, void> {
  constructor(
    @Inject(PROJECT_REPOSITORY) private readonly projects: ProjectRepositoryPort,
    @Inject(ENVIRONMENT_REPOSITORY) private readonly environments: EnvironmentRepositoryPort,
    @Inject(SECRET_CIPHER) private readonly cipher: SecretCipherPort,
  ) {}

  async execute(command: UpdateEnvironmentCommand): Promise<void> {
    const environment = await ownedEnvironment(
      this.projects,
      this.environments,
      command.organizationId,
      command.projectId,
      command.environmentId,
    );
    const name = command.input.name?.trim();
    if (name && name !== environment.name && (await this.environments.findByName(environment.projectId, name))) {
      throw new ConflictError("Ya hay un entorno con ese nombre", "environment-name-taken");
    }
    await this.environments.save({
      ...environment,
      name: name || environment.name,
      baseUrl: command.input.baseUrl ? normalizeBaseUrl(command.input.baseUrl) : environment.baseUrl,
      specUrl: command.input.specUrl === undefined ? environment.specUrl : command.input.specUrl,
      // Both or neither: they are one editor, and patching only half of a pair that has to stay
      // disjoint is how a name ends up in both. The half that was not sent goes back through the
      // same path *masked*, so a stored secret is carried over by the one rule that already
      // handles carrying secrets over, rather than by a second one that could disagree with it.
      ...normalizeBoth(
        command.input.variables ?? maskVariables(environment.variables),
        command.input.disabledVariables ?? maskVariables(environment.disabledVariables),
        { ...environment.variables, ...environment.disabledVariables },
        this.cipher,
      ),
      writesAllowed: command.input.writesAllowed ?? environment.writesAllowed,
      authEnforced: command.input.authEnforced ?? environment.authEnforced,
    });
  }
}

@CommandHandler(DeleteEnvironmentCommand)
export class DeleteEnvironmentHandler implements ICommandHandler<DeleteEnvironmentCommand, void> {
  constructor(
    @Inject(PROJECT_REPOSITORY) private readonly projects: ProjectRepositoryPort,
    @Inject(ENVIRONMENT_REPOSITORY) private readonly environments: EnvironmentRepositoryPort,
  ) {}

  async execute(command: DeleteEnvironmentCommand): Promise<void> {
    const environment = await ownedEnvironment(
      this.projects,
      this.environments,
      command.organizationId,
      command.projectId,
      command.environmentId,
    );
    // The credentials go with it, by the cascade in the migration. Deleting an environment and
    // leaving its stored secrets behind would be a set of credentials nothing can reach to
    // revoke.
    await this.environments.remove(environment.id);

    // Deleting the active one promotes the oldest that remains. The analyzer left the project with
    // none, and the bar kept saying «Sin entorno» next to three of them.
    const project = await this.projects.findById(environment.projectId);
    if (project && (project.activeEnvironmentId === environment.id || !project.activeEnvironmentId)) {
      const [next] = await this.environments.listForProject(project.id);
      await this.projects.save({ ...project, activeEnvironmentId: next?.id ?? null });
    }
  }
}
