import { Injectable } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";

import { PerformancePlanEntity, PerformanceRunEntity } from "@/shared/database/entities";
import type { PerformancePlanDefinition, PerformancePlanRow, PerformanceRun } from "../../domain/model";
import type { PerformancePlanRepositoryPort, PerformanceRunRepositoryPort } from "../../domain/ports";
import { lifecycleSql, type LifecycleState } from "@/shared/lifecycle/lifecycle";

const toPlan = (row: PerformancePlanEntity): PerformancePlanRow => ({
  ...row,
  definition: row.definition as PerformancePlanDefinition,
});

@Injectable()
export class TypeOrmPerformancePlanRepository implements PerformancePlanRepositoryPort {
  constructor(@InjectRepository(PerformancePlanEntity) private readonly plans: Repository<PerformancePlanEntity>) {}

  async list(projectId: string, state: LifecycleState = "active"): Promise<PerformancePlanRow[]> {
    const rows = await this.plans
      .createQueryBuilder("plan")
      .where("plan.projectId = :projectId", { projectId })
      .andWhere(lifecycleSql("plan", state))
      .orderBy("plan.name", "ASC")
      .getMany();
    return rows.map(toPlan);
  }
  async find(projectId: string, planId: string): Promise<PerformancePlanRow | null> {
    const row = await this.plans.findOne({ where: { id: planId, projectId } });
    return row ? toPlan(row) : null;
  }
  async findByName(projectId: string, name: string): Promise<PerformancePlanRow | null> {
    const row = await this.plans
      .createQueryBuilder("plan")
      .where("plan.projectId = :projectId", { projectId })
      .andWhere("plan.name = :name", { name })
      .andWhere(lifecycleSql("plan", "active"))
      .getOne();
    return row ? toPlan(row) : null;
  }
  async save(row: PerformancePlanRow): Promise<void> {
    await this.plans.save(this.plans.create(row));
  }
  async delete(projectId: string, planId: string): Promise<void> {
    await this.plans.delete({ id: planId, projectId });
  }
}

// The jsonb columns come back as `unknown`; the cast is the one boundary where the row's shape is
// asserted, the same way the security-run repository does it.
const toRun = (row: PerformanceRunEntity): PerformanceRun => ({
  ...row,
  status: row.status as PerformanceRun["status"],
  definition: row.definition as PerformanceRun["definition"],
  progress: row.progress as PerformanceRun["progress"],
  summary: row.summary as PerformanceRun["summary"],
  windows: row.windows as PerformanceRun["windows"],
  endpoints: row.endpoints as PerformanceRun["endpoints"],
  thresholds: row.thresholds as PerformanceRun["thresholds"],
});

@Injectable()
export class TypeOrmPerformanceRunRepository implements PerformanceRunRepositoryPort {
  constructor(@InjectRepository(PerformanceRunEntity) private readonly runs: Repository<PerformanceRunEntity>) {}

  async list(projectId: string, planId?: string): Promise<PerformanceRun[]> {
    const where = planId ? { projectId, planId } : { projectId };
    return (await this.runs.find({ where, order: { startedAt: "DESC" } })).map(toRun);
  }
  async find(projectId: string, runId: string): Promise<PerformanceRun | null> {
    const row = await this.runs.findOne({ where: { id: runId, projectId } });
    return row ? toRun(row) : null;
  }
  async findById(runId: string): Promise<PerformanceRun | null> {
    const row = await this.runs.findOne({ where: { id: runId } });
    return row ? toRun(row) : null;
  }
  async save(run: PerformanceRun): Promise<void> {
    await this.runs.save(this.runs.create(run));
  }
  async delete(projectId: string, runId: string): Promise<void> {
    await this.runs.delete({ id: runId, projectId });
  }
}
