import { Injectable } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";

import { InvitationEntity, MembershipEntity, OrganizationEntity } from "@/shared/database/entities";
import type { Invitation, Membership, Organization, Role } from "../../domain/model";
import type { InvitationRepositoryPort, MembershipRepositoryPort, OrganizationRepositoryPort } from "../../domain/ports";

@Injectable()
export class TypeOrmOrganizationRepository implements OrganizationRepositoryPort {
  constructor(@InjectRepository(OrganizationEntity) private readonly repository: Repository<OrganizationEntity>) {}
  async findById(id: string): Promise<Organization | null> {
    const row = await this.repository.findOne({ where: { id } });
    return row ? { ...row } : null;
  }
  async findBySlug(slug: string): Promise<Organization | null> {
    const row = await this.repository.findOne({ where: { slug } });
    return row ? { ...row } : null;
  }
  async save(organization: Organization): Promise<void> {
    await this.repository.save(organization);
  }
}

@Injectable()
export class TypeOrmMembershipRepository implements MembershipRepositoryPort {
  constructor(@InjectRepository(MembershipEntity) private readonly repository: Repository<MembershipEntity>) {}
  async find(organizationId: string, userId: string): Promise<Membership | null> {
    const row = await this.repository.findOne({ where: { organizationId, userId } });
    return row ? toMembership(row) : null;
  }
  async listForUser(userId: string): Promise<Membership[]> {
    return (await this.repository.find({ where: { userId }, order: { createdAt: "ASC" } })).map(toMembership);
  }
  async listForOrganization(organizationId: string): Promise<Membership[]> {
    return (await this.repository.find({ where: { organizationId }, order: { createdAt: "ASC" } })).map(toMembership);
  }
  async save(membership: Membership): Promise<void> {
    await this.repository.save(membership);
  }
  async remove(organizationId: string, userId: string): Promise<void> {
    await this.repository.delete({ organizationId, userId });
  }
}

@Injectable()
export class TypeOrmInvitationRepository implements InvitationRepositoryPort {
  constructor(@InjectRepository(InvitationEntity) private readonly repository: Repository<InvitationEntity>) {}
  async findByHash(hash: string): Promise<Invitation | null> {
    const row = await this.repository.findOne({ where: { tokenHash: hash } });
    return row ? toInvitation(row) : null;
  }
  async findPending(organizationId: string, email: string): Promise<Invitation | null> {
    const rows = await this.repository.find({ where: { organizationId, email: email.toLowerCase() } });
    const pending = rows.find((row) => !row.acceptedAt && !row.revokedAt);
    return pending ? toInvitation(pending) : null;
  }
  async listForOrganization(organizationId: string): Promise<Invitation[]> {
    return (await this.repository.find({ where: { organizationId }, order: { createdAt: "DESC" } })).map(toInvitation);
  }
  async save(invitation: Invitation): Promise<void> {
    await this.repository.save({ ...invitation, email: invitation.email.toLowerCase() });
  }
}

const toMembership = (row: MembershipEntity): Membership => ({ ...row, role: row.role as Role });
const toInvitation = (row: InvitationEntity): Invitation => ({ ...row, role: row.role as Role });
