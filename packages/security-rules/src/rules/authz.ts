/** Authorization rules: who reached what, and who should have been refused. */
import { byTestType, isSuccess, type Finding, type ProbeResult, type SecurityRule } from "../types.ts";
import { finder, refs, similar, suffix, type RuleMeta } from "./helpers.ts";

const BOLA_META: RuleMeta = {
  key: "bola_idor",
  id: "OWASP-API1-BOLA",
  name: "Autorización a nivel de objeto (BOLA/IDOR)",
  category: "Autorización",
  references: refs("api1-broken-object-level-authorization.html", 639),
};
export const bolaRule: SecurityRule = {
  ...BOLA_META,
  evaluate(results, context) {
    const make = finder(BOLA_META);
    const findings: Finding[] = [];
    for (const endpoint of context.endpoints) {
      const probes = byTestType(results, "bola-id").filter((result) => result.endpointId === endpoint.id);
      if (!probes.length) continue;
      const reached = probes.filter((result) => isSuccess(result.status));
      const highId = reached.find((result) => /:(999|99999)$/.test(result.testType));
      const distinctBodies = new Set(reached.map((result) => result.bodyText));
      if (highId)
        findings.push(
          make("critical", endpoint.id, {
            title: `Se alcanzó un objeto arbitrario en ${endpoint.method} ${endpoint.path}`,
            detail: `Pedir el id ${suffix(highId.testType)} devolvió 2xx: el endpoint no comprueba que el objeto sea del solicitante.`,
            remediation:
              "Comprueba la propiedad del objeto en cada acceso: que el id pertenezca al usuario autenticado.",
            reproduce: [`GET ${highId.path}`, `Respuesta ${highId.status} en lugar de 403/404`],
            evidence: { path: highId.path, status: highId.status },
          }),
        );
      else if (reached.length >= 2 && distinctBodies.size >= 2)
        findings.push(
          make("critical", endpoint.id, {
            title: `Ids secuenciales devuelven datos distintos en ${endpoint.path}`,
            detail: "Varios ids consecutivos respondieron 2xx con cuerpos diferentes: se enumeran objetos de otros.",
            remediation: "Autoriza por objeto, no solo por autenticación.",
            reproduce: reached.slice(0, 2).map((result) => `GET ${result.path} → ${result.status}`),
            evidence: { ids: reached.map((result) => suffix(result.testType)) },
          }),
        );
    }
    return findings;
  },
};

const BFLA_META: RuleMeta = {
  key: "bfla",
  id: "OWASP-API5-BFLA",
  name: "Autorización a nivel de función (BFLA)",
  category: "Autorización",
  references: refs("api5-broken-function-level-authorization.html", 285),
};
export const bflaRule: SecurityRule = {
  ...BFLA_META,
  evaluate(results, context) {
    if (!context.authEnforced) return [];
    const make = finder(BFLA_META);
    const findings: Finding[] = [];
    for (const endpoint of context.endpoints) {
      // Prefer the declared expectation: the `auth:<role>` probe against a role denied here.
      const declared = context.permissions.filter((permission) => permission.endpointId === endpoint.id);
      const authProbes = byTestType(results, "auth").filter((result) => result.endpointId === endpoint.id);
      for (const permission of declared) {
        const probe = authProbes.find((result) => suffix(result.testType) === permission.roleName);
        if (!probe) continue;
        if (permission.access === "deny" && isSuccess(probe.status))
          findings.push(
            make("critical", endpoint.id, {
              title: `«${permission.roleName}» alcanzó ${endpoint.method} ${endpoint.path} sin permiso`,
              detail: `El rol está marcado como denegado y la API respondió ${probe.status}.`,
              remediation: "Comprueba el rol antes de ejecutar la función, no solo que haya sesión.",
              reproduce: [`${endpoint.method} ${probe.path} como ${permission.roleName}`, `Respuesta ${probe.status}`],
              evidence: { role: permission.roleName, status: probe.status },
            }),
          );
        else if (permission.access === "allow" && (probe.status === 401 || probe.status === 403))
          findings.push(
            make("high", endpoint.id, {
              title: `«${permission.roleName}» fue rechazado en ${endpoint.path} pese a tener permiso`,
              detail: `El rol debería pasar y la API respondió ${probe.status}.`,
              remediation: "Revisa la regla de autorización: el rol tiene permiso declarado y no lo alcanza.",
              reproduce: [`${endpoint.method} ${probe.path} como ${permission.roleName} → ${probe.status}`],
              evidence: { role: permission.roleName, status: probe.status },
            }),
          );
      }
      // Heuristic, when nothing was declared: a non-admin role reaching a destructive/admin route.
      if (!declared.length)
        for (const probe of byTestType(results, "bfla").filter((result) => result.endpointId === endpoint.id))
          if (isSuccess(probe.status))
            findings.push(
              make("high", endpoint.id, {
                title: `«${suffix(probe.testType)}» alcanzó ${endpoint.method} ${endpoint.path}`,
                detail:
                  "Un rol no privilegiado ejecutó una función sensible. Declara el permiso del rol para afinarlo.",
                remediation: "Restringe la función por rol y decláralo en la sección Roles.",
                reproduce: [`${endpoint.method} ${probe.path} como ${suffix(probe.testType)} → ${probe.status}`],
                evidence: { role: suffix(probe.testType), status: probe.status },
              }),
            );
    }
    return findings;
  },
};

