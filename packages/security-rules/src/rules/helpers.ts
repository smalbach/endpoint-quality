import type { Finding, ProbeResult, RuleKey, Severity } from "../types.ts";

const OWASP = "https://owasp.org/API-Security/editions/2023/en/0x11-t10/";
const cwe = (id: number) => `https://cwe.mitre.org/data/definitions/${id}.html`;

/** The OWASP API Top-10 page and the CWE, the two references every rule carries. */
export const refs = (owaspSlug: string, cweId: number): string[] => [`${OWASP}${owaspSlug}`, cwe(cweId)];

export type RuleMeta = { key: RuleKey; id: string; name: string; category: string; references: string[] };

/** Builds a finding, folding the rule's identity in so a rule body only says what it found. */
export function finder(meta: RuleMeta) {
  return (
    severity: Severity,
    endpointId: string | null,
    parts: {
      title: string;
      detail: string;
      remediation: string;
      reproduce: string[];
      evidence: Record<string, unknown>;
    },
  ): Finding => ({
    ruleKey: meta.key,
    ruleId: meta.id,
    ruleName: meta.name,
    category: meta.category,
    severity,
    endpointId,
    title: parts.title,
    detail: parts.detail,
    remediation: parts.remediation,
    references: meta.references,
    reproduce: parts.reproduce,
    evidence: parts.evidence,
  });
}

/** What follows the first `:` of a test type — the role, id, attack or verb a probe was about.
 * `auth:admin` → `admin`, `bola-real-id:admin:11` → `admin`; a bare `auth` has none, so `""`. */
export const suffix = (testType: string): string => testType.split(":")[1] ?? "";

const lower = (headers: Record<string, string>): Record<string, string> =>
  Object.fromEntries(Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value]));

export const header = (result: ProbeResult, name: string): string | undefined =>
  lower(result.responseHeaders)[name.toLowerCase()];

export const bodyIncludes = (result: ProbeResult, ...needles: string[]): boolean => {
  const text = result.bodyText.toLowerCase();
  return needles.some((needle) => text.includes(needle.toLowerCase()));
};

/** How much a probe reveals, so «two roles saw the same thing» has a number behind it. */
export const similar = (a: number, b: number): number => {
  const max = Math.max(a, b);
  return max === 0 ? 1 : Math.min(a, b) / max;
};
