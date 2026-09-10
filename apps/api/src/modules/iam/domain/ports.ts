import type { Invitation, Membership, Organization } from "./model";

export const ORGANIZATION_REPOSITORY = Symbol("ORGANIZATION_REPOSITORY");
export const MEMBERSHIP_REPOSITORY = Symbol("MEMBERSHIP_REPOSITORY");
export const INVITATION_REPOSITORY = Symbol("INVITATION_REPOSITORY");

export interface OrganizationRepositoryPort {
  findById(id: string): Promise<Organization | null>;
  findBySlug(slug: string): Promise<Organization | null>;
  save(organization: Organization): Promise<void>;
}

export interface MembershipRepositoryPort {
  find(organizationId: string, userId: string): Promise<Membership | null>;
  listForUser(userId: string): Promise<Membership[]>;
  listForOrganization(organizationId: string): Promise<Membership[]>;
  save(membership: Membership): Promise<void>;
  remove(organizationId: string, userId: string): Promise<void>;
}

export interface InvitationRepositoryPort {
  findByHash(hash: string): Promise<Invitation | null>;
  findPending(organizationId: string, email: string): Promise<Invitation | null>;
  listForOrganization(organizationId: string): Promise<Invitation[]>;
  save(invitation: Invitation): Promise<void>;
}
