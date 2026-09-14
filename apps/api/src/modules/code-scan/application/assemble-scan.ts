import { analyzeNestSources, type SourceInput } from "../domain/analyze-nest";
import { diffEndpoints, unknownRoles, type ExistingEndpoint } from "../domain/diff";
import type { ScanImpact } from "../domain/model";
import type { ScanDiff } from "../domain/diff";
import type { ScanResult } from "../domain/analyze-nest";

/** An endpoint the project has, with the fields the scan needs beyond the diff — `operationId` links
 * a removed route to the flows that spend it. */
export type ProjectEndpoint = ExistingEndpoint & { operationId: string | null };

/**
 * Everything a scan records, assembled from the parsed sources and the project's current state.
 *
 * A plain function so it can be tested without a database: the command fetches the endpoints, roles,
 * permissions and flow usage, and this turns them into the result, the diff and the impact. The
 * impact is the part that needs the project — which removed route a role still points at, which one a
 * flow still calls — so it is computed here and not in the pure parser.
 */
export function assembleScan(params: {
  sources: SourceInput[];
  prefix: string;
  endpoints: ProjectEndpoint[];
  roleNames: string[];
  permissionCountByEndpoint: Map<string, number>;
  flowCountByOperation: Map<string, number>;
}): { result: ScanResult; diff: ScanDiff; impact: ScanImpact } {
  const result = analyzeNestSources(params.sources, params.prefix);
  const diff = diffEndpoints(result.endpoints, params.endpoints);
  const byId = new Map(params.endpoints.map((endpoint) => [endpoint.id, endpoint]));

  const removedWithPermissions = diff.removed
    .map((endpoint) => ({
      method: endpoint.method,
      path: endpoint.path,
      permissions: params.permissionCountByEndpoint.get(endpoint.id) ?? 0,
    }))
    .filter((entry) => entry.permissions > 0);

  const removedWithFlows = diff.removed
    .map((endpoint) => {
      const operationId = byId.get(endpoint.id)?.operationId;
      const flows = operationId ? (params.flowCountByOperation.get(operationId) ?? 0) : 0;
      return { method: endpoint.method, path: endpoint.path, flows };
    })
    .filter((entry) => entry.flows > 0);

  const impact: ScanImpact = {
    unknownRoles: unknownRoles(result.endpoints, params.roleNames),
    removedWithPermissions,
    removedWithFlows,
  };
  return { result, diff, impact };
}
