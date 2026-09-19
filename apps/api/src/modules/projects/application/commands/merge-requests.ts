import { randomUUID } from "node:crypto";
import { Inject } from "@nestjs/common";
import {
  CommandHandler,
  QueryHandler,
  type ICommand,
  type ICommandHandler,
  type IQuery,
  type IQueryHandler,
} from "@nestjs/cqrs";
import type { ForkSyncOutcomeView, MergeRequestDetailView, MergeRequestSummaryView } from "@eq/contracts";

import { CLOCK, type ClockPort } from "@/shared/clock/clock.port";
import { ConflictError, DomainError, ForbiddenError, InvalidInputError } from "@/shared/errors/domain-error";
import type { Resolutions } from "../../domain/fork-merge";
import {
  mergeRequestProblems,
  transition,
  type ForkMergeRequest,
  type MergeRequestAction,
  type MergeRequestEvent,
  type MergeRequestEventKind,
} from "../../domain/merge-request";
import { MERGE_REQUEST_REPOSITORY, type MergeRequestRepositoryPort } from "../../domain/ports";
import { ForkSync } from "../fork-sync";
import { MergeRequestNotifier } from "../merge-request-notifier";
import { MergeRequestViews } from "../merge-request-views";
import { checkedPlan, view } from "./sync-fork";

/** Aprobar, rechazar o retirar: lo que cambia el estado sin tocar los proyectos. */
export const REVIEW_ACTIONS = ["approve", "decline", "close"] as const;
export type ReviewAction = (typeof REVIEW_ACTIONS)[number];

export function assertReviewAction(value: string): ReviewAction {
  if (!(REVIEW_ACTIONS as readonly string[]).includes(value))
    throw new InvalidInputError("Acción desconocida", [{ field: "action", detail: "approve, decline o close" }]);
  return value as ReviewAction;
}

/** El tope de longitud (10 000) lo pone el DTO, que es la única puerta por la que llega un comentario. */
function commentProblems(body: string) {
  return body.trim() ? [] : [{ field: "body", detail: "Escribe algo" }];
}

/** Una transición que no se puede: 403 si es por quién la pide, 409 si es por el estado. */
function allowed(request: ForkMergeRequest, action: MergeRequestAction, actorId: string) {
  const verdict = transition(request, action, actorId);
  if (verdict.ok) return verdict;
  if (verdict.reason === "author") throw new ForbiddenError(verdict.detail, "merge-request-author");
  throw new ConflictError(verdict.detail, "merge-request-not-pending");
}

const event = (
  request: ForkMergeRequest,
  kind: MergeRequestEventKind,
  authorId: string,
  body: string,
  at: Date,
): MergeRequestEvent => ({
  id: randomUUID(),
  requestId: request.id,
  organizationId: request.organizationId,
  authorId,
  kind,
  body: body.trim(),
  createdAt: at,
});

export class CreateMergeRequestCommand implements ICommand {
  constructor(
    readonly organizationId: string,
    readonly forkProjectId: string,
    readonly input: { title?: string; description?: string },
    readonly actorId: string,
  ) {}
}

/**
 * Crear una solicitud desde la bifurcación.
 *
 * Con la comparación de fusionar de ese momento guardada, y solo si hay algo que llevar: una
 * solicitud vacía no pide nada, y quien la revisa perdería el tiempo abriéndola. «Algo» es lo que
 * no es `kept` —en el sentido de fusionar, `kept` es lo que el original tiene y la bifurcación no—.
 * Una bifurcación tiene como mucho una pendiente; la base de datos lo promete también.
 */
@CommandHandler(CreateMergeRequestCommand)
export class CreateMergeRequestHandler implements ICommandHandler<CreateMergeRequestCommand, { id: string }> {
  constructor(
    private readonly sync: ForkSync,
    @Inject(MERGE_REQUEST_REPOSITORY) private readonly requests: MergeRequestRepositoryPort,
    @Inject(CLOCK) private readonly clock: ClockPort,
  ) {}

