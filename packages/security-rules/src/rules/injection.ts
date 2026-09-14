/** Injection, mass assignment and excessive data exposure. */
import { byTestType, isSuccess, jsonParse, type Finding, type SecurityRule } from "../types.ts";
import { bodyIncludes, finder, refs, type RuleMeta } from "./helpers.ts";

const INJECTION_META: RuleMeta = {
  key: "injection",
  id: "OWASP-API8-INJECTION",
  name: "Inyección",
  category: "Inyección",
  references: refs("api8-security-misconfiguration.html", 89),
};
const STACK_TRACE = [
  "stack trace",
  "at Object.",
  "syntaxerror",
  "sequelize",
  "sqlstate",
  "mongoerror",
  ".java:",
  "traceback",
];
export const injectionRule: SecurityRule = {
  ...INJECTION_META,
  evaluate(results, context) {
    const make = finder(INJECTION_META);
    const findings: Finding[] = [];
    for (const endpoint of context.endpoints) {
      const baseline = byTestType(results, "auth").find((result) => result.endpointId === endpoint.id)?.bodyBytes ?? 0;
      for (const result of byTestType(results, "injection").filter((r) => r.endpointId === endpoint.id)) {
        const kind = result.testType.split(/[-:]/)[1] ?? "";
        if (result.status >= 500 && bodyIncludes(result, ...STACK_TRACE))
          findings.push(
            make("high", endpoint.id, {
              title: `Error del servidor ante inyección en ${endpoint.path}`,
              detail: `El payload «${result.note}» provocó ${result.status} con traza: el valor llega sin sanear a la capa de datos.`,
              remediation: "Usa consultas parametrizadas y valida la entrada.",
              reproduce: [`${result.method} ${result.path} con ${result.note} → ${result.status}`],
              evidence: { payload: result.note, status: result.status },
            }),
          );
        else if (kind === "sql" && isSuccess(result.status) && baseline > 0 && result.bodyBytes > baseline * 1.5)
          findings.push(
            make("critical", endpoint.id, {
              title: `Posible inyección SQL en ${endpoint.path}`,
              detail: `El payload devolvió mucho más datos que una petición normal (${result.bodyBytes} vs ${baseline} bytes).`,
              remediation: "Parametriza las consultas; nunca concatenes la entrada.",
              reproduce: [`${result.method} ${result.path} con ${result.note}`],
              evidence: { payload: result.note, bytes: result.bodyBytes, baseline },
            }),
          );
        else if (kind === "xss" && isSuccess(result.status) && result.bodyText.includes(String(result.note)))
          findings.push(
            make("high", endpoint.id, {
              title: `Payload XSS reflejado en ${endpoint.path}`,
              detail: "El valor enviado vuelve en la respuesta sin escapar.",
              remediation: "Escapa la salida según el contexto; añade una CSP.",
              reproduce: [`${result.method} ${result.path} con ${result.note}`],
              evidence: { payload: result.note },
            }),
          );
      }
    }
    return findings;
  },
};

const MASS_META: RuleMeta = {
  key: "mass_assignment",
  id: "OWASP-API6-MASS-ASSIGNMENT",
  name: "Asignación masiva",
  category: "Asignación masiva",
  references: refs("api6-unrestricted-access-to-sensitive-business-flows.html", 915),
};
export const massAssignmentRule: SecurityRule = {
  ...MASS_META,
  evaluate(results) {
    const make = finder(MASS_META);
    return byTestType(results, "mass-assignment")
      .filter((result) => isSuccess(result.status))
      .flatMap((result) => {
        const body = jsonParse(result.bodyText);
        const echoed =
          body &&
          typeof body === "object" &&
          ((body as Record<string, unknown>).role === "admin" || (body as Record<string, unknown>).isAdmin === true);
        if (echoed)
          return [
            make("critical", result.endpointId, {
              title: `Asignación masiva aceptada en ${result.path}`,
              detail: "Se envió role: admin y el objeto creado lo refleja: el endpoint acepta campos que no debería.",
              remediation: "Acepta solo una lista blanca de campos; ignora o rechaza el resto.",
              reproduce: [`${result.method} ${result.path} con {role:"admin"} → ${result.status}`],
              evidence: { status: result.status },
            }),
          ];
        if (!bodyIncludes(result, "not allowed", "invalid", "forbidden", "unknown field"))
          return [
            make("high", result.endpointId, {
              title: `${result.path} no rechaza campos extra`,
              detail: `Se enviaron campos privilegiados y respondió ${result.status} sin rechazarlos.`,
              remediation: "Valida el cuerpo contra un esquema estricto.",
              reproduce: [`${result.method} ${result.path} con campos extra → ${result.status}`],
              evidence: { status: result.status },
            }),
          ];
        return [];
      });
  },
};

const EXPOSURE_META: RuleMeta = {
  key: "data_exposure",
  id: "OWASP-API3-DATA-EXPOSURE",
  name: "Exposición excesiva de datos",
  category: "Exposición de datos",
  references: refs("api3-broken-object-property-level-authorization.html", 213),
};
const CRITICAL_FIELDS = ["password", "passwd", "ssn", "creditcard", "credit_card", "card_number", "cvv", "secret_key"];
const HIGH_FIELDS = ["pin", "api_key", "apikey", "access_token", "refresh_token", "private_key"];
const CARD = /\b(?:\d[ -]?){13,16}\b/;
export const dataExposureRule: SecurityRule = {
  ...EXPOSURE_META,
  evaluate(results, context) {
    const make = finder(EXPOSURE_META);
    const findings: Finding[] = [];
    for (const endpoint of context.endpoints) {
      const probe =
        byTestType(results, "auth").find((result) => result.endpointId === endpoint.id && isSuccess(result.status)) ??
        byTestType(results, "no-auth").find((result) => result.endpointId === endpoint.id && isSuccess(result.status));
      if (!probe) continue;
      const critical = CRITICAL_FIELDS.filter((field) => bodyIncludes(probe, `"${field}"`));
      const high = HIGH_FIELDS.filter((field) => bodyIncludes(probe, `"${field}"`));
      if (critical.length || CARD.test(probe.bodyText))
        findings.push(
          make("critical", endpoint.id, {
            title: `Datos sensibles en la respuesta de ${endpoint.path}`,
            detail: `La respuesta incluye ${[...critical, ...(CARD.test(probe.bodyText) ? ["un número de tarjeta"] : [])].join(", ")}.`,
            remediation: "No devuelvas campos sensibles; proyecta solo lo necesario.",
            reproduce: [`${probe.method} ${probe.path} y observa la respuesta`],
            evidence: { fields: critical },
          }),
        );
      else if (high.length)
        findings.push(
          make("high", endpoint.id, {
            title: `Credenciales en la respuesta de ${endpoint.path}`,
            detail: `La respuesta incluye ${high.join(", ")}.`,
            remediation: "No expongas tokens ni claves en las respuestas.",
            reproduce: [`${probe.method} ${probe.path} y observa la respuesta`],
            evidence: { fields: high },
          }),
        );
    }
    return findings;
  },
};
