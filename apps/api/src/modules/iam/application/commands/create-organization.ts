import { randomUUID } from "node:crypto";
import { Inject } from "@nestjs/common";
import { CommandHandler, type ICommand, type ICommandHandler } from "@nestjs/cqrs";

import { CLOCK, type ClockPort } from "@/shared/clock/clock.port";
import { slugify } from "../../domain/model";
import { MEMBERSHIP_REPOSITORY, ORGANIZATION_REPOSITORY, type MembershipRepositoryPort, type OrganizationRepositoryPort } from "../../domain/ports";

export class CreateOrganizationCommand implements ICommand {
  constructor(readonly name: string, readonly ownerId: string) {}
}

/**
 * Creates an organization and makes its creator the owner, in that order and never separately.
 *
 * An organization with no owner cannot be given one — only an owner can promote anybody — so the
 * two writes are one operation. Persisting the organization and failing before the membership
 * leaves a row nobody in the system can reach or delete.
 */
@CommandHandler(CreateOrganizationCommand)
export class CreateOrganizationHandler implements ICommandHandler<CreateOrganizationCommand, { organizationId: string; slug: string }> {
  constructor(
    @Inject(ORGANIZATION_REPOSITORY) private readonly organizations: OrganizationRepositoryPort,
    @Inject(MEMBERSHIP_REPOSITORY) private readonly memberships: MembershipRepositoryPort,
    @Inject(CLOCK) private readonly clock: ClockPort,
  ) {}

  async execute(command: CreateOrganizationCommand) {
    const now = this.clock.now();
    const slug = await this.freeSlug(slugify(command.name));
    const organizationId = randomUUID();

    await this.organizations.save({ id: organizationId, name: command.name.trim(), slug, createdAt: now });
    await this.memberships.save({ organizationId, userId: command.ownerId, role: "owner", createdAt: now });

    return { organizationId, slug };
  }

  /** Two organizations can share a name; they cannot share a slug, because the slug is what
   * appears in a URL. The suffix is numeric and sequential rather than random so the second
   * "Acme" is `acme-2` and not `acme-f3a9`. */
  private async freeSlug(base: string): Promise<string> {
    if (!(await this.organizations.findBySlug(base))) return base;
    for (let suffix = 2; suffix < 1000; suffix += 1) {
      const candidate = `${base}-${suffix}`;
      if (!(await this.organizations.findBySlug(candidate))) return candidate;
    }
    return `${base}-${randomUUID().slice(0, 8)}`;
  }
}
