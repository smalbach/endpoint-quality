import { safeParseSection } from "@eq/runner-core";

import type { ClockPort } from "@/shared/clock/clock.port";
import type { ConfigRepositoryPort } from "@/modules/config/domain/ports";
import type { EndpointRepositoryPort } from "@/modules/endpoints/domain/ports";
import type { RoleRepositoryPort } from "../domain/ports";
import { deriveAccess, readAccess } from "../domain/derive-access";

export type AccessSyncDeps = {
  roles: RoleRepositoryPort;
  endpoints: EndpointRepositoryPort;
  config: ConfigRepositoryPort;
  clock: ClockPort;
};

/**
 * Rewrites the `access` section from the roles, after every change to them.
 *
 * Validated with the same schema a `PUT config/access` goes through before it is stored: a derived
 * document the matrix could not read would fail every run of the project, not this request.
 */
export async function syncAccessSection(
  deps: AccessSyncDeps,
  projectId: string,
  actorId: string,
  renamed: Record<string, string> = {},
): Promise<void> {
  const [roles, permissions, endpoints, row] = await Promise.all([
    deps.roles.list(projectId),
    deps.roles.listPermissions(projectId),
    deps.endpoints.listAll(projectId),
    deps.config.findSection(projectId, "access"),
  ]);
  // A project that never had roles keeps having no section: writing the defaults would look like a
  // decision somebody made.
  if (!row && roles.length === 0) return;

  const data = { access: deriveAccess(readAccess(row?.data), roles, permissions, endpoints, renamed) };
  const verdict = safeParseSection("access", data);
  if (!verdict.ok)
    throw new Error(`La sección access derivada de los roles no es válida: ${JSON.stringify(verdict.issues)}`);
  await deps.config.saveSection({
    projectId,
    section: "access",
    data,
    updatedAt: deps.clock.now(),
    updatedBy: actorId,
  });
}
