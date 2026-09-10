import type { Project } from "./model";

export const PROJECT_REPOSITORY = Symbol("PROJECT_REPOSITORY");

export interface ProjectRepositoryPort {
  findById(id: string): Promise<Project | null>;
  findBySlug(organizationId: string, slug: string): Promise<Project | null>;
  listForOrganization(organizationId: string, includeArchived: boolean): Promise<Project[]>;
  save(project: Project): Promise<void>;
}
