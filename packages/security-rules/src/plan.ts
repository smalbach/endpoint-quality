/**
 * What to send, decided from the endpoints and the credentials — and nothing sent here.
 *
 * A plan is a list of {@link Probe}s the executor turns into requests. Splitting «what to ask» from
 * «asking» is what makes the whole matrix a fixture: a test hands `planProbes` some endpoints and
 * asserts the requests it would make, with no network in sight.
 *
 * Two-phase, because the interesting BOLA cases need real ids: first {@link planDiscovery} reads the
 * list endpoints, then {@link extractRealIds} pulls ids out of the answers, then {@link planProbes}
 * builds the full matrix with those ids substituted. The analyzer folded these together and skipped
 * detail endpoints whose id it never found; here the phases are explicit and testable.
 */
import { forgeAlgNone, forgeExpired, forgeTampered } from "./jwt.ts";
import type { EndpointMeta, Probe, ProbeResult, RuleKey } from "./types.ts";

export type PlanRole = { name: string; /** whether a credential is actually stored for it */ hasCredential: boolean };

export type PlanOptions = {
  roles: PlanRole[];
  /** The role treated as privileged for discovery and as the reference in comparisons. */
  adminRole: string | null;
  rules: Record<RuleKey, boolean>;
  rateLimitIterations: number;
  crossUserPermutations: boolean;
};

const SQL_PAYLOADS = ["' OR '1'='1", "1; DROP TABLE users--", "' UNION SELECT NULL--"];
const NOSQL_PAYLOADS = ['{"$gt":""}', '{"$ne":null}'];
const XSS_PAYLOADS = ["<script>alert(1)</script>", '"><img src=x onerror=alert(1)>'];
const MASS_ASSIGN = { role: "admin", isAdmin: true, verified: true, is_admin: true };
const BOLA_IDS = ["1", "2", "999", "99999"];

const idOf = (endpointId: string, testType: string) => `${endpointId}::${testType}`;

function probe(
  base: Omit<Probe, "id" | "headers" | "body" | "contentType" | "note" | "token"> & Partial<Probe>,
): Probe {
  return {
    token: null,
    headers: {},
    body: null,
    contentType: null,
    note: "",
    ...base,
    id: idOf(base.endpointId, base.testType),
  };
}

/** The path with each `{name}` replaced by `value`. */
export function fillPath(path: string, value: string): string {
  return path.replace(/\{[^{}]+\}/g, value);
}

const hasPathParam = (endpoint: EndpointMeta) => endpoint.pathParameters.length > 0;
const bodyText = (endpoint: EndpointMeta) => (endpoint.body ? JSON.stringify(endpoint.body) : null);

/** GET endpoints with no path parameter: the lists real ids are read from. */
export function planDiscovery(endpoints: EndpointMeta[], adminRole: string | null): Probe[] {
  return endpoints
    .filter((endpoint) => endpoint.method === "GET" && !hasPathParam(endpoint))
    .map((endpoint) =>
      probe({
        endpointId: endpoint.id,
        testType: "discovery",
        method: "GET",
        path: endpoint.path,
        credential: adminRole,
        note: "Descubre ids reales para las pruebas BOLA",
      }),
    );
}

const ID_FIELDS = /^(id|_id|uuid|[a-z][a-zA-Z]*Id)$/;