  async execute(command: CreateMergeRequestCommand): Promise<{ id: string }> {
    const problems = mergeRequestProblems(command.input);
    if (problems.length) throw new InvalidInputError("La solicitud no es válida", problems);
    const comparison = await this.sync.compare(command.organizationId, command.forkProjectId, "merge");
    if (!comparison.entries.some((entry) => entry.status !== "kept"))
      throw new ConflictError("La bifurcación no tiene nada que el original no tenga", "merge-request-empty");
    const pending = (await this.requests.listForProject(command.organizationId, comparison.forkProject.id)).find(
      (row) => row.forkProjectId === comparison.forkProject.id && (row.status === "open" || row.status === "approved"),
    );
    if (pending) throw new ConflictError("Esta bifurcación ya tiene una solicitud pendiente", "merge-request-pending");
    const now = this.clock.now();
    const request: ForkMergeRequest = {
      id: randomUUID(),
      organizationId: command.organizationId,
      forkProjectId: comparison.forkProject.id,
      parentProjectId: comparison.parent.id,
      title: command.input.title!.trim(),
      description: (command.input.description ?? "").trim(),
      status: "open",
      createdBy: command.actorId,
      createdAt: now,
      updatedAt: now,
      diff: comparison.entries,
      diffVersion: comparison.fork.version,
      decidedBy: null,
      decidedAt: null,
      mergedVersion: null,
    };
    await this.requests.save(request);
    return { id: request.id };
  }
}

export class ListMergeRequestsQuery implements IQuery {
  constructor(
    readonly organizationId: string,
    readonly projectId: string,
  ) {}
}

@QueryHandler(ListMergeRequestsQuery)
export class ListMergeRequestsHandler implements IQueryHandler<ListMergeRequestsQuery, MergeRequestSummaryView[]> {
  constructor(private readonly views: MergeRequestViews) {}

  execute(query: ListMergeRequestsQuery): Promise<MergeRequestSummaryView[]> {
    return this.views.list(query.organizationId, query.projectId);
  }
}

export class GetMergeRequestQuery implements IQuery {
  constructor(
    readonly organizationId: string,
    readonly projectId: string,
    readonly requestId: string,
    readonly viewerId: string,
  ) {}
}

/**
 * Una solicitud con su hilo y con la comparación **de ahora**: lo que se fusionaría si se pulsa, con
 * su huella. Si ya no está pendiente no se recalcula —no hay nada que fusionar—, y si uno de los
 * dos proyectos ya no se puede comparar se dice por qué en vez de fallar la lectura entera: la
 * conversación sigue siendo legible aunque la bifurcación ya no exista.
 */
@QueryHandler(GetMergeRequestQuery)
export class GetMergeRequestHandler implements IQueryHandler<GetMergeRequestQuery, MergeRequestDetailView> {
  constructor(
    private readonly views: MergeRequestViews,
    private readonly sync: ForkSync,
  ) {}

  async execute(query: GetMergeRequestQuery): Promise<MergeRequestDetailView> {
    const request = await this.views.find(query.organizationId, query.projectId, query.requestId);
    let current: MergeRequestDetailView["current"] = null;
    let unavailable: string | null = null;
    if (request.status === "open" || request.status === "approved") {
      try {
        current = view(await this.sync.compare(query.organizationId, request.forkProjectId, "merge"));
      } catch (error) {
        if (!(error instanceof DomainError)) throw error;
        unavailable = error.message;
      }
    }
    return this.views.detail(request, query.viewerId, { current, unavailable });
  }
}

export class CommentMergeRequestCommand implements ICommand {
  constructor(
    readonly organizationId: string,
    readonly projectId: string,
    readonly requestId: string,
    readonly body: string,
    readonly actorId: string,
  ) {}
}

/** Comentar se puede en cualquier estado: después de fusionar también se habla de lo fusionado. */
@CommandHandler(CommentMergeRequestCommand)
export class CommentMergeRequestHandler implements ICommandHandler<CommentMergeRequestCommand, void> {
  constructor(
    private readonly views: MergeRequestViews,
    @Inject(MERGE_REQUEST_REPOSITORY) private readonly requests: MergeRequestRepositoryPort,
    @Inject(CLOCK) private readonly clock: ClockPort,
  ) {}

