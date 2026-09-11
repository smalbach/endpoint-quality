/**
 * The same report, written for the two readers that are not a program fetching JSON.
 *
 * A run is a result somebody keeps: attached to a pull request, compared against last week's,
 * failed a pipeline on. JSON covers the third reader — something that parses it — and leaves the
 * other two unserved:
 *
 * - **a CI job.** Every runner on the market reads JUnit XML and draws the red cases in its own
 *   UI, with the failure text next to the test that produced it. Without it a pipeline can say
 *   «la corrida falló» and nothing about which of 311 cases did, so somebody opens a browser to
 *   find out — which is the loop a CI report exists to remove.
 * - **a person who was sent a link.** An HTML page opens; a JSON file is something to pipe through
 *   `jq` first.
 *
 * Pure functions over the report the query already builds, and no templating engine: the coupled
 * dashboard rendered its HTML with handlebars and its PDF with puppeteer, and neither dependency
 * earns its place for one page with no logic in it. What they do have to be is **escaped
 * correctly** — every string here came from a target's response or from somebody's endpoint
 * names — which is the part with tests.
 */
import type { ReportCase, RunReport } from "../application/queries/get-run";

/** The formats `?format=` accepts. Exported so the DTO validates against this list rather than
 * against a second copy of it. */
export const REPORT_FORMATS = ["json", "html", "junit"] as const;
export type ReportFormat = (typeof REPORT_FORMATS)[number];

export const REPORT_CONTENT_TYPE: Record<Exclude<ReportFormat, "json">, string> = {
  html: "text/html; charset=utf-8",
  junit: "application/xml; charset=utf-8",
};

/**
 * XML's five, and the control characters XML 1.0 cannot hold at all.
 *
 * The five are the ones that break the document; the control characters are the ones that make it
 * *unparseable* without looking wrong anywhere — a target that answered with a stray `\u0001` in
 * its error message would produce a report file every CI runner rejects, and the message would be
 * about the file rather than about the endpoint. They are dropped rather than escaped because
 * `&#1;` is not legal XML 1.0 either. Tab, newline and carriage return are kept: they are the
 * three XML 1.0 allows, and a multi-line failure detail is exactly where they appear.
 */
export function escapeXml(value: string): string {
  return (
    value
      // The rule exists to catch a control character somebody pasted in by accident. Here they are
      // the subject: this is the line that removes them, and writing it without naming them would
      // mean matching on codepoints one by one to avoid saying what it matches.
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&apos;")
  );
}

/** The four that matter in an HTML body or an attribute. Same rule either way, so there is one
 * function and no decision to get wrong at each call site. */
export function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

const seconds = (ms: number | null | undefined): string => ((ms ?? 0) / 1000).toFixed(3);

/** What a run was launched to execute, in the words the history uses. */
function sourceLabel(run: RunReport["run"]): string {
  const source = run.source;
  if (source.kind === "workflow") {
    const dataset = source.datasetName ? ` · ${source.datasetName} (${source.rows} filas)` : "";
    return `Flujo ${source.name ?? "eliminado"}${dataset}`;
  }
  if (source.kind === "suite") return `Suite ${source.name ?? "eliminada"} · ${source.flowNames.length} flujos`;
  const selection = [
    ...(source.labels?.length ? [source.labels.join(", ")] : []),
    `${source.operationIds.length || "todas las"} operaciones`,
  ];
  return `Matriz · ${selection.join(" · ")}`;
}

/**
 * The report as JUnit XML.
 *
 * **One `<testsuite>` per operation**, because that is the grouping a CI UI collapses by and an
 * operation is the unit somebody owns: `createWidget` failing in four of its scenarios is one
 * conversation. The alternative — one suite for the whole run — draws 311 flat rows that no
 * runner's UI makes navigable.
 *
 * A case that is `skipped` is `<skipped/>` and not a failure, which is the distinction the whole
 * format exists for: a case that never ran because the step before it failed is not a second
 * broken endpoint, and counting it as one turns one finding into a screenful.
 *
 * Failures carry the assertion **labels and details**, joined, because that is the text the runner
 * shows next to the test name. A `message` of «falló» would make the report as useless as the
 * exit code it replaces.
 */
