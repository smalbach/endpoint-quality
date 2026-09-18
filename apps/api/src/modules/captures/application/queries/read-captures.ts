/**
 * Leer las capturas: si la captura está activada, las sesiones de un proyecto y lo que grabaron.
 *
 * La lista en vivo se lee por **cursor** (`after`, el último `seq` que la pantalla ya tiene) y sin
 * cuerpos: una sesión de quinientas peticiones con 64 kB por cuerpo son treinta megas, y la pantalla
 * pregunta cada segundo y medio. Los cuerpos se piden de uno en uno, al abrir una petición.
 */
import { Inject } from "@nestjs/common";
import { QueryHandler, type IQuery, type IQueryHandler } from "@nestjs/cqrs";
import type { CaptureItemView, CaptureOverviewView, CapturePageView } from "@eq/contracts";

import { NotFoundError } from "@/shared/errors/domain-error";
import { PROJECT_REPOSITORY, type ProjectRepositoryPort } from "@/modules/projects/domain/ports";
import { ownedProject } from "@/modules/projects/application/commands/update-project";
import { viewCaptureItem, viewCaptureItemSummary, viewCaptureSession } from "../../domain/model";
import { CAPTURE_REPOSITORY, type CaptureRepositoryPort } from "../../domain/ports";
import { CAPTURE_PROXY_USERNAME, CaptureProxyService } from "../../infrastructure/capture-proxy.service";

/** Cuántas sesiones se enseñan. Las viejas siguen ahí hasta que alguien las borra. */
const RECENT_SESSIONS = 10;
/** Cuántas filas trae una página de la lista en vivo. */
export const CAPTURE_PAGE = 200;

export class GetCapturesQuery implements IQuery {
  constructor(
    readonly organizationId: string,
    readonly projectId: string,
  ) {}
}

@QueryHandler(GetCapturesQuery)
export class GetCapturesHandler implements IQueryHandler<GetCapturesQuery, CaptureOverviewView> {
  constructor(
    @Inject(PROJECT_REPOSITORY) private readonly projects: ProjectRepositoryPort,
    @Inject(CAPTURE_REPOSITORY) private readonly captures: CaptureRepositoryPort,
    private readonly proxy: CaptureProxyService,
  ) {}

  async execute(query: GetCapturesQuery): Promise<CaptureOverviewView> {
    const project = await ownedProject(this.projects, query.organizationId, query.projectId);
    const sessions = await this.captures.listSessions(project.id, RECENT_SESSIONS);
    const port = this.proxy.port;
    return {
      enabled: this.proxy.enabled,
      proxy:
        this.proxy.enabled && port !== null
          ? { host: this.proxy.publicHost, port, username: CAPTURE_PROXY_USERNAME }
          : null,
      sessions: sessions.map(viewCaptureSession),
    };
  }
}

export class GetCapturePageQuery implements IQuery {
  constructor(
    readonly organizationId: string,
    readonly projectId: string,
    readonly sessionId: string,
    readonly after: number,
  ) {}
}

@QueryHandler(GetCapturePageQuery)
export class GetCapturePageHandler implements IQueryHandler<GetCapturePageQuery, CapturePageView> {
  constructor(
    @Inject(PROJECT_REPOSITORY) private readonly projects: ProjectRepositoryPort,
    @Inject(CAPTURE_REPOSITORY) private readonly captures: CaptureRepositoryPort,
  ) {}

  async execute(query: GetCapturePageQuery): Promise<CapturePageView> {
    const project = await ownedProject(this.projects, query.organizationId, query.projectId);
    const session = await this.captures.findSession(project.id, query.sessionId);
    if (!session) throw new NotFoundError("Esa sesión de captura no existe", "capture-not-found");
    const items = await this.captures.listItems(project.id, session.id, Math.max(0, query.after), CAPTURE_PAGE);
    return { session: viewCaptureSession(session), items: items.map(viewCaptureItemSummary) };
  }
}

export class GetCaptureItemQuery implements IQuery {
  constructor(
    readonly organizationId: string,
    readonly projectId: string,
    readonly sessionId: string,
    readonly itemId: string,
  ) {}
}

@QueryHandler(GetCaptureItemQuery)
export class GetCaptureItemHandler implements IQueryHandler<GetCaptureItemQuery, CaptureItemView> {
  constructor(
    @Inject(PROJECT_REPOSITORY) private readonly projects: ProjectRepositoryPort,
    @Inject(CAPTURE_REPOSITORY) private readonly captures: CaptureRepositoryPort,
  ) {}

  async execute(query: GetCaptureItemQuery): Promise<CaptureItemView> {
    const project = await ownedProject(this.projects, query.organizationId, query.projectId);
    const [item] = await this.captures.findItems(project.id, query.sessionId, [query.itemId]);
    if (!item) throw new NotFoundError("Esa petición capturada no existe", "capture-item-not-found");
    return viewCaptureItem(item);
  }
}

export const CAPTURE_QUERY_HANDLERS = [GetCapturesHandler, GetCapturePageHandler, GetCaptureItemHandler];
