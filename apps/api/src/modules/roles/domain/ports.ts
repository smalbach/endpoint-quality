import type { LifecycleState } from "@/shared/lifecycle/lifecycle";
import type { PermissionChange, Role, RolePermission, RoleRule } from "./model";

export const ROLE_REPOSITORY = Symbol("ROLE_REPOSITORY");

/** Every read takes `projectId`: a role id or an endpoint id from another project finds nothing. */
export interface RoleRepositoryPort {
  /** En orden de `position`, y **solo los vivos**: la matriz se dibuja con los que están en uso. */
  list(projectId: string, state?: LifecycleState): Promise<Role[]>;
  /** Por id **en cualquier estado**: restaurar uno borrado empieza por encontrarlo. */
  findById(projectId: string, id: string): Promise<Role | null>;
  save(role: Role): Promise<void>;
  /** El borrado de verdad, con sus permisos y sus reglas por cascada. Solo «para siempre». */
  remove(projectId: string, id: string): Promise<void>;

  listPermissions(projectId: string, filter?: { roleId?: string; endpointId?: string }): Promise<RolePermission[]>;
  /** Upserts each change; an `undecided` one deletes the row. Nothing not listed is touched. */
  applyPermissions(changes: PermissionChange[]): Promise<void>;

  listRules(projectId: string): Promise<RoleRule[]>;
  replaceRules(projectId: string, rules: RoleRule[]): Promise<void>;
}
