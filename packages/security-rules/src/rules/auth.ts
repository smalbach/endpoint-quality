/** Authentication rules: the token itself, and forged variants of it. */
import { byTestType, isSuccess, type Finding, type SecurityRule } from "../types.ts";
import { decodeJwt } from "../jwt.ts";
import { finder, refs, suffix, type RuleMeta } from "./helpers.ts";

const AUTH_META: RuleMeta = {
  key: "auth_jwt",
  id: "OWASP-API2-BROKEN-AUTH",
  name: "Autenticación y JWT",
  category: "Autenticación",
  references: refs("api2-broken-authentication.html", 287),
};
export const authJwtRule: SecurityRule = {
  ...AUTH_META,
  evaluate(results, context) {
    const make = finder(AUTH_META);
    const findings: Finding[] = [];

    for (const endpoint of context.endpoints.filter((endpoint) => endpoint.requiresAuth)) {
      const noAuth = byTestType(results, "no-auth").find((result) => result.endpointId === endpoint.id);
      if (context.authEnforced && noAuth && isSuccess(noAuth.status))
        findings.push(
          make("critical", endpoint.id, {
            title: `${endpoint.method} ${endpoint.path} responde sin autenticación`,
            detail: `El endpoint requiere sesión y respondió ${noAuth.status} sin ninguna credencial.`,
            remediation: "Exige un token válido antes de servir la respuesta.",
            reproduce: [`${endpoint.method} ${noAuth.path} sin Authorization`, `Respuesta ${noAuth.status}`],
            evidence: { status: noAuth.status },
          }),
        );
    }

    // The shape of the token itself, read from any authenticated probe that carried an Authorization.
    for (const result of byTestType(results, "auth")) {
      const authorization = result.headers.Authorization ?? "";
      const decoded = authorization ? decodeJwt(authorization) : null;
      if (!decoded) continue;
      if (String(decoded.header.alg).toLowerCase() === "none")
        findings.push(
          make("critical", result.endpointId, {
            title: "El token viaja con alg: none",
            detail: "El JWT presentado no lleva firma. Cualquiera puede fabricar uno.",
            remediation: "Firma los tokens con un algoritmo asimétrico o HMAC y rechaza alg: none.",
            reproduce: ["Decodifica el JWT y observa el header alg"],
            evidence: { alg: decoded.header.alg },
          }),
        );
      if (decoded.payload.exp === undefined)
        findings.push(
          make("high", result.endpointId, {
            title: "El token no caduca",
            detail: "El JWT no tiene claim exp: un token filtrado sirve para siempre.",
            remediation: "Emite tokens con exp y una vida corta.",
            reproduce: ["Decodifica el JWT y comprueba que no hay exp"],
            evidence: { claims: Object.keys(decoded.payload) },
          }),
        );
      break;
    }
    return findings;
  },
};

const ATTACK_META: RuleMeta = {
  key: "jwt_attack",
  id: "OWASP-API2-JWT-ATTACKS",
  name: "Ataques al JWT",
  category: "Autenticación",
  references: refs("api2-broken-authentication.html", 347),
};
export const jwtAttackRule: SecurityRule = {
  ...ATTACK_META,
  evaluate(results) {
    const make = finder(ATTACK_META);
    const LABEL: Record<string, string> = {
      "alg-none": "un token con alg: none",
      expired: "un token caducado",
      tampered: "un token con el payload manipulado",
    };
    return byTestType(results, "jwt-attack")
      .filter((result) => result.token && isSuccess(result.status))
      .map((result) => {
        const attack = suffix(result.testType);
        return make(attack === "alg-none" || attack === "tampered" ? "critical" : "high", result.endpointId, {
          title: `El servidor aceptó ${LABEL[attack] ?? attack}`,
          detail: `${result.method} ${result.path} respondió ${result.status} con ${LABEL[attack] ?? attack}: no valida la firma o la caducidad.`,
          remediation: "Verifica firma y exp en cada petición; rechaza alg: none.",
          reproduce: [`${result.method} ${result.path} con ${LABEL[attack] ?? attack} → ${result.status}`],
          evidence: { attack, status: result.status },
        });
      });
  },
};
