/**
 * Configuration fragments that are worth offering but never worth assuming.
 *
 * A preset is opt-in. The defaults in `config.ts` stay empty because a product that shipped one
 * client's coordinates as a default would have decoupled the code and not the thinking — but a
 * corrupt-cursor case is genuinely reusable by any API with keyset pagination, and making every
 * project retype it is its own kind of coupling.
 */
import type { AuthRule, ConditionalScenario } from "./config.ts";
import type { HttpMethod } from "./types.ts";

/** A cursor that is not a cursor must produce a handled error and never a 500. Applies to any
 * operation that accepts a parameter with the given name. */
export function corruptCursorScenario(options: { parameter?: string; expectedStatus?: number; name?: string; description?: string } = {}): ConditionalScenario {
  const parameter = options.parameter ?? "cursor";
  return {
    id: `${parameter}-invalid`,
    name: options.name ?? "Cursor inválido",
    description: options.description ?? "Un cursor corrupto debe producir Problem Details y nunca un 500.",
    expectedStatus: options.expectedStatus ?? 422,
    parameters: { [parameter]: "broken" },
    requiresParameters: [parameter],
  };
}

/**
 * The case that catches a credential accepted where the contract never declared that scheme.
 *
 * It answers 401 and not 403 on purpose: it is not a permission the caller lacks, it is a
 * credential the operation does not accept at all. An API that answers 403 has authenticated
 * something it should have refused to look at.
 */
export function unacceptedCredentialRule(options: { methods: HttpMethod[]; id?: string; description?: string }): AuthRule {
  return {
    id: options.id ?? "auth-api-key",
    credential: "api-key",
    expectedStatus: 401,
    when: { methods: options.methods },
    ...(options.description ? { description: options.description } : {}),
  };
}
