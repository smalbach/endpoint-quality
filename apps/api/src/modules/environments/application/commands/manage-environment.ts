import { randomUUID } from "node:crypto";
import { Inject } from "@nestjs/common";
import { CommandHandler, type ICommand, type ICommandHandler } from "@nestjs/cqrs";

import { VARIABLE_NAME } from "@eq/runner-core";

import { ConflictError, InvalidInputError, NotFoundError } from "@/shared/errors/domain-error";
import { CLOCK, type ClockPort } from "@/shared/clock/clock.port";
import {
  archiveIn,
  deleteIn,
  restoreIn,
  type LifecycleNoun,
  type LifecycleStore,
} from "@/shared/lifecycle/lifecycle-store";
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
/** Borrar un entorno: blando por defecto, definitivo con `purge` y solo sobre algo ya eliminado. */
export class DeleteEnvironmentCommand implements ICommand {
  constructor(
    readonly organizationId: string,
    readonly projectId: string,
    readonly environmentId: string,
    readonly purge = false,
  ) {}
}

/** Archivar un entorno: sale del selector y deja de poder ejecutarse, sin perder sus variables. */
export class SetEnvironmentArchivedCommand implements ICommand {
  constructor(
    readonly organizationId: string,
    readonly projectId: string,
    readonly environmentId: string,
    readonly archived: boolean,
  ) {}
}

/** Restaurar un entorno eliminado, con sus variables y sus credenciales. */
export class RestoreEnvironmentCommand implements ICommand {
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
  // `findAnyById` y no `findById`: esto también es el camino de archivar, restaurar y mirar la
  // papelera, y un entorno eliminado que contestara 404 aquí no se podría recuperar nunca.
  const environment = await environments.findAnyById(environmentId);
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
      archivedAt: null,
      deletedAt: null,
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

/** Cómo se llama esto en los errores del ciclo de vida. */
const ENVIRONMENT: LifecycleNoun = { code: "environment", that: "El entorno", the: "el entorno" };

/**
 * El almacén de entornos con la forma que espera el servicio de ciclo de vida.
 *
 * Su puerto no lleva `projectId` en la búsqueda por id —un entorno se resuelve por id a secas
 * desde los ejecutores—, así que aquí se comprueba a mano que la fila sea de ese proyecto: sin eso,
 * archivar por id alcanzaría el entorno de otro inquilino.
 */
export const environmentStore = (environments: EnvironmentRepositoryPort): LifecycleStore<Environment> => ({
  findById: async (projectId, id) => {
    const row = await environments.findAnyById(id);
    return row && row.projectId === projectId ? row : null;
  },
  save: (row) => environments.save(row),
  remove: async (_projectId, id) => {
    await environments.remove(id);
    return true;
  },
});

/**
 * Borrar un entorno: **blando por defecto**.
 *
 * Lo que había dentro no es un nombre y una URL: son las variables que alguien fue afinando y las
 * credenciales cifradas de cada rol. El borrado duro se las llevaba por cascada, y con ellas la
 * única forma de volver a correr la matriz de autorización de ese entorno.
 *
 * Eliminarlo **sí** promueve otro como activo: la barra no puede quedarse apuntando a algo que ya
 * no sale en el selector. Restaurarlo no vuelve a robarle el puesto al que quedó activo.
 */
@CommandHandler(DeleteEnvironmentCommand)
export class DeleteEnvironmentHandler implements ICommandHandler<DeleteEnvironmentCommand, void> {
  constructor(
    @Inject(PROJECT_REPOSITORY) private readonly projects: ProjectRepositoryPort,
    @Inject(ENVIRONMENT_REPOSITORY) private readonly environments: EnvironmentRepositoryPort,
    @Inject(CLOCK) private readonly clock: ClockPort,
  ) {}

  async execute(command: DeleteEnvironmentCommand): Promise<void> {
    const environment = await ownedEnvironment(
      this.projects,
      this.environments,
      command.organizationId,
      command.projectId,
      command.environmentId,
    );
    // En el definitivo las credenciales se van con él, por la cascada de la migración: un entorno
    // borrado dejando atrás sus secretos sería un juego de credenciales que nada puede revocar.
    await deleteIn(
      environmentStore(this.environments),
      command.projectId,
      environment.id,
      command.purge,
      this.clock.now(),
      ENVIRONMENT,
    );
    await promoteActive(this.projects, this.environments, environment);
  }
}

@CommandHandler(SetEnvironmentArchivedCommand)
export class SetEnvironmentArchivedHandler implements ICommandHandler<SetEnvironmentArchivedCommand, void> {
  constructor(
    @Inject(PROJECT_REPOSITORY) private readonly projects: ProjectRepositoryPort,
    @Inject(ENVIRONMENT_REPOSITORY) private readonly environments: EnvironmentRepositoryPort,
    @Inject(CLOCK) private readonly clock: ClockPort,
  ) {}

  async execute(command: SetEnvironmentArchivedCommand): Promise<void> {
    const environment = await ownedEnvironment(
      this.projects,
      this.environments,
      command.organizationId,
      command.projectId,
      command.environmentId,
    );
    await archiveIn(
      environmentStore(this.environments),
      command.projectId,
      environment.id,
      command.archived,
      this.clock.now(),
      ENVIRONMENT,
    );
    // Archivar el activo deja la barra apuntando a algo que ya no sale en el selector.
    await promoteActive(this.projects, this.environments, environment);
  }
}

@CommandHandler(RestoreEnvironmentCommand)
export class RestoreEnvironmentHandler implements ICommandHandler<RestoreEnvironmentCommand, void> {
  constructor(
    @Inject(PROJECT_REPOSITORY) private readonly projects: ProjectRepositoryPort,
    @Inject(ENVIRONMENT_REPOSITORY) private readonly environments: EnvironmentRepositoryPort,
    @Inject(CLOCK) private readonly clock: ClockPort,
  ) {}

  async execute(command: RestoreEnvironmentCommand): Promise<void> {
    const environment = await ownedEnvironment(
      this.projects,
      this.environments,
      command.organizationId,
      command.projectId,
      command.environmentId,
    );
    // El nombre pudo reutilizarse mientras estaba fuera: `findByName` solo mira los vivos.
    if (environment.deletedAt && (await this.environments.findByName(command.projectId, environment.name)))
      throw new ConflictError("Ya hay un entorno con ese nombre", "environment-name-taken");
    await restoreIn(
      environmentStore(this.environments),
      command.projectId,
      environment.id,
      this.clock.now(),
      ENVIRONMENT,
    );
  }
}

/**
 * Deja el entorno activo apuntando a algo que de verdad se pueda usar.
 *
 * La pregunta no es «¿se ha borrado este?» sino «¿el activo sigue vivo?», que es la que importa:
 * archivar el activo lo saca del selector igual que eliminarlo, y la barra no puede quedarse
 * señalando algo que ya no aparece. El analizador dejaba el proyecto sin ninguno, y la barra seguía
 * diciendo «Sin entorno» al lado de tres.
 */
export async function promoteActive(
  projects: ProjectRepositoryPort,
  environments: EnvironmentRepositoryPort,
  environment: Environment,
): Promise<void> {
  const project = await projects.findById(environment.projectId);
  if (!project) return;
  const active = project.activeEnvironmentId ? await environments.findById(project.activeEnvironmentId) : null;
  if (active) return;
  const [next] = await environments.listForProject(project.id);
  await projects.save({ ...project, activeEnvironmentId: next?.id ?? null });
}
