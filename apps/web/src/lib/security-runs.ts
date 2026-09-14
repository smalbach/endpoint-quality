/**
 * The security run, as the screens speak about it: severities, the rule catalogue, the presets,
 * and the small derivations the list and detail share.
 *
 * The rule keys and presets mirror `@eq/security-rules`; the web bundle does not import that package
 * (it is Node-only), so the catalogue lives here and the API is the one that enforces it. A key that
 * drifted would show a checkbox the server ignores, which is why the list is kept short and beside
 * the labels that explain each one.
 */
import type { SecurityRisk, SecurityRunStatus, SecuritySeverity } from "@/lib/types";

export const SEVERITY_LABEL: Record<SecuritySeverity, string> = {
  critical: "Crítico",
  high: "Alto",
  medium: "Medio",
  low: "Bajo",
  info: "Info",
};

export const SEVERITY_CLASS: Record<SecuritySeverity, string> = {
  critical: "bg-rose-100 text-rose-800 border-rose-200",
  high: "bg-orange-100 text-orange-800 border-orange-200",
  medium: "bg-amber-100 text-amber-800 border-amber-200",
  low: "bg-sky-100 text-sky-800 border-sky-200",
  info: "bg-slate-100 text-slate-600 border-slate-200",
};

export const RISK_LABEL: Record<SecurityRisk, string> = {
  critical: "Crítico",
  high: "Alto",
  medium: "Medio",
  low: "Bajo",
};

export const STATUS_LABEL: Record<SecurityRunStatus, string> = {
  queued: "En cola",
  running: "En curso",
  passed: "Sin fallos",
  failed: "Con hallazgos",
  cancelled: "Cancelada",
  error: "Error",
};

export const STATUS_CLASS: Record<SecurityRunStatus, string> = {
  queued: "bg-slate-100 text-slate-600",
  running: "bg-sky-100 text-sky-700",
  passed: "bg-emerald-100 text-emerald-700",
  failed: "bg-rose-100 text-rose-700",
  cancelled: "bg-slate-100 text-slate-500",
  error: "bg-amber-100 text-amber-800",
};

export const isTerminal = (status: SecurityRunStatus): boolean =>
  status === "passed" || status === "failed" || status === "cancelled" || status === "error";

export type RuleKey =
  | "bola_idor"
  | "bfla"
  | "auth_jwt"
  | "jwt_attack"
  | "cross_user_access"
  | "injection"
  | "mass_assignment"
  | "data_exposure"
  | "error_disclosure"
  | "verbose_error"
  | "rate_limit"
  | "security_headers"
  | "cors"
  | "method_tampering"
  | "content_type"
  | "endpoint_consistency"
  | "response_size_anomaly";

export const RULE_LABEL: Record<RuleKey, string> = {
  bola_idor: "BOLA / IDOR",
  bfla: "BFLA (función)",
  auth_jwt: "Autenticación y JWT",
  jwt_attack: "Ataques al JWT",
  cross_user_access: "Acceso entre usuarios",
  injection: "Inyección",
  mass_assignment: "Asignación masiva",
  data_exposure: "Exposición de datos",
  error_disclosure: "Divulgación en errores",
  verbose_error: "Errores detallados",
  rate_limit: "Límite de peticiones",
  security_headers: "Cabeceras de seguridad",
  cors: "CORS",
  method_tampering: "Manipulación de método",
  content_type: "Content-Type",
  endpoint_consistency: "Consistencia entre versiones",
  response_size_anomaly: "Tamaño anómalo",
};

export const RULE_GROUPS: { title: string; keys: RuleKey[] }[] = [
  { title: "Autorización", keys: ["bola_idor", "bfla", "cross_user_access", "method_tampering"] },
  { title: "Autenticación", keys: ["auth_jwt", "jwt_attack"] },
  { title: "Inyección y datos", keys: ["injection", "mass_assignment", "data_exposure"] },
  { title: "Errores", keys: ["error_disclosure", "verbose_error"] },
  { title: "Configuración", keys: ["rate_limit", "security_headers", "cors", "content_type"] },
  { title: "Inventario", keys: ["endpoint_consistency", "response_size_anomaly"] },
];

export const ALL_RULE_KEYS = RULE_GROUPS.flatMap((group) => group.keys);

const on = (keys: RuleKey[]): Record<RuleKey, boolean> =>
  Object.fromEntries(ALL_RULE_KEYS.map((key) => [key, keys.includes(key)])) as Record<RuleKey, boolean>;

export const DEFAULT_RULES: Record<RuleKey, boolean> = {
  ...on(ALL_RULE_KEYS),
  rate_limit: false,
  endpoint_consistency: false,
  response_size_anomaly: false,
};

export const PRESETS: { id: string; label: string; rules: Record<RuleKey, boolean> }[] = [
  { id: "default", label: "Recomendadas", rules: DEFAULT_RULES },
  {
    id: "owasp",
    label: "OWASP Top 10",
    rules: on([
      "bola_idor",
      "bfla",
      "auth_jwt",
      "jwt_attack",
      "injection",
      "mass_assignment",
      "data_exposure",
      "cors",
      "security_headers",
    ]),
  },
  {
    id: "auth",
    label: "Solo autorización",
    rules: on(["auth_jwt", "jwt_attack", "bola_idor", "bfla", "cross_user_access"]),
  },
  { id: "all", label: "Todas", rules: on(ALL_RULE_KEYS) },
];

export const SEVERITY_ORDER: SecuritySeverity[] = ["critical", "high", "medium", "low", "info"];

export const scoreColor = (score: number): string =>
  score >= 80 ? "text-emerald-600" : score >= 60 ? "text-amber-600" : score >= 40 ? "text-orange-600" : "text-rose-600";