const CROSS_META: RuleMeta = {
  key: "cross_user_access",
  id: "OWASP-API1-CROSS-USER",
  name: "Acceso entre usuarios",
  category: "Autorización",
  references: refs("api1-broken-object-level-authorization.html", 639),
};
export const crossUserRule: SecurityRule = {
  ...CROSS_META,
  evaluate(results, context) {
    if (!context.authEnforced) return [];
    const make = finder(CROSS_META);
    const findings: Finding[] = [];
    const realId = byTestType(results, "bola-real-id");
    const byRole = (list: ProbeResult[]) => {
      const map = new Map<string, ProbeResult[]>();
      for (const result of list) {
        const role = suffix(result.testType);
        map.set(role, [...(map.get(role) ?? []), result]);
      }
      return map;
    };

    for (const endpoint of context.endpoints) {
      const probes = realId.filter((result) => result.endpointId === endpoint.id);
      if (!probes.length) continue;
      const roles = byRole(probes);
      // A cross-role rule that forbids the verb, and the target role still reached the object.
      for (const rule of context.crossRoleRules) {
        const reached = (roles.get(rule.target) ?? []).filter((result) => isSuccess(result.status));
        if (!reached.length) continue;
        const forbidden =
          (endpoint.method === "GET" && !rule.canRead) ||
          (["POST", "PUT", "PATCH"].includes(endpoint.method) && !rule.canWrite) ||
          (endpoint.method === "DELETE" && !rule.canDelete);
        if (forbidden)
          findings.push(
            make("critical", endpoint.id, {
              title: `«${rule.target}» accedió a un objeto de «${rule.source}» en ${endpoint.path}`,
              detail: `La regla entre roles no permite ${verb(endpoint.method)}, y la API respondió 2xx.`,
              remediation: "Aplica la regla entre roles en el servidor: comprueba quién creó el objeto.",
              reproduce: [`${endpoint.method} ${reached[0].path} como ${rule.target} → ${reached[0].status}`],
              evidence: { source: rule.source, target: rule.target, method: endpoint.method },
            }),
          );
      }
      // Isolation: two roles with isolation on saw responses of near-identical size.
      for (const role of context.roles.filter((role) => role.sameRoleDataIsolation)) {
        const reached = (roles.get(role.name) ?? []).filter(
          (result) => isSuccess(result.status) && result.bodyBytes > 100,
        );
        if (reached.length >= 2 && similar(reached[0].bodyBytes, reached[1].bodyBytes) > 0.95)
          findings.push(
            make("high", endpoint.id, {
              title: `Posible fuga entre usuarios de «${role.name}» en ${endpoint.path}`,
              detail:
                "Dos usuarios del mismo rol aislado recibieron respuestas de tamaño casi idéntico para objetos distintos.",
              remediation: "Filtra por propietario: un usuario no debe ver los datos de otro con su mismo rol.",
              reproduce: reached.slice(0, 2).map((result) => `${result.path} → ${result.bodyBytes} bytes`),
              evidence: { role: role.name, sizes: reached.slice(0, 2).map((result) => result.bodyBytes) },
            }),
          );
      }
    }
    return findings;
  },
};
const verb = (method: string) => (method === "GET" ? "leer" : method === "DELETE" ? "borrar" : "escribir");

const METHOD_META: RuleMeta = {
  key: "method_tampering",
  id: "OWASP-API5-METHOD-TAMPERING",
  name: "Manipulación del método HTTP",
  category: "Autorización",
  references: refs("api5-broken-function-level-authorization.html", 650),
};
export const methodTamperingRule: SecurityRule = {
  ...METHOD_META,
  evaluate(results) {
    const make = finder(METHOD_META);
    return byTestType(results, "method-tamper")
      .filter((result) => isSuccess(result.status))
      .map((result) => {
        const swapped = suffix(result.testType) || result.method;
        return make(swapped === "DELETE" ? "high" : "medium", result.endpointId, {
          title: `El método ${swapped} fue aceptado en ${result.path}`,
          detail: `${result.note || swapped} respondió ${result.status}: el endpoint no restringe el verbo.`,
          remediation: "Responde 405 a los métodos que la ruta no implementa.",
          reproduce: [`${swapped} ${result.path} → ${result.status}`],
          evidence: { method: swapped, status: result.status },
        });
      });
  },
};
