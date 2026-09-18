import { Injectable } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { In, IsNull, Repository } from "typeorm";

import {
  EndpointEntity,
  EnvironmentEntity,
  ProjectEntity,
  ProjectForkEntity,
  RequestTemplateEntity,
  WorkflowDatasetEntity,
  WorkflowEntity,
} from "@/shared/database/entities";
import type { ForkSnapshot } from "../../domain/fork-merge";
import type { ForkWritePlan, Lineage, ProjectFork } from "../../domain/fork";
import type { ProjectForkRepositoryPort } from "../../domain/ports";

@Injectable()
export class TypeOrmProjectForkRepository implements ProjectForkRepositoryPort {
  constructor(@InjectRepository(ProjectForkEntity) private readonly forks: Repository<ProjectForkEntity>) {}

  async findByFork(forkProjectId: string): Promise<ProjectFork | null> {
    const row = await this.forks.findOne({ where: { forkProjectId } });
    return row ? toFork(row) : null;
  }

  async listByParent(parentProjectId: string): Promise<ProjectFork[]> {
    return (await this.forks.find({ where: { parentProjectId } })).map(toFork);
  }

  async save(fork: ProjectFork): Promise<void> {
    await this.forks.save(toRow(fork));
  }

  /**
   * El plan entero en una transacción: si cualquier escritura falla —una clave única, la conexión—,
   * ni el destino ni la foto común cambian. Primero lo que se borra y después lo que se escribe, para
   * que un endpoint que se va deje su método y ruta libres antes de que otro los ocupe.
   */
  async apply(plan: ForkWritePlan): Promise<void> {
    const projectId = plan.targetProjectId;
    await this.forks.manager.transaction(async (manager) => {
      if (plan.endpoints.remove.length)
        await manager.update(
          EndpointEntity,
          { projectId, id: In(plan.endpoints.remove), deletedAt: IsNull() },
          { deletedAt: plan.at },
        );
      if (plan.datasets.remove.length)
        await manager.delete(WorkflowDatasetEntity, { projectId, id: In(plan.datasets.remove) });
      if (plan.workflows.remove.length)
        await manager.delete(WorkflowEntity, { projectId, id: In(plan.workflows.remove) });
      if (plan.templates.remove.length)
        await manager.delete(RequestTemplateEntity, { projectId, id: In(plan.templates.remove) });
      if (plan.environments.remove.length)
        await manager.delete(EnvironmentEntity, { projectId, id: In(plan.environments.remove) });

      if (plan.endpoints.save.length)
        await manager.save(
          plan.endpoints.save.map((row) => manager.create(EndpointEntity, row as unknown as EndpointEntity)),
        );
      if (plan.templates.save.length)
        await manager.save(plan.templates.save.map((row) => manager.create(RequestTemplateEntity, row)));
      if (plan.workflows.save.length)
        await manager.save(
          plan.workflows.save.map((row) => manager.create(WorkflowEntity, row as unknown as WorkflowEntity)),
        );
      if (plan.datasets.save.length)
        await manager.save(plan.datasets.save.map((row) => manager.create(WorkflowDatasetEntity, row)));
      if (plan.environments.save.length)
        await manager.save(plan.environments.save.map((row) => manager.create(EnvironmentEntity, row)));
      if (plan.project)
        await manager.update(
          ProjectEntity,
          { id: plan.project.id },
          {
            activeEnvironmentId: plan.project.activeEnvironmentId,
          },
        );
      await manager.save(ProjectForkEntity, toRow(plan.fork));
    });
  }
}

const toRow = (fork: ProjectFork): ProjectForkEntity => ({
  ...fork,
  base: fork.base as unknown as Record<string, unknown>,
  lineage: fork.lineage as unknown as Record<string, unknown>,
});

const toFork = (row: ProjectForkEntity): ProjectFork => ({
  ...row,
  base: row.base as unknown as ForkSnapshot,
  lineage: row.lineage as unknown as Lineage,
});
