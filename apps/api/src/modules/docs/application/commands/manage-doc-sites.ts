/**
 * Crear, cambiar, rotar la clave y borrar sitios de documentación.
 *
 * Mismo trato que los mocks, y por las mismas razones: la clave de un sitio privado **se enseña una
 * vez** y de ella se guarda el hash; pasar de privado a público no borra la clave, deja de pedirla;
 * y volver a privado sigue pidiendo la de siempre en vez de invalidar en silencio a quien la tenía.
 *
 * Lo propio de aquí es que **cambiar la visibilidad no despublica lo que ya se leyó**, y la pantalla
 * lo dice. Una URL pública que ya circula sigue circulando: lo que se puede hacer es dejar de
 * contestar en ella, no borrarla de donde esté pegada.
 */
import { Inject } from "@nestjs/common";
import { CommandHandler, type ICommand, type ICommandHandler } from "@nestjs/cqrs";

import { CLOCK, type ClockPort } from "@/shared/clock/clock.port";
import { ConflictError, InvalidInputError, NotFoundError } from "@/shared/errors/domain-error";
import { PROJECT_REPOSITORY, type ProjectRepositoryPort } from "@/modules/projects/domain/ports";
import { writableProject } from "@/modules/endpoints/application/commands/manage-endpoints";
import {
  MAX_DOC_SITES_PER_PROJECT,
  blankDocSite,
  docSiteProblems,
  normalizeBaseUrl,
  rotatedDocKey,
  viewDocSite,
  type DocSiteInput,
  type DocSiteView,
  type DocVisibility,
} from "../../domain/model";
import { DOC_SITE_REPOSITORY, type DocSiteRepositoryPort } from "../../domain/ports";

/** Lo que devuelve crear o rotar: el sitio y, una sola vez, la clave. */
export type IssuedDocSite = { site: DocSiteView; apiKey: string | null };

export class CreateDocSiteCommand implements ICommand {
  constructor(
    readonly organizationId: string,
    readonly projectId: string,
    readonly name: string,
    /** Sin valor por defecto: publicar la API de un proyecto es una decisión, no una omisión. */
    readonly visibility: DocVisibility,
    readonly input: { baseUrl?: string; intro?: string; includeExamples?: boolean },
    readonly actorId: string,
  ) {}
}

@CommandHandler(CreateDocSiteCommand)
export class CreateDocSiteHandler implements ICommandHandler<CreateDocSiteCommand, IssuedDocSite> {
  constructor(
    @Inject(PROJECT_REPOSITORY) private readonly projects: ProjectRepositoryPort,
    @Inject(DOC_SITE_REPOSITORY) private readonly sites: DocSiteRepositoryPort,
    @Inject(CLOCK) private readonly clock: ClockPort,
  ) {}

  async execute(command: CreateDocSiteCommand): Promise<IssuedDocSite> {
    const project = await writableProject(this.projects, command.organizationId, command.projectId);
    const problems = docSiteProblems(
      { name: command.name, visibility: command.visibility, ...command.input },
      { requireVisibility: true },
    );
    if (problems.length) throw new InvalidInputError("La documentación no es válida", problems);

    const existing = await this.sites.listByProject(project.id);
    if (existing.length >= MAX_DOC_SITES_PER_PROJECT) {
      throw new ConflictError(
        `Este proyecto ya tiene ${MAX_DOC_SITES_PER_PROJECT} documentaciones publicadas: borra alguna antes de crear otra`,
        "doc-sites-full",
      );
    }
    if (existing.some((row) => row.name === command.name.trim()))
      throw new ConflictError(`Ya hay una documentación llamada «${command.name.trim()}»`, "doc-site-duplicate-name");

    const created = blankDocSite({
      projectId: project.id,
      name: command.name.trim(),
      visibility: command.visibility,
      baseUrl: command.input.baseUrl,
      intro: command.input.intro,
      includeExamples: command.input.includeExamples,
      now: this.clock.now(),
      actorId: command.actorId,
    });
    await this.sites.save(created.site);
    return { site: viewDocSite(created.site), apiKey: created.apiKey };
  }
}

/** Lo mismo más la clave, cuando pasar a privado ha tenido que crear una. */
export type UpdatedDocSite = DocSiteView & { apiKey?: string };

export class UpdateDocSiteCommand implements ICommand {
  constructor(
    readonly organizationId: string,
    readonly projectId: string,
    readonly siteId: string,
    readonly input: DocSiteInput,
  ) {}
}

