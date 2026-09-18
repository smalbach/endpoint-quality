import { Inject, Injectable } from "@nestjs/common";
import type { MergeRequestDetailView, MergeRequestEventView, MergeRequestSummaryView } from "@eq/contracts";

import { NotFoundError } from "@/shared/errors/domain-error";
import { USER_REPOSITORY, type UserRepositoryPort } from "@/modules/auth/domain/ports";
import type { ForkMergeRequest, MergeRequestEvent } from "../domain/merge-request";
import { PENDING_STATUSES, transition } from "../domain/merge-request";
import {
  MERGE_REQUEST_REPOSITORY,
  PROJECT_REPOSITORY,
  type MergeRequestRepositoryPort,
  type ProjectRepositoryPort,
} from "../domain/ports";
import { ownedProject } from "./commands/update-project";

/**
 * Leer solicitudes de fusión como las ven las pantallas, y encontrarlas con las mismas reglas.
 *
 * Una solicitud se alcanza desde **cualquiera de sus dos proyectos** —el original, donde se revisa,
 * y la bifurcación, desde donde se pidió—, y desde ningún otro: con el id de otra solicitud bajo
 * este proyecto es un 404, como lo es un proyecto de otra organización. Los nombres de proyectos y
 * personas se resuelven aquí y no en la pantalla, que no tiene por qué poder leer usuarios.
 */
@Injectable()
export class MergeRequestViews {
  constructor(
    @Inject(PROJECT_REPOSITORY) private readonly projects: ProjectRepositoryPort,
    @Inject(MERGE_REQUEST_REPOSITORY) private readonly requests: MergeRequestRepositoryPort,
    @Inject(USER_REPOSITORY) private readonly users: UserRepositoryPort,
  ) {}

  async find(organizationId: string, projectId: string, requestId: string): Promise<ForkMergeRequest> {
    const project = await ownedProject(this.projects, organizationId, projectId);
    const request = await this.requests.findById(organizationId, requestId);
    if (!request || (request.parentProjectId !== project.id && request.forkProjectId !== project.id))
      throw new NotFoundError("La solicitud de fusión no existe", "merge-request-not-found");
    return request;
  }

  async list(organizationId: string, projectId: string): Promise<MergeRequestSummaryView[]> {
    const project = await ownedProject(this.projects, organizationId, projectId);
    const requests = await this.requests.listForProject(organizationId, project.id);
    const names = new Names(this.projects, this.users);
    return Promise.all(
      requests.map(async (request) => this.summary(request, await this.requests.listEvents(request.id), names)),
    );
  }

  async detail(
    request: ForkMergeRequest,
    viewerId: string,
    current: Pick<MergeRequestDetailView, "current" | "unavailable">,
  ): Promise<MergeRequestDetailView> {
    const names = new Names(this.projects, this.users);
    const events = await this.requests.listEvents(request.id);
    const can = (action: "approve" | "decline" | "close" | "merge") =>
      transition(request, action, viewerId).ok && (action !== "merge" || current.current !== null);
    return {
      ...(await this.summary(request, events, names)),
      description: request.description,
      requested: request.diff,
      requestedVersion: request.diffVersion,
      decidedAt: request.decidedAt?.toISOString() ?? null,
      mergedVersion: request.mergedVersion,
      events: await Promise.all(events.map((event) => this.event(event, names))),
      ...current,
      can: {
        approve: can("approve"),
        decline: can("decline"),
        close: can("close"),
        merge: can("merge"),
        comment: true,
      },
    };
  }

  private async summary(
    request: ForkMergeRequest,
    events: MergeRequestEvent[],
    names: Names,
  ): Promise<MergeRequestSummaryView> {
    return {
      id: request.id,
      title: request.title,
      status: request.status,
      fork: { id: request.forkProjectId, name: await names.project(request.forkProjectId) },
      parent: { id: request.parentProjectId, name: await names.project(request.parentProjectId) },
      author: { id: request.createdBy, name: await names.person(request.createdBy) },
      createdAt: request.createdAt.toISOString(),
      updatedAt: request.updatedAt.toISOString(),
      changes: request.diff.filter((entry) => entry.status !== "kept").length,
      conflicts: request.diff.filter((entry) => entry.status === "conflict").length,
      comments: events.filter((event) => event.kind === "comment").length,
      // Las aprobaciones de mientras está pendiente: una vez cerrada ya no cuentan para nada.
      approvals: PENDING_STATUSES.includes(request.status)
        ? new Set(events.filter((event) => event.kind === "approved").map((event) => event.authorId)).size
        : 0,
    };
  }

  private async event(event: MergeRequestEvent, names: Names): Promise<MergeRequestEventView> {
    return {
      id: event.id,
      kind: event.kind,
      author: { id: event.authorId, name: await names.person(event.authorId) },
      body: event.body,
      createdAt: event.createdAt.toISOString(),
    };
  }
}

/** Los nombres de una lectura, leídos una vez cada uno. */
class Names {
  private readonly cache = new Map<string, Promise<string>>();

  constructor(
    private readonly projects: ProjectRepositoryPort,
    private readonly users: UserRepositoryPort,
  ) {}

  project(id: string): Promise<string> {
    return this.once(`p:${id}`, async () => (await this.projects.findById(id))?.name ?? "(proyecto borrado)");
  }

  /** Un token de CI no es una persona: su id no está entre los usuarios, y se dice qué es. */
  person(id: string): Promise<string> {
    return this.once(`u:${id}`, async () => (await this.users.findById(id))?.name ?? "Token de API");
  }

  private once(key: string, read: () => Promise<string>): Promise<string> {
    if (!this.cache.has(key)) this.cache.set(key, read());
    return this.cache.get(key)!;
  }
}