export function toJUnitXml(report: RunReport): string {
  const byOperation = new Map<string, ReportCase[]>();
  for (const runCase of report.cases as ReportCase[]) {
    byOperation.set(runCase.operationId, [...(byOperation.get(runCase.operationId) ?? []), runCase]);
  }

  const totals = report.run.totals;
  const suites = [...byOperation.entries()].map(([operationId, cases]) => {
    const failures = cases.filter((runCase) => runCase.status === "failed").length;
    const skipped = cases.filter((runCase) => runCase.status === "skipped").length;
    const time = cases.reduce((sum, runCase) => sum + (runCase.durationMs ?? 0), 0);
    const testcases = cases.map((runCase) => {
      const name = escapeXml(`${runCase.scenarioId} — ${runCase.method} ${runCase.path}`);
      const open = `    <testcase classname="${escapeXml(operationId)}" name="${name}" time="${seconds(runCase.durationMs)}">`;
      if (runCase.status === "skipped") return `${open}\n      <skipped/>\n    </testcase>`;
      if (runCase.status !== "failed") return `${open}</testcase>`;
      // Only the claims that did not hold. Listing the twenty that did, next to the one that did
      // not, is how a failure message stops being read.
      const broken = runCase.steps
        .flatMap((step) => step.assertions)
        .filter((assertion) => !assertion.pass && assertion.severity !== "warning");
      const detail = broken.map((assertion) => `${assertion.label}: ${assertion.detail}`).join("\n");
      const message = escapeXml(broken[0]?.label ?? "El caso no cumplió lo que esperaba");
      const kind = escapeXml(runCase.failure ?? "check");
      return `${open}\n      <failure type="${kind}" message="${message}">${escapeXml(detail)}</failure>\n    </testcase>`;
    });
    return [
      `  <testsuite name="${escapeXml(operationId)}" tests="${cases.length}" failures="${failures}" skipped="${skipped}" time="${seconds(time)}">`,
      ...testcases,
      "  </testsuite>",
    ].join("\n");
  });

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<testsuites name="${escapeXml(sourceLabel(report.run))}" tests="${totals.cases}" failures="${totals.failed}" skipped="${totals.skipped}" time="${seconds(elapsed(report.run))}">`,
    ...suites,
    "</testsuites>",
    "",
  ].join("\n");
}

/** Wall clock of the run, which is not the sum of the cases: they can run several at a time. */
function elapsed(run: RunReport["run"]): number {
  const finished = run.finishedAt?.getTime() ?? Date.now();
  return Math.max(0, finished - run.startedAt.getTime());
}

/**
 * The report as one self-contained HTML page.
 *
 * Self-contained on purpose — the styles are inline and there is no script — because of where it
 * ends up: an artifact in a CI job, an attachment in a ticket, a file opened from disk six months
 * later. A page that fetches anything is a page that renders differently, or not at all, in every
 * one of those.
 *
 * **The failed cases come first**, and the ones that passed are behind a `<details>`. A report is
 * opened to find out what broke; a list in execution order buries four red rows under three
 * hundred green ones, and the reader's first act is to search the page.
 */
export function toHtmlReport(report: RunReport): string {
  const totals = report.run.totals;
  // Annotated because `RunReport["cases"]` is an intersection of two array types, and `filter` on
  // one of those resolves to the narrower element — which is the half without `failure` or
  // `durationMs`, both of which this page shows.
  const cases: ReportCase[] = report.cases;
  const failed = cases.filter((runCase) => runCase.status === "failed");
  const rest = cases.filter((runCase) => runCase.status !== "failed");

  const caseRow = (runCase: ReportCase) => {
    const broken = runCase.steps
      .flatMap((step) => step.assertions)
      .filter((assertion) => !assertion.pass && assertion.severity !== "warning");
    const warnings = runCase.steps
      .flatMap((step) => step.assertions)
      .filter((a) => !a.pass && a.severity === "warning");
    const notes = [...broken, ...warnings].map(
      (assertion) =>
        `<li class="${assertion.severity === "warning" ? "warn" : "bad"}"><b>${escapeHtml(assertion.label)}</b> ${escapeHtml(assertion.detail)}</li>`,
    );
    return `<tr class="${runCase.status}">
  <td><span class="pill ${runCase.status}">${runCase.status}</span></td>
  <td><code>${escapeHtml(runCase.method)} ${escapeHtml(runCase.path)}</code><div class="sub">${escapeHtml(runCase.scenarioId)}</div></td>
  <td>${runCase.failure ? `<span class="kind">${escapeHtml(runCase.failure)}</span>` : ""}</td>
  <td class="num">${runCase.durationMs ?? 0} ms</td>
  <td>${notes.length ? `<ul>${notes.join("")}</ul>` : ""}</td>
</tr>`;
  };

  const table = (cases: ReportCase[]) =>
    `<table><thead><tr><th>Estado</th><th>Caso</th><th>Fallo</th><th>Tiempo</th><th>Comprobaciones</th></tr></thead><tbody>${cases
      .map(caseRow)
      .join("")}</tbody></table>`;

  return `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Corrida ${escapeHtml(report.run.id)}</title>
<style>
  :root { color-scheme: light dark; }
  body { margin: 0; padding: 2rem 1.5rem; font: 14px/1.5 system-ui, sans-serif; background: #f8fafc; color: #0f172a; }
  h1 { margin: 0 0 .25rem; font-size: 1.25rem; }
  .meta { color: #64748b; font-size: .8rem; }
  .totals { display: flex; flex-wrap: wrap; gap: .5rem; margin: 1rem 0; }
  .totals div { border: 1px solid #e2e8f0; border-radius: .5rem; background: #fff; padding: .5rem .75rem; }
  .totals b { display: block; font-size: 1.25rem; }
  h2 { margin: 1.5rem 0 .5rem; font-size: .95rem; }
  /* The one thing a report must never do on a phone: make the reader scroll the page sideways to
     read a path. The table scrolls inside its own box instead. */
  .scroll { overflow-x: auto; border: 1px solid #e2e8f0; border-radius: .5rem; background: #fff; }
  table { width: 100%; border-collapse: collapse; font-size: .8rem; }
  th { text-align: left; padding: .5rem .75rem; border-bottom: 1px solid #e2e8f0; color: #64748b; font-weight: 600; }
  td { padding: .5rem .75rem; border-bottom: 1px solid #f1f5f9; vertical-align: top; }
  .num { text-align: right; white-space: nowrap; }
  .sub { color: #94a3b8; font-size: .72rem; }
  code { font-family: ui-monospace, monospace; }
  .pill { display: inline-block; border-radius: 999px; padding: 0 .5rem; font-size: .7rem; font-weight: 600; }
  .pill.passed { background: #dcfce7; color: #166534; }
  .pill.failed { background: #fee2e2; color: #991b1b; }
  .pill.skipped { background: #f1f5f9; color: #475569; }
  .kind { border: 1px solid #fecaca; border-radius: .25rem; padding: 0 .35rem; font-size: .7rem; color: #b91c1c; }
  ul { margin: 0; padding-left: 1rem; }
  li.bad { color: #b91c1c; }
  li.warn { color: #a16207; }
  details { margin-top: .5rem; }
  summary { cursor: pointer; color: #475569; font-size: .8rem; }
  @media (prefers-color-scheme: dark) {
    body { background: #0f172a; color: #e2e8f0; }
    .totals div, .scroll { background: #1e293b; border-color: #334155; }
    th { border-color: #334155; color: #94a3b8; }
    td { border-color: #1e293b; }
    /* The light-mode reds are a hair above the threshold on white and well under it on slate.
       Restated rather than made lighter in both: a failure kind that cannot be read is a column
       that may as well not be there. */
    .kind { border-color: #7f1d1d; color: #fca5a5; }
    li.bad { color: #fca5a5; }
    li.warn { color: #fcd34d; }
    .pill.passed { background: #14532d; color: #bbf7d0; }
    .pill.failed { background: #7f1d1d; color: #fecaca; }
    .pill.skipped { background: #334155; color: #cbd5e1; }
    .sub { color: #64748b; }
    summary { color: #94a3b8; }
  }
</style>
</head>
<body>
<h1>${escapeHtml(sourceLabel(report.run))}</h1>
<p class="meta">Corrida ${escapeHtml(report.run.id)} · ${escapeHtml(report.run.status)} · ${escapeHtml(report.run.startedAt.toISOString())} · ${seconds(elapsed(report.run))} s</p>
<div class="totals">
  <div><b>${totals.cases}</b>casos</div>
  <div><b>${totals.passed}</b>pasaron</div>
  <div><b>${totals.failed}</b>fallaron</div>
  <div><b>${totals.skipped}</b>saltados</div>
</div>
${failed.length ? `<h2>Fallaron (${failed.length})</h2><div class="scroll">${table(failed)}</div>` : "<h2>No falló ningún caso</h2>"}
${rest.length ? `<details><summary>El resto (${rest.length})</summary><div class="scroll">${table(rest)}</div></details>` : ""}
</body>
</html>
`;
}
