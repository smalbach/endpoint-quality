import type { Credential, CredentialRole, Environment } from "./model";

export const ENVIRONMENT_REPOSITORY = Symbol("ENVIRONMENT_REPOSITORY");

export interface EnvironmentRepositoryPort {
  findById(id: string): Promise<Environment | null>;
  findByName(projectId: string, name: string): Promise<Environment | null>;
  listForProject(projectId: string): Promise<Environment[]>;
  save(environment: Environment): Promise<void>;
  remove(id: string): Promise<void>;

  listCredentials(environmentId: string): Promise<Credential[]>;
  findCredential(environmentId: string, role: CredentialRole): Promise<Credential | null>;
  saveCredential(credential: Credential): Promise<void>;
  removeCredential(environmentId: string, role: CredentialRole): Promise<void>;
}
