import { Injectable } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { In, Repository } from "typeorm";

import { RoleEntity, RolePermissionEntity, RoleRuleEntity } from "@/shared/database/entities";
import type { DataScope, PermissionChange, Role, RolePermission, RoleRule } from "../../domain/model";
import type { RoleRepositoryPort } from "../../domain/ports";

@Injectable()
export class TypeOrmRoleRepository implements RoleRepositoryPort {
  constructor(
    @InjectRepository(RoleEntity) private readonly roles: Repository<RoleEntity>,
    @InjectRepository(RolePermissionEntity) private readonly permissions: Repository<RolePermissionEntity>,
    @InjectRepository(RoleRuleEntity) private readonly rules: Repository<RoleRuleEntity>,
  ) {}

  async list(projectId: string): Promise<Role[]> {
    return (await this.roles.find({ where: { projectId }, order: { position: "ASC", createdAt: "ASC" } })).map(
      (row) => ({ ...row }),
    );
  }
  async findById(projectId: string, id: string): Promise<Role | null> {
    const row = await this.roles.findOne({ where: { projectId, id } });
    return row ? { ...row } : null;
  }
  async save(role: Role): Promise<void> {
    await this.roles.save(role);
  }
  async remove(projectId: string, id: string): Promise<void> {
    // Permissions and rules go by the cascade declared in the migration.
    await this.roles.delete({ projectId, id });
  }

  async listPermissions(projectId: string, filter: { roleId?: string; endpointId?: string } = {}) {
    const roleIds = (await this.roles.find({ where: { projectId }, select: { id: true } })).map((row) => row.id);
    if (!roleIds.length) return [];
    const rows = await this.permissions.find({
      where: {
        roleId: filter.roleId ? (roleIds.includes(filter.roleId) ? filter.roleId : In([])) : In(roleIds),
        ...(filter.endpointId ? { endpointId: filter.endpointId } : {}),
      },
    });
    return rows.map((row): RolePermission => ({
      roleId: row.roleId,
      endpointId: row.endpointId,
      access: row.access as RolePermission["access"],
      dataScope: row.dataScope as DataScope,
    }));
  }

  async applyPermissions(changes: PermissionChange[]): Promise<void> {
    await this.permissions.manager.transaction(async (manager) => {
      for (const change of changes) {
        if (change.access === "undecided")
          await manager.delete(RolePermissionEntity, { roleId: change.roleId, endpointId: change.endpointId });
        else
          await manager.save(RolePermissionEntity, {
            roleId: change.roleId,
            endpointId: change.endpointId,
            access: change.access,
            dataScope: change.dataScope,
          });
      }
    });
  }

  async listRules(projectId: string): Promise<RoleRule[]> {
    return (await this.rules.find({ where: { projectId } })).map((row) => ({ ...row }));
  }
  async replaceRules(projectId: string, rules: RoleRule[]): Promise<void> {
    await this.rules.manager.transaction(async (manager) => {
      await manager.delete(RoleRuleEntity, { projectId });
      if (rules.length) await manager.insert(RoleRuleEntity, rules);
    });
  }
}