  async execute(command: CommentMergeRequestCommand): Promise<void> {
    const problems = commentProblems(command.body);
    if (problems.length) throw new InvalidInputError("El comentario no es válido", problems);
    const request = await this.views.find(command.organizationId, command.projectId, command.requestId);
    await this.requests.addEvent(event(request, "comment", command.actorId, command.body, this.clock.now()));
  }
}

export class ReviewMergeRequestCommand implements ICommand {
  constructor(
    readonly organizationId: string,
    readonly projectId: string,
    readonly requestId: string,
    readonly action: ReviewAction,
    readonly body: string,
    readonly actorId: string,
  ) {}
}

/**
 * Aprobar, rechazar o retirar, con un comentario opcional que va en la misma línea del hilo.
 *
 * El estado se guarda antes que la línea: si lo segundo fallara, la solicitud diría lo que es y al
 * hilo le faltaría una línea, que es el orden en que menos se miente.
 */
@CommandHandler(ReviewMergeRequestCommand)
export class ReviewMergeRequestHandler implements ICommandHandler<ReviewMergeRequestCommand, void> {
  constructor(
    private readonly views: MergeRequestViews,
    private readonly notifier: MergeRequestNotifier,
    @Inject(MERGE_REQUEST_REPOSITORY) private readonly requests: MergeRequestRepositoryPort,
    @Inject(CLOCK) private readonly clock: ClockPort,
  ) {}

  async execute(command: ReviewMergeRequestCommand): Promise<void> {
    // El comentario es opcional y su longitud la acota el DTO: aquí no queda nada que comprobar.
    const request = await this.views.find(command.organizationId, command.projectId, command.requestId);
    const verdict = allowed(request, command.action, command.actorId);
    const now = this.clock.now();
    const next: ForkMergeRequest = {
      ...request,
      status: verdict.status,
      updatedAt: now,
      ...(verdict.decides ? { decidedBy: command.actorId, decidedAt: now } : {}),
    };
    await this.requests.save(next);
    await this.requests.addEvent(event(request, verdict.event, command.actorId, command.body, now));
    if (command.action !== "close") this.notifier.notify(next, verdict.event, command.actorId);
  }
}

export class MergeMergeRequestCommand implements ICommand {
  constructor(
    readonly organizationId: string,
    readonly projectId: string,
    readonly requestId: string,
    readonly token: string,
    readonly resolutions: Resolutions,
    readonly actorId: string,
  ) {}
}

/**
 * Fusionar una solicitud: la fusión directa, recalculada ahora, con la solicitud cerrada en la misma
 * transacción que escribe el plan.
 *
 * La huella es la de la comparación que la pantalla enseñó **ahora**, no la guardada al crearla:
 * lo guardado es lo que se pidió, y aplicarlo sería escribir encima de lo que el original hizo
 * desde entonces. Las decisiones de los conflictos son de quien fusiona, como en la directa.
 */
@CommandHandler(MergeMergeRequestCommand)
export class MergeMergeRequestHandler implements ICommandHandler<MergeMergeRequestCommand, ForkSyncOutcomeView> {
  constructor(
    private readonly views: MergeRequestViews,
    private readonly sync: ForkSync,
    private readonly notifier: MergeRequestNotifier,
    @Inject(CLOCK) private readonly clock: ClockPort,
  ) {}

  async execute(command: MergeMergeRequestCommand): Promise<ForkSyncOutcomeView> {
    const request = await this.views.find(command.organizationId, command.projectId, command.requestId);
    allowed(request, "merge", command.actorId);
    const comparison = await this.sync.compare(command.organizationId, request.forkProjectId, "merge");
    const now = this.clock.now();
    const { plan, outcome } = checkedPlan(this.sync, comparison, command, now);
    const merged: ForkMergeRequest = {
      ...request,
      status: "merged",
      updatedAt: now,
      decidedBy: command.actorId,
      decidedAt: now,
      mergedVersion: plan.fork.version,
    };
    await this.sync.apply({
      ...plan,
      mergeRequest: { request: merged, event: event(request, "merged", command.actorId, "", now) },
    });
    this.notifier.notify(merged, "merged", command.actorId);
    return outcome;
  }
}
