import { CREDENTIAL_ROLE_NAME, RESERVED_CREDENTIAL_ROLES } from "@/modules/environments/domain/model";

/**
 * The roles of the API a project tests, and what each one may reach.
 *
 * Rows of their own — the analyzer's three tables — rather than only the `access` section, because
 * a role now carries what a JSON list of names could not: a colour, a description, whether two
 * users with it must not see each other's data, and a permission per endpoint with a data scope.
 * The `access` section is still what the contract matrix reads; it is **derived** from these rows
 * on every change (`derive-access.ts`), so there is one place to edit and one to read.
 *
 * A role is still referred to by **name** everywhere outside this module — in a credential, in a
 * case id, in the matrix — so its name follows the credential rule, and renaming one renames its
 * credentials with it.
 */
export type Role = {
  id: string;
  projectId: string;
  name: string;
  description: string;
  /** `#rrggbb`. */
  color: string;
  /** Two users holding this role must not see each other's data. */
  sameRoleDataIsolation: boolean;
  position: number;
  createdAt: Date;
  updatedAt: Date;
  /**
   * Archivado y borrado blando. Ver `shared/lifecycle`.
   *
   * Un rol que no está vivo **sale de la matriz**: `list` solo devuelve los vivos, y la sección
   * `access` del proyecto se recalcula desde ahí. Sus celdas decididas y sus reglas se quedan en la
   * fila, así que restaurarlo devuelve la matriz como estaba y no un rol en blanco.
   */
  archivedAt: Date | null;
  deletedAt: Date | null;
};

/** The analyzer's palette. The first is the default. */
export const ROLE_COLORS = ["#6366f1", "#8b5cf6", "#ec4899", "#ef4444", "#f59e0b", "#10b981", "#06b6d4", "#3b82f6"];

export const DATA_SCOPES = ["all", "own", "none"] as const;
export type DataScope = (typeof DATA_SCOPES)[number];

/**
 * Three states, not a boolean.
 *
 * The analyzer stored `hasAccess` defaulting to true and showed a missing row as «allowed», while
 * its test run skipped missing rows: the screen said one thing and the run did another. Here a
 * missing row is `undecided`, says so on screen, and generates no case — silence is «todavía no
 * se ha dicho», not «puede».
 */
export const ROLE_ACCESS = ["allow", "deny", "undecided"] as const;
export type RoleAccess = (typeof ROLE_ACCESS)[number];

export type RolePermission = {
  roleId: string;
  endpointId: string;
  access: Exclude<RoleAccess, "undecided">;
  /** What the role sees when it gets through. Only meaningful with `allow`. */
  dataScope: DataScope;
};

/** A change to one cell; `undecided` removes the row. */
export type PermissionChange = { roleId: string; endpointId: string; access: RoleAccess; dataScope: DataScope };

/** Whether `target` may read, write and delete what `source` created. Project-wide. */
export type RoleRule = {
  projectId: string;
  sourceRoleId: string;
  targetRoleId: string;
  canRead: boolean;
  canWrite: boolean;
  canDelete: boolean;
};

export type RoleInput = {
  name?: string;
  description?: string;
  color?: string;
  sameRoleDataIsolation?: boolean;
};

type Problem = { field: string; detail: string };

export function roleProblems(input: RoleInput, creating: boolean): Problem[] {
  const problems: Problem[] = [];
  if (creating || input.name !== undefined) {
    const name = input.name?.trim() ?? "";
    if (!CREDENTIAL_ROLE_NAME.test(name))
      problems.push({
        field: "name",
        detail: "Hasta 20 caracteres: empieza por letra o «_» y sigue con letras, cifras, «_», «-» o «.»",
      });
    else if ((RESERVED_CREDENTIAL_ROLES as readonly string[]).includes(name))
      problems.push({ field: "name", detail: `«${name}» es un nombre reservado para las credenciales del motor` });
  }
  if (input.description !== undefined && input.description.length > 500)
    problems.push({ field: "description", detail: "Como mucho 500 caracteres" });
  if (input.color !== undefined && !/^#[0-9a-fA-F]{6}$/.test(input.color))
    problems.push({ field: "color", detail: "Un color #rrggbb" });
  return problems;
}
