import { Injectable } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { In, IsNull, Repository } from "typeorm";

import { ConflictError } from "@/shared/errors/domain-error";
import {
  EndpointEntity,
  EnvironmentEntity,
  ForkMergeRequestEntity,
  ForkMergeRequestEventEntity,
  ProjectConfigEntity,
  ProjectEntity,
  ProjectForkEntity,
  RequestTemplateEntity,
  RoleEntity,
  RolePermissionEntity,
  RoleRuleEntity,
  WorkflowDatasetEntity,
  WorkflowEntity,
  WorkflowSuiteEntity,
} from "@/shared/database/entities";
import type { ForkSnapshot } from "../../domain/fork-merge";
import type { ForkWritePlan, Lineage, ProjectFork } from "../../domain/fork";
import type { ProjectForkRepositoryPort } from "../../domain/ports";
import { toRequestRow } from "./typeorm-merge-request.repository";

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
   *
   * Lo primero, la fila de la bifurcación **bloqueada** (`FOR UPDATE`) y su versión comparada con la
   * que el plan espera. La huella se comprobó antes, fuera: dos aplicaciones a la vez la habrían
   * pasado las dos. Con el bloqueo, la segunda espera a que la primera termine, lee la versión que
   * esta dejó y no escribe nada. Postgres relee la fila bloqueada al soltarse el bloqueo, también
   * en `READ COMMITTED`, así que no hace falta subir el aislamiento de toda la transacción.
   */
  async apply(plan: ForkWritePlan): Promise<void> {
    const projectId = plan.targetProjectId;
    await this.forks.manager.transaction(async (manager) => {
      const locked = await manager.findOne(ProjectForkEntity, {
        where: { forkProjectId: plan.fork.forkProjectId },
        lock: { mode: "pessimistic_write" },
      });
      if (!locked || locked.version !== plan.expectedVersion)
        throw new ConflictError(
          "Alguien sincronizó esta bifurcación mientras tanto: vuelve a cargar la comparación",
          "fork-diff-stale",
        );
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
      if (plan.suites.remove.length)
        await manager.delete(WorkflowSuiteEntity, { projectId, id: In(plan.suites.remove) });
      if (plan.environments.remove.length)
        await manager.delete(EnvironmentEntity, { projectId, id: In(plan.environments.remove) });
      // Sus permisos y reglas se van con él, por la cascada de la migración.
      if (plan.roles.remove.length) await manager.delete(RoleEntity, { projectId, id: In(plan.roles.remove) });
      if (plan.sections.remove.length)
        await manager.delete(ProjectConfigEntity, { projectId, section: In(plan.sections.remove) });

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
      if (plan.suites.save.length)
        await manager.save(plan.suites.save.map((row) => manager.create(WorkflowSuiteEntity, row)));
      if (plan.environments.save.length)
        await manager.save(plan.environments.save.map((row) => manager.create(EnvironmentEntity, row)));
      if (plan.roles.save.length) await manager.save(plan.roles.save.map((row) => manager.create(RoleEntity, row)));
      if (plan.roles.permissions.clear.length)
        await manager.delete(RolePermissionEntity, { roleId: In(plan.roles.permissions.clear) });
      if (plan.roles.permissions.save.length)
        await manager.save(plan.roles.permissions.save.map((row) => manager.create(RolePermissionEntity, row)));
      if (plan.roles.rules) {
        await manager.delete(RoleRuleEntity, { projectId });
        if (plan.roles.rules.length) await manager.insert(RoleRuleEntity, plan.roles.rules);
      }
      if (plan.sections.save.length)
        await manager.save(plan.sections.save.map((row) => manager.create(ProjectConfigEntity, row)));
      if (plan.project)
        await manager.update(
          ProjectEntity,
          { id: plan.project.id },
          {
            activeEnvironmentId: plan.project.activeEnvironmentId,
          },
        );
      await manager.save(ProjectForkEntity, toRow(plan.fork));
      if (plan.mergeRequest) {
        await manager.save(ForkMergeRequestEntity, toRequestRow(plan.mergeRequest.request));
        await manager.insert(ForkMergeRequestEventEntity, plan.mergeRequest.event);
      }
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