@CommandHandler(UpdateDocSiteCommand)
export class UpdateDocSiteHandler implements ICommandHandler<UpdateDocSiteCommand, UpdatedDocSite> {
  constructor(
    @Inject(PROJECT_REPOSITORY) private readonly projects: ProjectRepositoryPort,
    @Inject(DOC_SITE_REPOSITORY) private readonly sites: DocSiteRepositoryPort,
    @Inject(CLOCK) private readonly clock: ClockPort,
  ) {}

  async execute(command: UpdateDocSiteCommand): Promise<UpdatedDocSite> {
    const project = await writableProject(this.projects, command.organizationId, command.projectId);
    const current = await this.sites.findById(project.id, command.siteId);
    if (!current) throw new NotFoundError("Esa documentación no existe", "doc-site-not-found");

    const problems = docSiteProblems(command.input);
    if (problems.length) throw new InvalidInputError("La documentación no es válida", problems);

    const name = command.input.name?.trim();
    if (name && name !== current.name) {
      const siblings = await this.sites.listByProject(project.id);
      if (siblings.some((row) => row.id !== current.id && row.name === name))
        throw new ConflictError(`Ya hay una documentación llamada «${name}»`, "doc-site-duplicate-name");
    }

    const visibility = command.input.visibility ?? current.visibility;
    // Pasar a privado un sitio que nunca tuvo clave necesita una, o pediría una cabecera que nadie
    // puede mandar y quedaría cerrado para siempre.
    const issued = visibility === "private" && !current.apiKeyHash ? rotatedDocKey(current, this.clock.now()) : null;
    const updated = {
      ...(issued?.site ?? current),
      name: name || current.name,
      visibility,
      baseUrl: command.input.baseUrl === undefined ? current.baseUrl : normalizeBaseUrl(command.input.baseUrl),
      intro: command.input.intro === undefined ? current.intro : command.input.intro.trim(),
      includeExamples: command.input.includeExamples ?? current.includeExamples,
      enabled: command.input.enabled ?? current.enabled,
      updatedAt: this.clock.now(),
    };
    await this.sites.save(updated);
    // Si ha habido que crear una clave, sale aquí: es la única vez que se puede ver.
    return issued ? { ...viewDocSite(updated), apiKey: issued.apiKey } : viewDocSite(updated);
  }
}

/** La clave vieja deja de valer en el mismo momento, que es de lo que sirve rotar. */
export class RotateDocSiteKeyCommand implements ICommand {
  constructor(
    readonly organizationId: string,
    readonly projectId: string,
    readonly siteId: string,
  ) {}
}

@CommandHandler(RotateDocSiteKeyCommand)
export class RotateDocSiteKeyHandler implements ICommandHandler<RotateDocSiteKeyCommand, IssuedDocSite> {
  constructor(
    @Inject(PROJECT_REPOSITORY) private readonly projects: ProjectRepositoryPort,
    @Inject(DOC_SITE_REPOSITORY) private readonly sites: DocSiteRepositoryPort,
    @Inject(CLOCK) private readonly clock: ClockPort,
  ) {}

  async execute(command: RotateDocSiteKeyCommand): Promise<IssuedDocSite> {
    const project = await writableProject(this.projects, command.organizationId, command.projectId);
    const current = await this.sites.findById(project.id, command.siteId);
    if (!current) throw new NotFoundError("Esa documentación no existe", "doc-site-not-found");
    if (current.visibility !== "private")
      throw new ConflictError("Una documentación pública no tiene clave que rotar", "doc-site-not-private");

    const issued = rotatedDocKey(current, this.clock.now());
    await this.sites.save(issued.site);
    return { site: viewDocSite(issued.site), apiKey: issued.apiKey };
  }
}

export class DeleteDocSiteCommand implements ICommand {
  constructor(
    readonly organizationId: string,
    readonly projectId: string,
    readonly siteId: string,
  ) {}
}

@CommandHandler(DeleteDocSiteCommand)
export class DeleteDocSiteHandler implements ICommandHandler<DeleteDocSiteCommand, void> {
  constructor(
    @Inject(PROJECT_REPOSITORY) private readonly projects: ProjectRepositoryPort,
    @Inject(DOC_SITE_REPOSITORY) private readonly sites: DocSiteRepositoryPort,
  ) {}

  async execute(command: DeleteDocSiteCommand): Promise<void> {
    const project = await writableProject(this.projects, command.organizationId, command.projectId);
    const gone = await this.sites.remove(project.id, command.siteId);
    if (!gone) throw new NotFoundError("Esa documentación no existe", "doc-site-not-found");
  }
}
