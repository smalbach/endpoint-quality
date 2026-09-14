import type { PermissionChange, Role, RolePermission, RoleRule } from "./model";

export const ROLE_REPOSITORY = Symbol("ROLE_REPOSITORY");

/** Every read takes `projectId`: a role id or an endpoint id from another project finds nothing. */
export interface RoleRepositoryPort {
  /** In `position` order. */
  list(projectId: string): Promise<Role[]>;
  findById(projectId: string, id: string): Promise<Role | null>;
  save(role: Role): Promise<void>;
  /** Its permissions and the rules that mention it go with it. */
  remove(projectId: string, id: string): Promise<void>;

  listPermissions(projectId: string, filter?: { roleId?: string; endpointId?: string }): Promise<RolePermission[]>;
  /** Upserts each change; an `undecided` one deletes the row. Nothing not listed is touched. */
  applyPermissions(changes: PermissionChange[]): Promise<void>;

  listRules(projectId: string): Promise<RoleRule[]>;
  replaceRules(projectId: string, rules: RoleRule[]): Promise<void>;
}
