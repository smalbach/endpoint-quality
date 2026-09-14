import { RULE_KEYS, type RuleKey } from "./types.ts";

/** A full selection, every rule on or off. */
export type RuleSelection = Record<RuleKey, boolean>;

const all = (value: boolean): RuleSelection =>
  Object.fromEntries(RULE_KEYS.map((key) => [key, value])) as RuleSelection;

/**
 * What runs by default.
 *
 * Three are off: the rate-limit flood is slow and noisy, and version-consistency and size-anomaly
 * are heuristics that need more than one endpoint or role to say anything. Everything else that
 * follows from a single request is on. Unlike the analyzer, the toggle actually gates the traffic —
 * a rule that is off sends no probes, not just hidden findings.
 */
export const DEFAULT_RULES: RuleSelection = {
  ...all(true),
  rate_limit: false,
  endpoint_consistency: false,
  response_size_anomaly: false,
};

export const RULE_GROUPS: { title: string; keys: RuleKey[] }[] = [
  { title: "Autorización", keys: ["bola_idor", "bfla", "cross_user_access", "method_tampering"] },
  { title: "Autenticación", keys: ["auth_jwt", "jwt_attack"] },
  { title: "Inyección y datos", keys: ["injection", "mass_assignment", "data_exposure"] },
  { title: "Errores", keys: ["error_disclosure", "verbose_error"] },
  { title: "Configuración", keys: ["rate_limit", "security_headers", "cors", "content_type"] },
  { title: "Inventario", keys: ["endpoint_consistency", "response_size_anomaly"] },
];

const only = (keys: RuleKey[]): RuleSelection =>
  ({ ...all(false), ...Object.fromEntries(keys.map((key) => [key, true])) }) as RuleSelection;

export const PRESETS: { id: string; label: string; rules: RuleSelection }[] = [
  {
    id: "owasp",
    label: "OWASP Top 10",
    rules: only([
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
    rules: only(["auth_jwt", "jwt_attack", "bola_idor", "bfla", "cross_user_access"]),
  },
  { id: "all", label: "Todas", rules: all(true) },
  { id: "default", label: "Recomendadas", rules: DEFAULT_RULES },
];

/** Fills any missing key from `DEFAULT_RULES`, so a partial selection is still a full one. */
export function normalizeSelection(partial: Partial<RuleSelection> | undefined): RuleSelection {
  return { ...DEFAULT_RULES, ...partial };
}