/** Up to `perEndpoint` real ids seen in a discovery answer, walked to a shallow depth. */
export function extractRealIds(results: ProbeResult[], perEndpoint = 5): string[] {
  const ids: string[] = [];
  const visit = (value: unknown, depth: number) => {
    if (depth > 5 || ids.length >= perEndpoint * 4) return;
    if (Array.isArray(value)) {
      for (const item of value) visit(item, depth + 1);
    } else if (value && typeof value === "object") {
      for (const [key, item] of Object.entries(value)) {
        if ((typeof item === "string" || typeof item === "number") && ID_FIELDS.test(key)) {
          const text = String(item);
          if (text && !ids.includes(text)) ids.push(text);
        } else visit(item, depth + 1);
      }
    }
  };
  for (const result of results) if (result.status >= 200 && result.status < 300) visit(safeJson(result.bodyText), 0);
  return [...new Set(ids)].slice(0, perEndpoint * 4);
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * The full matrix.
 *
 * Which probes fire is governed by the endpoint's shape (a body, a path parameter, a method) and by
 * the option flags — not by the rule toggles, which only decide what is *judged* afterwards. That is
 * one behaviour the analyzer got backwards: disabling a rule there still fired its flood of
 * requests. Here `rules.injection === false` actually stops sending injection payloads.
 */
export function planProbes(endpoints: EndpointMeta[], options: PlanOptions, realIds: string[]): Probe[] {
  const probes: Probe[] = [];
  const authed = options.roles.filter((role) => role.hasCredential);
  const jwtRole = authed[0]?.name ?? null;

  endpoints.forEach((endpoint, index) => {
    const body = bodyText(endpoint);
    const write = endpoint.method !== "GET" && endpoint.method !== "HEAD" && endpoint.method !== "OPTIONS";

    // The unauthenticated probe, always: it is how «público que no debería serlo» is even asked.
    probes.push(
      probe({
        endpointId: endpoint.id,
        testType: "no-auth",
        method: endpoint.method,
        path: endpoint.path,
        credential: null,
        body,
        contentType: body ? "application/json" : null,
      }),
    );
    // One authenticated probe per role that has a credential.
    for (const role of authed)
      probes.push(
        probe({
          endpointId: endpoint.id,
          testType: `auth:${role.name}`,
          method: endpoint.method,
          path: endpoint.path,
          credential: role.name,
          body,
          contentType: body ? "application/json" : null,
        }),
      );

    if (options.rules.security_headers || options.rules.cors)
      probes.push(
        probe({
          endpointId: endpoint.id,
          testType: "cors",
          method: endpoint.method,
          path: endpoint.path,
          credential: jwtRole,
          headers: { Origin: "https://evil.example.com", "Access-Control-Request-Method": endpoint.method },
          note: "Cabeceras y CORS",
        }),
      );

    if (options.rules.bola_idor && hasPathParam(endpoint) && endpoint.method === "GET")
      for (const id of BOLA_IDS)
        probes.push(
          probe({
            endpointId: endpoint.id,
            testType: `bola-id:${id}`,
            method: "GET",
            path: fillPath(endpoint.path, id),
            credential: jwtRole,
            note: `Objeto ${id}`,
          }),
        );

    if (options.rules.injection) {
      const inject = (kind: string, payloads: string[]) => {
        payloads.forEach((payload, position) => {
          probes.push(
            probe({
              endpointId: endpoint.id,
              testType: `injection-${kind}:${position}`,
              method: write ? endpoint.method : "POST",
              path: fillPath(endpoint.path, encodeURIComponent(payload)),
              credential: jwtRole,
              body: JSON.stringify({ ...(endpoint.body ?? {}), q: payload, search: payload, input: payload }),
              contentType: "application/json",
              note: payload,
            }),
          );
        });
      };
      inject("sql", SQL_PAYLOADS);
      inject("nosql", NOSQL_PAYLOADS);
      inject("xss", XSS_PAYLOADS);
    }

    if (options.rules.mass_assignment && write && endpoint.body)
      probes.push(
        probe({
          endpointId: endpoint.id,
          testType: "mass-assignment",
          method: endpoint.method,
          path: endpoint.path,
          credential: jwtRole,
          body: JSON.stringify({ ...endpoint.body, ...MASS_ASSIGN }),
          contentType: "application/json",
        }),
      );

    if (options.rules.rate_limit)
      for (let iteration = 0; iteration < Math.max(1, options.rateLimitIterations); iteration += 1)
        probes.push(
          probe({
            endpointId: endpoint.id,
            testType: `rate-limit:${iteration}`,
            method: endpoint.method,
            path: endpoint.path,
            credential: jwtRole,
            body,
            contentType: body ? "application/json" : null,
          }),
        );

    if (options.rules.bfla && (write || /\/(admin|manage|settings|config|internal|system)\b/i.test(endpoint.path)))
      for (const role of authed)
        if (role.name !== options.adminRole)
          probes.push(
            probe({
              endpointId: endpoint.id,
              testType: `bfla:${role.name}`,
              method: endpoint.method,
              path: endpoint.path,
              credential: role.name,
              body,
              contentType: body ? "application/json" : null,
            }),
          );

    if (options.rules.method_tampering) {
      const alternates = endpoint.method === "GET" ? ["DELETE", "PUT", "PATCH"] : write ? ["DELETE"] : [];
      for (const method of alternates)
        probes.push(
          probe({
            endpointId: endpoint.id,
            testType: `method-tamper:${method}`,
            method,
            path: endpoint.path,
            credential: jwtRole,
            note: `${endpoint.method} → ${method}`,
          }),
        );
    }

    if (options.rules.content_type && write)
      for (const type of ["text/plain", "application/xml", "none"])
        probes.push(
          probe({
            endpointId: endpoint.id,
            testType: `content-type:${type}`,
            method: endpoint.method,
            path: endpoint.path,
            credential: jwtRole,
            body: body ?? "{}",
            contentType: type === "none" ? null : type,
          }),
        );

    if (options.rules.verbose_error && write)
      probes.push(
        probe({
          endpointId: endpoint.id,
          testType: "verbose-error",
          method: endpoint.method,
          path: endpoint.path,
          credential: jwtRole,
          body: "{ malformed json",
          contentType: "application/json",
        }),
      );

    // JWT-attack probes need a real token to forge from, and forging is the executor's job (it holds
    // the token). The plan marks the intent; the executor fills `token`. Only the first authed
    // endpoint, because the target either validates tokens or it does not.
    if (options.rules.jwt_attack && jwtRole && index === 0)
      for (const attack of ["alg-none", "expired", "tampered"] as const)
        probes.push(
          probe({
            endpointId: endpoint.id,
            testType: `jwt-attack:${attack}`,
            method: endpoint.method,
            path: endpoint.path,
            credential: jwtRole,
            note: attack,
          }),
        );

    if (options.rules.cross_user_access && options.crossUserPermutations)
      for (const role of authed)
        probes.push(
          probe({
            endpointId: endpoint.id,
            testType: `cross-user:${role.name}`,
            method: endpoint.method,
            path: endpoint.path,
            credential: role.name,
            body,
            contentType: body ? "application/json" : null,
          }),
        );
  });

  // Cross-user BOLA with the ids discovery found: reach a real object as every role.
  if (options.rules.cross_user_access && options.crossUserPermutations && realIds.length)
    for (const endpoint of endpoints.filter(hasPathParam))
      for (const id of realIds.slice(0, 2))
        for (const role of authed)
          probes.push(
            probe({
              endpointId: endpoint.id,
              testType: `bola-real-id:${role.name}:${id}`,
              method: endpoint.method,
              path: fillPath(endpoint.path, id),
              credential: role.name,
              note: `Objeto real ${id} como ${role.name}`,
            }),
          );

  return probes;
}

/** The literal token an executor must attach for a jwt-attack probe, given the role's real token. */
export function forgeAttackToken(attack: string, realToken: string): string | null {
  if (attack === "alg-none") return forgeAlgNone(realToken);
  if (attack === "expired") return forgeExpired(realToken);
  if (attack === "tampered") return forgeTampered(realToken);
  return null;
}
