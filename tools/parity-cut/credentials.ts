/**
 * The three credentials the matrix presents, and why there are three.
 *
 * They are the same values `tests/api-auth.test.mjs` uses in the backend repo, because the cut is
 * only evidence if both sides authenticate identically. The tokens are **unsigned**: the service
 * reads an already-validated `scope` claim and leaves signature, issuer and expiry to the gateway
 * in front of it (ADR-0008), which is what `TRUST_GATEWAY_CLAIMS` turns on.
 *
 * - `primary` reaches every scope, so an operation refusing it is a finding;
 * - `insufficient` authenticates and stops at `catalog:read`, which is the 403;
 * - `alternate` is an API key sent where the operation does not declare `ApiKeyAuth`, which the
 *   contract answers **401 and not 403** (D-29) — the one case that distinguishes "I do not know
 *   who you are" from "I know and you may not".
 *
 * Absence is the fourth credential and needs no value: `auth: "none"` sends nothing, and that is
 * the 401.
 */
function unsignedToken(...scopes: string[]): string {
  const segment = (payload: unknown) => Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${segment({ alg: "none" })}.${segment({ scope: scopes.join(" ") })}.signature`;
}

export const ADMIN_TOKEN = unsignedToken("catalog:admin");
export const READ_TOKEN = unsignedToken("catalog:read");
/** Matches `E2E_API_KEY_SCOPE`'s key in `scripts/e2e_env.py`. */
export const API_KEY = "e2e-key";
