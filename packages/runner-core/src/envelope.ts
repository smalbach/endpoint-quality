/**
 * Which envelope a response is expected to carry.
 *
 * In the coupled dashboard this was a four-branch `responseShape()` over `operation.id`
 * prefixes plus a chain of ternaries inside the run route. Both encoded one API's conventions —
 * `{ data }` for a resource, `{ data, meta, links }` for a collection — as facts about HTTP.
 *
 * **This is a fallback and not the primary check.** When the target's OpenAPI document declares
 * a schema for the status under test, the schema wins and this shape is never consulted. It
 * exists for the statuses a contract leaves undeclared, which are exactly the ones where a
 * shape check is the only assertion available.
 */
import type { Operation } from "./types.ts";
import type { ProjectConfig, EnvelopeRule } from "./config.ts";

export function matchesEnvelopeRule(operation: Operation, rule: EnvelopeRule): boolean {
  const { methods, operationId, operationIdPrefix, pathSuffix } = rule.match;
  if (methods && !methods.includes(operation.method)) return false;
  if (operationId && operation.id !== operationId) return false;
  if (operationIdPrefix && !operation.id.startsWith(operationIdPrefix)) return false;
  if (pathSuffix && !operation.path.endsWith(pathSuffix)) return false;
  return true;
}

/** The shape of a *successful* response. Errors use `config.envelope.errorShape`, decided by the
 * expected status at execution time and not by the operation. */
export function responseShapeFor(operation: Operation, config: ProjectConfig): string {
  const rule = config.envelope.rules.find((candidate) => matchesEnvelopeRule(operation, candidate));
  return rule ? rule.shape : config.envelope.fallbackShape;
}

/** The shape a case expects, which for any 4xx/5xx is the error envelope regardless of the
 * operation. Reproduces `scenario.expectedStatus >= 400 ? "ProblemDetails" : responseShape`. */
export function expectedShapeFor(operation: Operation, expectedStatus: number, config: ProjectConfig): string {
  return expectedStatus >= 400 ? config.envelope.errorShape : responseShapeFor(operation, config);
}
