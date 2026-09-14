/** Error handling, rate limiting, headers, CORS, content type, versioning and size anomalies. */
import { byTestType, isSuccess, type Finding, type ProbeResult, type SecurityRule } from "../types.ts";
import { bodyIncludes, finder, header, refs, similar, type RuleMeta } from "./helpers.ts";

const ERROR_META: RuleMeta = {
  key: "error_disclosure",
  id: "OWASP-API5-ERROR-DISCLOSURE",
  name: "Divulgación en errores",
  category: "Manejo de errores",
  references: refs("api8-security-misconfiguration.html", 209),
};
const DISCLOSURE = [
  { pattern: /at [\w.$]+ \(.*:\d+:\d+\)/, severity: "high" as const, what: "una traza de pila" },
  {
    pattern: /(\/[a-z0-9_.-]+){3,}\.(js|ts|py|rb|java|go)/i,
    severity: "medium" as const,
    what: "una ruta de fichero interna",
  },
  { pattern: /node_modules|site-packages|vendor\//i, severity: "medium" as const, what: "una ruta de dependencias" },
  { pattern: /\b(select|insert|update|delete)\b.+\bfrom\b/i, severity: "high" as const, what: "una consulta SQL" },
  {
    pattern: /\b(express|fastify|django|rails|laravel)\/?\s*\d/i,
    severity: "low" as const,
    what: "la versión del framework",
  },
];
export const errorDisclosureRule: SecurityRule = {
  ...ERROR_META,
  evaluate(results) {
    const make = finder(ERROR_META);
    const findings: Finding[] = [];
    const seen = new Set<string>();
    for (const result of results.filter((result) => result.status >= 400)) {
      for (const rule of DISCLOSURE) {
        if (!rule.pattern.test(result.bodyText)) continue;
        const key = `${result.endpointId}:${rule.what}`;
        if (seen.has(key)) continue;
        seen.add(key);
        findings.push(
          make(rule.severity, result.endpointId, {
            title: `La respuesta de error revela ${rule.what}`,
            detail: `${result.method} ${result.path} respondió ${result.status} exponiendo ${rule.what} en el cuerpo.`,
            remediation: "Devuelve un error genérico al cliente y registra el detalle solo en el servidor.",
            reproduce: [`${result.method} ${result.path} → ${result.status}`],
            evidence: { status: result.status },
          }),
        );
      }
    }
    return findings;
  },
};

const VERBOSE_META: RuleMeta = {
  key: "verbose_error",
  id: "OWASP-API3-VERBOSE-ERRORS",
  name: "Errores detallados",
  category: "Divulgación de información",
  references: refs("api8-security-misconfiguration.html", 209),
};
export const verboseErrorRule: SecurityRule = {
  ...VERBOSE_META,
  evaluate(results) {
    const make = finder(VERBOSE_META);
    return byTestType(results, "verbose-error")
      .filter(
        (result) =>
          result.status >= 400 && bodyIncludes(result, "at ", "error:", "exception", "econnrefused", "syntaxerror"),
      )
      .map((result) =>
        make("medium", result.endpointId, {
          title: `Error detallado ante entrada malformada en ${result.path}`,
          detail: `Un cuerpo inválido produjo ${result.status} con detalle interno en la respuesta.`,
          remediation: "Responde 400 con un mensaje neutro; no incluyas la excepción.",
          reproduce: [`${result.method} ${result.path} con JSON malformado → ${result.status}`],
          evidence: { status: result.status },
        }),
      );
  },
};

const RATE_META: RuleMeta = {
  key: "rate_limit",
  id: "OWASP-API4-RATE-LIMITING",
  name: "Límite de peticiones",
  category: "Límite de peticiones",
  references: refs("api4-unrestricted-resource-consumption.html", 770),
};
export const rateLimitRule: SecurityRule = {
  ...RATE_META,
  evaluate(results, context) {
    const make = finder(RATE_META);
    const findings: Finding[] = [];
    for (const endpoint of context.endpoints) {
      const probes = byTestType(results, "rate-limit").filter((result) => result.endpointId === endpoint.id);
      if (probes.length < 5) continue;
      if (probes.some((result) => result.status === 429)) continue; // throttled: passes
      const hasHeaders = probes.some((result) => header(result, "retry-after") || header(result, "x-ratelimit-limit"));
      if (probes.every((result) => isSuccess(result.status)))
        findings.push(
          make(hasHeaders ? "medium" : "high", endpoint.id, {
            title: `Sin límite de peticiones en ${endpoint.method} ${endpoint.path}`,
            detail: `${probes.length} peticiones seguidas respondieron 2xx sin ningún 429.`,
            remediation: "Aplica un límite por cliente y responde 429 con Retry-After.",
            reproduce: [`${probes.length}× ${endpoint.method} ${endpoint.path}`, "Ninguna respondió 429"],
            evidence: { attempts: probes.length, throttled: false },
          }),
        );
    }
    return findings;
  },
};

const HEADERS_META: RuleMeta = {
  key: "security_headers",
  id: "OWASP-API8-SECURITY-HEADERS",
  name: "Cabeceras de seguridad",
  category: "Cabeceras",
  references: refs("api8-security-misconfiguration.html", 693),
};
const REQUIRED_HEADERS: { name: string; severity: "medium" | "low"; label: string }[] = [
  { name: "x-content-type-options", severity: "medium", label: "X-Content-Type-Options" },
  { name: "x-frame-options", severity: "medium", label: "X-Frame-Options" },
  { name: "content-security-policy", severity: "medium", label: "Content-Security-Policy" },
  { name: "referrer-policy", severity: "low", label: "Referrer-Policy" },
];
export const securityHeadersRule: SecurityRule = {
  ...HEADERS_META,
  evaluate(results) {
    const make = finder(HEADERS_META);
    const findings: Finding[] = [];
    const first = new Map<string, ProbeResult>();
    for (const result of byTestType(results, "auth").concat(byTestType(results, "no-auth")))
      if (!first.has(result.endpointId) && result.status > 0) first.set(result.endpointId, result);
    for (const [endpointId, result] of first) {
      const missing = REQUIRED_HEADERS.filter((entry) => !header(result, entry.name));
      const worst = missing.some((entry) => entry.severity === "medium") ? "medium" : "low";
      if (missing.length)
        findings.push(
          make(worst, endpointId, {
            title: `Faltan cabeceras de seguridad en ${result.path}`,
            detail: `No se enviaron: ${missing.map((entry) => entry.label).join(", ")}.`,
            remediation: "Añade las cabeceras de seguridad en un middleware global (p. ej. helmet).",
            reproduce: [`${result.method} ${result.path} y revisa las cabeceras de respuesta`],
            evidence: { missing: missing.map((entry) => entry.label) },
          }),
        );
      if (header(result, "server")?.match(/\d/) || header(result, "x-powered-by"))
        findings.push(
          make("low", endpointId, {
            title: `${result.path} revela la tecnología del servidor`,
            detail: `Cabecera ${header(result, "x-powered-by") ? "X-Powered-By" : "Server"} con versión.`,
            remediation: "Oculta Server y X-Powered-By.",
            reproduce: [`${result.method} ${result.path}`],
            evidence: { server: header(result, "server"), poweredBy: header(result, "x-powered-by") },
          }),
        );
    }
    return findings;
  },
};

const CORS_META: RuleMeta = {
  key: "cors",
  id: "OWASP-API7-CORS",
  name: "Configuración CORS",
  category: "CORS",
  references: refs("api8-security-misconfiguration.html", 942),
};
export const corsRule: SecurityRule = {
  ...CORS_META,
  evaluate(results) {
    const make = finder(CORS_META);
    const findings: Finding[] = [];
    for (const result of byTestType(results, "cors")) {
      const allowOrigin = header(result, "access-control-allow-origin");
      const allowCredentials = header(result, "access-control-allow-credentials");
      if (allowOrigin === "*" && allowCredentials === "true")
        findings.push(
          make("critical", result.endpointId, {
            title: `CORS abierto con credenciales en ${result.path}`,
            detail:
              "Access-Control-Allow-Origin: * junto a Allow-Credentials: true permite a cualquier sitio leer respuestas autenticadas.",
            remediation: "Refleja solo orígenes de una lista blanca cuando permitas credenciales.",
            reproduce: [`OPTIONS ${result.path} con Origin: https://evil.example.com`],
            evidence: { allowOrigin, allowCredentials },
          }),
        );
      else if (allowOrigin === "https://evil.example.com")
        findings.push(
          make("high", result.endpointId, {
            title: `CORS refleja cualquier origen en ${result.path}`,
            detail: "El servidor devolvió el Origin arbitrario que se le envió.",
            remediation: "Valida el Origin contra una lista blanca antes de reflejarlo.",
            reproduce: [`OPTIONS ${result.path} con Origin: https://evil.example.com`],
            evidence: { allowOrigin },
          }),
        );
    }
    return findings;
  },
};

const CONTENT_META: RuleMeta = {
  key: "content_type",
  id: "API-CONTENT-TYPE-VALIDATION",
  name: "Validación de Content-Type",
  category: "Validación de entrada",
  references: refs("api8-security-misconfiguration.html", 20),
};
export const contentTypeRule: SecurityRule = {
  ...CONTENT_META,
  evaluate(results) {
    const make = finder(CONTENT_META);
    return byTestType(results, "content-type")
      .filter((result) => isSuccess(result.status))
      .map((result) => {
        const type = result.testType.split(":")[1] ?? "";
        return make("medium", result.endpointId, {
          title: `${result.path} acepta un Content-Type incorrecto`,
          detail: `Un cuerpo con Content-Type «${type}» respondió ${result.status} en lugar de 415.`,
          remediation: "Rechaza los tipos que no admites con 415 Unsupported Media Type.",
          reproduce: [`${result.method} ${result.path} con Content-Type ${type} → ${result.status}`],
          evidence: { contentType: type, status: result.status },
        });
      });
  },
};

const CONSISTENCY_META: RuleMeta = {
  key: "endpoint_consistency",
  id: "OWASP-API9-CONSISTENCY",
  name: "Consistencia entre versiones",
  category: "Versionado",
  references: refs("api9-improper-inventory-management.html", 1059),
};
export const endpointConsistencyRule: SecurityRule = {
  ...CONSISTENCY_META,
  evaluate(results, context) {
    const make = finder(CONSISTENCY_META);
    const findings: Finding[] = [];
    // Group endpoints whose path is the same once the /vN/ segment is stripped.
    const groups = new Map<string, typeof context.endpoints>();
    for (const endpoint of context.endpoints) {
      const key = `${endpoint.method} ${endpoint.path.replace(/\/v\d+\b/i, "")}`;
      groups.set(key, [...(groups.get(key) ?? []), endpoint]);
    }
    for (const [key, group] of groups) {
      if (group.length < 2) continue;
      const authStates = group.map((endpoint) => {
        const noAuth = byTestType(results, "no-auth").find((result) => result.endpointId === endpoint.id);
        return noAuth ? isSuccess(noAuth.status) : null;
      });
      if (new Set(authStates.filter((state) => state !== null)).size > 1)
        findings.push(
          make("high", group[0].id, {
            title: `Versiones de ${key} exigen autenticación distinta`,
            detail: "Una versión responde sin token y otra no: una versión antigua suele ser la puerta trasera.",
            remediation: "Aplica la misma autorización a todas las versiones, o retira las antiguas.",
            reproduce: group.map((endpoint) => `${endpoint.method} ${endpoint.path} sin token`),
            evidence: { paths: group.map((endpoint) => endpoint.path) },
          }),
        );
    }
    return findings;
  },
};

const SIZE_META: RuleMeta = {
  key: "response_size_anomaly",
  id: "API-RESPONSE-SIZE-ANOMALY",
  name: "Tamaño de respuesta anómalo",
  category: "Exposición de datos",
  references: refs("api3-broken-object-property-level-authorization.html", 213),
};
export const responseSizeRule: SecurityRule = {
  ...SIZE_META,
  evaluate(results, context) {
    const make = finder(SIZE_META);
    const findings: Finding[] = [];
    const adminRole = context.roles[0]?.name;
    if (!adminRole) return [];
    for (const endpoint of context.endpoints) {
      const reference = byTestType(results, "auth").find(
        (result) =>
          result.endpointId === endpoint.id && result.testType === `auth:${adminRole}` && isSuccess(result.status),
      );
      if (!reference || reference.bodyBytes === 0) continue;
      for (const result of byTestType(results, "auth").filter(
        (result) =>
          result.endpointId === endpoint.id && result.testType !== `auth:${adminRole}` && isSuccess(result.status),
      ))
        if (result.bodyBytes > reference.bodyBytes * 1.2 || similar(result.bodyBytes, reference.bodyBytes) > 0.8)
          findings.push(
            make("medium", endpoint.id, {
              title: `Un rol no privilegiado recibe casi lo mismo que ${adminRole} en ${endpoint.path}`,
              detail: `La respuesta (${result.bodyBytes} bytes) se parece a la del rol privilegiado (${reference.bodyBytes} bytes).`,
              remediation: "Proyecta los campos según el rol: no devuelvas a todos lo mismo.",
              reproduce: [`${result.testType} → ${result.bodyBytes} bytes vs ${adminRole} → ${reference.bodyBytes}`],
              evidence: { role: result.testType, bytes: result.bodyBytes, reference: reference.bodyBytes },
            }),
          );
    }
    return findings;
  },
};
