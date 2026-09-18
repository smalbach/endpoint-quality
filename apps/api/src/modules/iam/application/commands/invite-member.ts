import { randomUUID } from "node:crypto";
import { Inject, Logger } from "@nestjs/common";
import { CommandHandler, type ICommand, type ICommandHandler } from "@nestjs/cqrs";

import { ConflictError, ForbiddenError } from "@/shared/errors/domain-error";
import { CLOCK, type ClockPort } from "@/shared/clock/clock.port";
import { generateOpaqueToken, hashOpaqueToken } from "@/shared/crypto/opaque-token";
import { ENV, type Env } from "@/shared/config/env";
import { MAILER, invitationMail, type MailerPort } from "@/shared/mail/mailer";
import { atLeast, type Role } from "../../domain/model";
import {
  INVITATION_REPOSITORY,
  MEMBERSHIP_REPOSITORY,
  ORGANIZATION_REPOSITORY,
  type InvitationRepositoryPort,
  type MembershipRepositoryPort,
  type OrganizationRepositoryPort,
} from "../../domain/ports";

export class InviteMemberCommand implements ICommand {
  constructor(
    readonly organizationId: string,
    readonly email: string,
    readonly role: Role,
    readonly invitedBy: string,
  ) {}
}

const INVITATION_TTL_DAYS = 7;

/**
 * Invites somebody, at a role the inviter is allowed to grant.
 *
 * **Nobody can invite above their own level.** Without that rule an `admin` invites a new
 * `owner`, and then either accepts the invitation themselves or asks the invitee for the link:
 * a one-step privilege escalation dressed as an ordinary feature.
 *
 * Only the token's hash is stored, so the invitation link cannot be recovered from the database
 * by an operator either.
 *
 * El enlace sale por correo, y **además** se devuelve: quien invita puede pasarlo por otro canal
 * si el correo tarda o cae en spam, y con `MAIL_DRIVER=log` es la única forma de que llegue. El
 * envío va después de guardar y no se espera: un proveedor de correo caído no puede convertir en
 * un 500 una invitación que ya existe y cuyo enlace se tiene en la mano.
 */
@CommandHandler(InviteMemberCommand)
export class InviteMemberHandler implements ICommandHandler<
  InviteMemberCommand,
  { invitationId: string; token: string; expiresAt: Date }
> {
  constructor(
    @Inject(INVITATION_REPOSITORY) private readonly invitations: InvitationRepositoryPort,
    @Inject(MEMBERSHIP_REPOSITORY) private readonly memberships: MembershipRepositoryPort,
    @Inject(ORGANIZATION_REPOSITORY) private readonly organizations: OrganizationRepositoryPort,
    @Inject(MAILER) private readonly mailer: MailerPort,
    @Inject(CLOCK) private readonly clock: ClockPort,
    @Inject(ENV) private readonly env: Env,
  ) {}

  private readonly logger = new Logger("Invitations");

  async execute(command: InviteMemberCommand) {
    const inviter = await this.memberships.find(command.organizationId, command.invitedBy);
    if (!inviter || !atLeast(inviter.role, "admin")) throw new ForbiddenError("No puedes invitar a esta organización");
    if (!atLeast(inviter.role, command.role))
      throw new ForbiddenError("No puedes invitar con un rol superior al tuyo", "role-escalation");

    const email = command.email.trim().toLowerCase();
    if (await this.invitations.findPending(command.organizationId, email)) {
      throw new ConflictError("Esa dirección ya tiene una invitación pendiente", "invitation-pending");
    }

    const now = this.clock.now();
    const token = generateOpaqueToken();
    const invitation = {
      id: randomUUID(),
      organizationId: command.organizationId,
      email,
      role: command.role,
      tokenHash: hashOpaqueToken(token),
      invitedBy: command.invitedBy,
      createdAt: now,
      expiresAt: new Date(now.getTime() + INVITATION_TTL_DAYS * 24 * 60 * 60 * 1000),
      acceptedAt: null,
      revokedAt: null,
    };
    await this.invitations.save(invitation);

    const organization = await this.organizations.findById(command.organizationId);
    const link = `${this.env.APP_URL.replace(/\/+$/, "")}/register?invitation=${encodeURIComponent(token)}`;
    void this.mailer
      .send({
        to: email,
        ...invitationMail({
          organization: organization?.name ?? "tu equipo",
          role: command.role,
          link,
          days: INVITATION_TTL_DAYS,
        }),
      })
      // El registro nombra la invitación y no la dirección ni el enlace: el enlace es la credencial.
      .catch((error: unknown) =>
        this.logger.error(
          `No se pudo enviar la invitación ${invitation.id}: ${error instanceof Error ? error.message : error}`,
        ),
      );
    return { invitationId: invitation.id, token, expiresAt: invitation.expiresAt };
  }
}
