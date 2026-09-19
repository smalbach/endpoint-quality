/** Builders shared by the rule and plan tests: an endpoint, a probe result, a context. */
import type { EndpointMeta, Finding, ProbeResult, RuleContext, RuleKey } from "../src/types.ts";
import { RULE_BY_KEY } from "../src/registry.ts";

export const endpoint = (
  patch: Partial<EndpointMeta> & Pick<EndpointMeta, "id" | "method" | "path">,
): EndpointMeta => ({
  requiresAuth: true,
  operationId: null,
  pathParameters: [...patch.path.matchAll(/\{([^}]+)\}/g)].map((match) => match[1]),
  body: null,
  ...patch,
});

export const result = (patch: Partial<ProbeResult> & Pick<ProbeResult, "endpointId" | "testType">): ProbeResult => ({
  id: `${patch.endpointId}::${patch.testType}`,
  method: "GET",
  path: "/x",
  credential: null,
  token: null,
  headers: {},
  body: null,
  contentType: null,
  note: "",
  status: 200,
  responseHeaders: {},
  bodyText: "",
  bodyBytes: 0,
  durationMs: 1,
  error: null,
  sentAuthorization: false,
  ...patch,
});

export const context = (patch: Partial<RuleContext> = {}): RuleContext => ({
  authEnforced: true,
  endpoints: [],
  roles: [],
  permissions: [],
  crossRoleRules: [],
  ...patch,
});

/** Runs one rule alone, the way the registry would with only that key enabled. */
export const run = (key: RuleKey, results: ProbeResult[], ctx: RuleContext = context()): Finding[] =>
  RULE_BY_KEY[key].evaluate(results, ctx);

/** A base64url JWT with the given header and payload — unsigned, only for reading its shape. */
export const jwt = (header: Record<string, unknown>, payload: Record<string, unknown>, signature = "firma"): string => {
  const encode = (value: unknown) =>
    btoa(JSON.stringify(value)).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
  return `${encode(header)}.${encode(payload)}.${signature}`;
};
