/**
 * Where a contract is exercised, and with what credential.
 *
 * The coupled dashboard had one text field for a base URL and three for credentials — `token`,
 * `readToken`, `apiKey` — hard-coded because the API it pointed at happened to have exactly those
 * three. A project defines them here instead.
 */
export type Environment = {
  id: string;
  projectId: string;
  name: string;
  baseUrl: string;
  /** Where the live OpenAPI document is served, when it is not `${baseUrl}/openapi.json`. */
  specUrl: string | null;
  variables: Record<string, string>;
  /**
   * Whether non-idempotent operations may run here.
   *
   * Off by default and enforced in the engine, not in the UI: a run can be launched from CI with
   * no UI in sight, and the first run against a production base URL must not be the one that
   * discovers the flag was on.
   */
  writesAllowed: boolean;
  /**
   * Whether the target actually enforces authorization.
   *
   * Against one that grants every scope to everyone — which is how most local backends are
   * started — the 401 and 403 cases fail for a reason that has nothing to do with the endpoint,
   * so they are not generated at all rather than reported as failures.
   */
  authEnforced: boolean;
  createdAt: Date;
};

/**
 * What a credential is *for*, which is the thing that generalizes.
 *
 * - `primary`: the working credential, sent by every ordinary case.
 * - `insufficient`: authenticates but falls short of the required scope. That is the 403, and
 *   without a second credential it cannot be tested at all.
 * - `alternate`: a scheme the operation does not declare — an API key on an endpoint that only
 *   accepts bearer. The contract answers 401 and not 403, because it is not a permission problem.
 */
export const CREDENTIAL_ROLES = ["primary", "insufficient", "alternate"] as const;
export type CredentialRole = (typeof CREDENTIAL_ROLES)[number];

export const CREDENTIAL_KINDS = ["bearer", "api_key", "basic"] as const;
export type CredentialKind = (typeof CREDENTIAL_KINDS)[number];

export type Credential = {
  id: string;
  environmentId: string;
  name: string;
  role: CredentialRole;
  kind: CredentialKind;
  headerName: string | null;
  secretCiphertext: string;
  scopes: string[];
  createdAt: Date;
  updatedAt: Date;
};

/** The header a credential travels in. Bearer and Basic imply `Authorization`; an API key is
 * whatever the target calls it, which is why the name is stored. */
export function credentialHeader(credential: Pick<Credential, "kind" | "headerName">, secret: string): Record<string, string> {
  if (credential.kind === "bearer") return { Authorization: `Bearer ${secret}` };
  if (credential.kind === "basic") return { Authorization: `Basic ${secret}` };
  return { [credential.headerName || "X-API-Key"]: secret };
}

/** A credential as it leaves the API: named, typed, and without the secret in any form. */
export type CredentialView = Omit<Credential, "secretCiphertext"> & { secretSet: true };
