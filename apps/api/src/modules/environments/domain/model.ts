import type { MaskedValue } from "@eq/contracts";

/**
 * A variable, as stored.
 *
 * **Two values, because «what this project uses» and «what this run is spending» are different
 * questions.** `initial` is the shared one — what somebody else pulling the project gets, and what
 * «restaurar» goes back to. `current` is what a run actually substitutes, and it is the one a
 * capture or a script overwrites. Postman calls them initial and current for the same reason: a
 * team that shares one value ends up sharing whatever the last debugging session left behind.
 *
 * `sensitive` is not a display hint. It decides three things at once: the value is AES-256-GCM
 * ciphertext in the column, it leaves the API as {@link MASKED_VALUE}, and the mask coming back in
 * an update means «unchanged» rather than a new value of eight dots.
 */
export type EnvironmentVariable = {
  initial: string;
  current: string;
  sensitive: boolean;
};

export type EnvironmentVariables = Record<string, EnvironmentVariable>;

/** What a sensitive value looks like from outside. Also the sentinel for «I did not touch it».
 * Typed against the contract so that the browser's copy cannot drift from this one in silence. */
export const MASKED_VALUE: MaskedValue = "\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022";

/**
 * The substitution map a run is handed: names to plain text, and nothing else.
 *
 * `current` wins over `initial` because the whole point of the pair is that the second can be
 * overwritten without disturbing the first; an empty `current` is «never set», not «set to empty»,
 * which is why the fallback is `||` and not `??`.
 *
 * The engine never learns what a sensitive variable is. It receives plain text, exactly as it
 * receives every other variable, so no step of the run has to remember to decrypt — and no code
 * path can forget and send `v1.iv.tag.data` as a path parameter.
 */
export function resolveVariables(
  variables: EnvironmentVariables,
  decrypt: (payload: string) => string,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(variables).map(([name, variable]) => {
      const stored = variable.current || variable.initial;
      return [name, variable.sensitive && stored ? decrypt(stored) : stored];
    }),
  );
}

/** The same map on its way out: a secret is eight dots, and never its length. */
export function maskVariables(variables: EnvironmentVariables): EnvironmentVariables {
  return Object.fromEntries(
    Object.entries(variables).map(([name, variable]) => [
      name,
      variable.sensitive
        ? {
            initial: variable.initial ? MASKED_VALUE : "",
            current: variable.current ? MASKED_VALUE : "",
            sensitive: true,
          }
        : variable,
    ]),
  );
}

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
  variables: EnvironmentVariables;
  /** Switched off in the editor: stored, and never substituted. Disjoint from `variables` by the
   * command that writes them, because a name that is both would have to mean one of the two. */
  disabledVariables: EnvironmentVariables;
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
export function credentialHeader(
  credential: Pick<Credential, "kind" | "headerName">,
  secret: string,
): Record<string, string> {
  if (credential.kind === "bearer") return { Authorization: `Bearer ${secret}` };
  if (credential.kind === "basic") return { Authorization: `Basic ${secret}` };
  return { [credential.headerName || "X-API-Key"]: secret };
}

/** A credential as it leaves the API: named, typed, and without the secret in any form. */
export type CredentialView = Omit<Credential, "secretCiphertext"> & { secretSet: true };
