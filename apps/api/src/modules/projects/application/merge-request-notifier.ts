import { Inject, Injectable, Logger } from "@nestjs/common";

import { ENV, type Env } from "@/shared/config/env";
import { MAILER, mergeRequestMail, type MailerPort } from "@/shared/mail/mailer";
import { USER_REPOSITORY, type UserRepositoryPort } from "@/modules/auth/domain/ports";
import type { ForkMergeRequest, MergeRequestEventKind } from "../domain/merge-request";
import { MergeRequestViews } from "./merge-request-views";

/**
 * El aviso por correo a quien creó la solicitud cuando otra persona la aprueba, la rechaza o la
 * fusiona.
 *
 * Lleva el título, los dos proyectos, quién y qué, y el enlace: **nada** de la comparación ni de
 * los comentarios, que pueden citar cabeceras o scripts. Solo a una persona —un token de CI no tiene
 * buzón—, nunca a quien actuó sobre su propia solicitud, y sin esperar: un proveedor de correo
 * caído no convierte en un 500 una decisión que ya está guardada.
 */
@Injectable()
export class MergeRequestNotifier {
  private readonly logger = new Logger("MergeRequests");

  constructor(
    @Inject(MAILER) private readonly mailer: MailerPort,
    @Inject(USER_REPOSITORY) private readonly users: UserRepositoryPort,
    @Inject(ENV) private readonly env: Env,
    private readonly views: MergeRequestViews,
  ) {}

  notify(request: ForkMergeRequest, kind: MergeRequestEventKind, actorId: string): void {
    if (request.createdBy === actorId) return;
    void this.send(request, kind, actorId).catch((error: unknown) =>
      this.logger.error(
        `No se pudo avisar de la solicitud ${request.id}: ${error instanceof Error ? error.message : error}`,
      ),
    );
  }

  private async send(request: ForkMergeRequest, kind: MergeRequestEventKind, actorId: string): Promise<void> {
    const [author, actor] = await Promise.all([this.users.findById(request.createdBy), this.users.findById(actorId)]);
    if (!author) return;
    const [summary] = (await this.views.list(request.organizationId, request.parentProjectId)).filter(
      (row) => row.id === request.id,
    );
    const link = `${this.env.APP_URL.replace(/\/+$/, "")}/p/${request.parentProjectId}/merge-requests/${request.id}`;
    await this.mailer.send({
      to: author.email,
      ...mergeRequestMail({
        title: request.title,
        fork: summary?.fork.name ?? "la bifurcación",
        parent: summary?.parent.name ?? "el original",
        actor: actor?.name ?? "Alguien",
        kind,
        link,
      }),
    });
  }
}
