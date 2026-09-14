/**
 * The security run as a report: JSON for a machine, and one self-contained, print-ready HTML page.
 *
 * No headless browser on the server. The analyzer shipped puppeteer to render a PDF, which drags a
 * whole Chromium into the image and a sandbox flag with it; a print-styled HTML page that the
 * reader saves as PDF from their browser is the same artefact without the attack surface. The page
 * has `@media print` rules and a print button, and nothing it loads is remote.
 */
import { escapeHtml } from "@/modules/runs/presentation/report-formats";
import type { SecurityRun } from "../domain/model";

export const SECURITY_REPORT_FORMATS = ["json", "html"] as const;
export type SecurityReportFormat = (typeof SECURITY_REPORT_FORMATS)[number];

export function securityReportFormat(value: string | undefined): SecurityReportFormat {
  return value === "html" ? "html" : "json";
}

const SEVERITY_LABEL: Record<string, string> = {
  critical: "Crítico",
  high: "Alto",
  medium: "Medio",
  low: "Bajo",
  info: "Info",
};
const SEVERITY_COLOR: Record<string, string> = {
  critical: "#b91c1c",
  high: "#c2410c",
  medium: "#b45309",
  low: "#0369a1",
  info: "#475569",
};

/** The report's own view of a run, with the endpoint labels the page shows resolved in. */
export type SecurityReportInput = { run: SecurityRun; endpointLabel: (id: string | null) => string; generatedAt: Date };

export function toSecurityReportJson(input: SecurityReportInput): unknown {
  const { run } = input;
  return {
    label: run.label,
    status: run.status,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    score: run.score,
    risk: run.risk,
    summary: run.summary,
    findings: run.findings.map((finding) => ({ ...finding, endpoint: input.endpointLabel(finding.endpointId) })),
    ai: run.ai,
    generatedAt: input.generatedAt,
  };
}

export function toSecurityReportHtml(input: SecurityReportInput): string {
  const { run } = input;
  const summary = run.summary;
  const scoreColor = (run.score ?? 0) >= 80 ? "#047857" : (run.score ?? 0) >= 60 ? "#b45309" : "#b91c1c";
  const bySeverity = summary?.bySeverity ?? { critical: 0, high: 0, medium: 0, low: 0, info: 0 };

  const findingRows = run.findings
    .map(
      (finding) => `
        <tr>
          <td><span class="sev" style="background:${SEVERITY_COLOR[finding.severity]}">${SEVERITY_LABEL[finding.severity] ?? finding.severity}</span></td>
          <td>${escapeHtml(finding.ruleName)}</td>
          <td>${escapeHtml(input.endpointLabel(finding.endpointId))}</td>
          <td>
            <strong>${escapeHtml(finding.title)}</strong>
            <div class="muted">${escapeHtml(finding.detail)}</div>
            <div class="fix">Corrección: ${escapeHtml(finding.remediation)}</div>
          </td>
        </tr>`,
    )
    .join("");

  const unprotectedRows = (summary?.unprotected ?? [])
    .map((entry) => `<li><code>${escapeHtml(entry.method)} ${escapeHtml(entry.path)}</code> → ${entry.status}</li>`)
    .join("");

  const ai = run.ai
    ? `
      <section>
        <h2>Análisis</h2>
        <p>${escapeHtml(run.ai.executiveSummary)}</p>
        <p class="muted">${escapeHtml(run.ai.scoreJustification)}</p>
        <ol>${run.ai.top.map((item) => `<li><strong>${escapeHtml(item.title)}</strong> — ${escapeHtml(item.description)}</li>`).join("")}</ol>
      </section>`
    : "";

  // A single document, no remote assets, print stylesheet inline. `printed` toggles the button off
  // in the print output.
  return `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8" />
<title>Informe de seguridad · ${escapeHtml(run.label)}</title>
<style>
  :root { font-family: system-ui, sans-serif; color: #0f172a; }
  body { margin: 0; padding: 2rem; background: #f8fafc; }
  .sheet { max-width: 60rem; margin: 0 auto; background: #fff; padding: 2.5rem; border-radius: 12px; box-shadow: 0 1px 3px rgba(0,0,0,.1); }
  h1 { font-size: 1.5rem; margin: 0 0 .25rem; }
  h2 { font-size: 1.1rem; margin: 2rem 0 .5rem; border-bottom: 1px solid #e2e8f0; padding-bottom: .25rem; }
  .muted { color: #64748b; font-size: .85rem; }
  .fix { color: #334155; font-size: .8rem; margin-top: .25rem; }
  .score { font-size: 3rem; font-weight: 700; color: ${scoreColor}; }
  .cards { display: flex; gap: 1rem; flex-wrap: wrap; margin: 1rem 0; }
  .card { border: 1px solid #e2e8f0; border-radius: 8px; padding: .75rem 1rem; min-width: 8rem; }
  .card .n { font-size: 1.5rem; font-weight: 600; }
  table { width: 100%; border-collapse: collapse; font-size: .85rem; }
  th, td { text-align: left; padding: .5rem; border-bottom: 1px solid #e2e8f0; vertical-align: top; }
  .sev { color: #fff; padding: .1rem .4rem; border-radius: 4px; font-size: .7rem; white-space: nowrap; }
  code { font-family: ui-monospace, monospace; font-size: .8rem; }
  button { margin-bottom: 1rem; padding: .5rem 1rem; border: 1px solid #cbd5e1; border-radius: 8px; background: #fff; cursor: pointer; }
  @media print { body { background: #fff; padding: 0; } .sheet { box-shadow: none; max-width: none; } button { display: none; } }
</style>
</head>
<body>
  <div class="sheet">
    <button onclick="window.print()">Imprimir / Guardar como PDF</button>
    <h1>Informe de seguridad</h1>
    <p class="muted">${escapeHtml(run.label)} · ${new Date(run.startedAt).toLocaleString("es")}</p>
    <div class="cards">
      <div class="card"><div class="muted">Puntuación</div><div class="score">${run.score ?? "—"}</div></div>
      <div class="card"><div class="muted">Riesgo</div><div class="n">${run.risk ?? "—"}</div></div>
      <div class="card"><div class="muted">Hallazgos</div><div class="n">${summary?.findings ?? 0}</div></div>
      <div class="card"><div class="muted">Endpoints</div><div class="n">${summary?.endpointsTested ?? 0}</div></div>
    </div>
    <div class="cards">
      ${(["critical", "high", "medium", "low"] as const)
        .map(
          (severity) =>
            `<div class="card"><div class="muted">${SEVERITY_LABEL[severity]}</div><div class="n" style="color:${SEVERITY_COLOR[severity]}">${bySeverity[severity] ?? 0}</div></div>`,
        )
        .join("")}
    </div>
    ${ai}
    ${unprotectedRows ? `<section><h2>Endpoints sin proteger</h2><ul>${unprotectedRows}</ul></section>` : ""}
    <section>
      <h2>Hallazgos</h2>
      ${run.findings.length ? `<table><thead><tr><th>Severidad</th><th>Regla</th><th>Endpoint</th><th>Detalle</th></tr></thead><tbody>${findingRows}</tbody></table>` : '<p class="muted">Sin hallazgos.</p>'}
    </section>
    <p class="muted" style="margin-top:2rem">Generado el ${input.generatedAt.toLocaleString("es")} · Endpoint Quality</p>
  </div>
</body>
</html>`;
}
