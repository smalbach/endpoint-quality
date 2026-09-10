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

/**
 * Statuses that cannot carry content, by the specification rather than by convention.
 *
 * RFC 9110 is explicit: a 204 response "is terminated by the first empty line after the header
 * fields because it cannot contain content", and 205 and 304 are the same. This is a fact about
 * HTTP, so it belongs in the engine — a project that had to configure "my DELETEs answer 204
 * with no body" would be configuring the specification, and every project that forgot would get
 * a red DELETE with the envelope of a resource it never asked for.
 */
const BODILESS_STATUSES = new Set([204, 205, 304]);

/**
 * The shape a case expects.
 *
 * Three tiers, in order: a status that cannot carry content is `No body` whatever anyone
 * configured; a 4xx or 5xx is the project's error envelope regardless of the operation; anything
 * else is the operation's own success shape.
 */
export function expectedShapeFor(operation: Operation, expectedStatus: number, config: ProjectConfig): string {
  if (BODILESS_STATUSES.has(expectedStatus)) return "No body";
  return expectedStatus >= 400 ? config.envelope.errorShape : responseShapeFor(operation, config);
}
