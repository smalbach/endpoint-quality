import { Inject, Injectable } from "@nestjs/common";

import { ENV, type Env } from "@/shared/config/env";
import type { SecurityRun, SecurityRunAi } from "../domain/model";
import { deterministicAnalysis, type SecurityAiPort } from "../domain/ai";

/** The default: numbers into sentences, no model, always available. */
@Injectable()
export class FallbackSecurityAi implements SecurityAiPort {
  async analyze(run: SecurityRun): Promise<SecurityRunAi> {
    return deterministicAnalysis(run);
  }
}

/**
 * The optional narrator, backed by Anthropic when a key is present.
 *
 * It is sent the summary and the findings — **not the probe bodies**, which the analyzer streamed
 * whole to the model, leaking response contents and blowing the token budget. It writes prose only;
 * the deterministic analysis is the base, and the model's fields are merged over it, so a truncated
 * or malformed answer degrades to the fallback rather than to nothing. Any failure returns the
 * fallback: an unreachable model must not fail a finished run.
 */
@Injectable()
export class AnthropicSecurityAi implements SecurityAiPort {
  constructor(@Inject(ENV) private readonly env: Env) {}

  async analyze(run: SecurityRun): Promise<SecurityRunAi> {
    const base = deterministicAnalysis(run);
    if (this.env.SECURITY_AI_DRIVER !== "anthropic" || !this.env.ANTHROPIC_API_KEY) return base;
    try {
      const response = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": this.env.ANTHROPIC_API_KEY,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: this.env.SECURITY_AI_MODEL,
          max_tokens: 2048,
          messages: [{ role: "user", content: this.prompt(run) }],
        }),
        signal: AbortSignal.timeout(30_000),
      });
      if (!response.ok) return base;
      const payload = (await response.json()) as { content?: { text?: string }[] };
      const text = payload.content?.map((block) => block.text ?? "").join("") ?? "";
      const parsed = extractJson(text);
      if (!parsed) return base;
      return {
        executiveSummary: typeof parsed.executiveSummary === "string" ? parsed.executiveSummary : base.executiveSummary,
        scoreJustification:
          typeof parsed.scoreJustification === "string" ? parsed.scoreJustification : base.scoreJustification,
        top: base.top,
        // The prose per rule is where the model helps most: its `codeExample` merged onto the
        // deterministic solution, keyed by ruleKey so an unknown key is dropped.
        groups: mergeGroups(base, parsed.groups),
      };
    } catch {
      return base;
    }
  }

  private prompt(run: SecurityRun): string {
    const findings = run.findings.map((finding) => ({
      ruleKey: finding.ruleKey,
      severity: finding.severity,
      title: finding.title,
      detail: finding.detail,
    }));
    return [
      "Eres un analista de seguridad de APIs. Te doy el resumen y los hallazgos de una corrida.",
      "Responde SOLO con un objeto JSON con estas claves:",
      '{"executiveSummary": string, "scoreJustification": string, "groups": [{"ruleKey": string, "solution": string, "codeExample": string|null}]}',
      "En español, conciso y accionable. No inventes hallazgos ni cambies la puntuación.",
      `Puntuación: ${run.score}. Riesgo: ${run.risk}.`,
      `Hallazgos: ${JSON.stringify(findings)}`,
    ].join("\n");
  }
}

function mergeGroups(base: SecurityRunAi, raw: unknown): SecurityRunAi["groups"] {
  if (!Array.isArray(raw)) return base.groups;
  const known = new Set<string>(base.groups.map((group) => group.ruleKey));
  const byKey = new Map(
    raw
      .filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === "object")
      .filter((entry) => typeof entry.ruleKey === "string" && known.has(entry.ruleKey))
      .map((entry) => [entry.ruleKey as string, entry]),
  );
  return base.groups.map((group) => {
    const model = byKey.get(group.ruleKey);
    return {
      ...group,
      solution: typeof model?.solution === "string" ? model.solution : group.solution,
      codeExample: typeof model?.codeExample === "string" ? model.codeExample : group.codeExample,
    };
  });
}

/** The first JSON object in a model's answer, fenced or not. */
function extractJson(text: string): Record<string, unknown> | null {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text)?.[1];
  const candidate = fenced ?? text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1);
  try {
    const value: unknown = JSON.parse(candidate);
    return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}
