import { Injectable } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";

import { EnvironmentCredentialEntity, EnvironmentEntity } from "@/shared/database/entities";
import type { Credential, CredentialKind, CredentialRole, Environment } from "../../domain/model";
import type { EnvironmentRepositoryPort } from "../../domain/ports";

@Injectable()
export class TypeOrmEnvironmentRepository implements EnvironmentRepositoryPort {
  constructor(
    @InjectRepository(EnvironmentEntity) private readonly environments: Repository<EnvironmentEntity>,
    @InjectRepository(EnvironmentCredentialEntity) private readonly credentials: Repository<EnvironmentCredentialEntity>,
  ) {}

  async findById(id: string): Promise<Environment | null> {
    const row = await this.environments.findOne({ where: { id } });
    return row ? { ...row } : null;
  }
  async findByName(projectId: string, name: string): Promise<Environment | null> {
    const row = await this.environments.findOne({ where: { projectId, name } });
    return row ? { ...row } : null;
  }
  async listForProject(projectId: string): Promise<Environment[]> {
    return (await this.environments.find({ where: { projectId }, order: { createdAt: "ASC" } })).map((row) => ({ ...row }));
  }
  async save(environment: Environment): Promise<void> {
    await this.environments.save(environment);
  }
  async remove(id: string): Promise<void> {
    // The credentials go with it, by the cascade in the migration: an environment deleted with
    // its secrets left behind would leave a set of credentials nothing can reach to revoke.
    await this.environments.delete({ id });
  }

  async listCredentials(environmentId: string): Promise<Credential[]> {
    return (await this.credentials.find({ where: { environmentId }, order: { role: "ASC" } })).map(toCredential);
  }
  async findCredential(environmentId: string, role: CredentialRole): Promise<Credential | null> {
    const row = await this.credentials.findOne({ where: { environmentId, role } });
    return row ? toCredential(row) : null;
  }
  async saveCredential(credential: Credential): Promise<void> {
    await this.credentials.save(credential);
  }
  async removeCredential(environmentId: string, role: CredentialRole): Promise<void> {
    await this.credentials.delete({ environmentId, role });
  }
}

const toCredential = (row: EnvironmentCredentialEntity): Credential => ({ ...row, role: row.role as CredentialRole, kind: row.kind as CredentialKind });
