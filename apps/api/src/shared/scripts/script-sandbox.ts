/**
 * Pre-request and post-response scripts: what goes in, what comes out, and nothing else.
 *
 * The analyzer ran endpoint scripts in the browser with `new Function` and flow scripts on the
 * server with `node:vm`. Neither is a boundary — `(() => {}).constructor` is the way out of both —
 * and on the server the way out lands in a process holding every project's secrets. Here a script
 * runs in **a process of its own**, started for that one script:
 *
 * - no environment variables, so no database URL, no JWT secret, no encryption key;
 * - Node's permission model on, so no file system, no child processes, no worker threads;
 * - code generation from strings disallowed, so the classic `constructor('return process')()`
 *   throws instead of escaping the context;
 * - a heap cap and a wall-clock limit, after which the process is killed rather than asked.
 *
 * What crosses the boundary is JSON in both directions. The result is read as untrusted data —
 * {@link sanitizeOutcome} — because whatever a script managed to do inside its process, the most
 * it can hand back is a string this side parses and trims.
 */

export const SCRIPT_SANDBOX = Symbol("SCRIPT_SANDBOX");

export type ScriptPhase = "pre" | "post";

export type ScriptInput = {
  phase: ScriptPhase;
  code: string;
  environment: { name: string | null; values: Record<string, string> };
  /** Request-scoped values, `pm.variables`. The post script receives what the pre script set. */
  variables: Record<string, string>;
  request: { method: string; url: string; headers: Record<string, string>; body: string | null };
  response: { status: number; headers: Record<string, string>; body: string; durationMs: number } | null;
};

export type ScriptLogLevel = "log" | "info" | "warn" | "error";
export type ScriptLog = { level: ScriptLogLevel; text: string };
export type ScriptTest = { name: string; passed: boolean; message: string | null };

/**
 * What `pm.visualizer.set` left: a Handlebars template and its data, both as text. `data` and
 * `options` are JSON; the browser parses them inside the sandboxed frame that renders the template.
 */
export type ScriptVisualization = { template: string; data: string; options: string };

export type ScriptOutcome = {
  /** `Nombre: mensaje (línea n)`, or why the process did not answer. Null when it ran to the end. */
  error: string | null;
  logs: ScriptLog[];
  tests: ScriptTest[];
  /** `pm.environment.set`: written to the current value of the environment the request used. */
  environmentSet: Record<string, string>;
  /** `pm.environment.unset`: the current value is emptied, the variable is kept. */
  environmentUnset: string[];
  variables: Record<string, string>;
  /** The request headers after a pre script, when it ran; null after a post script. */
  headers: Record<string, string> | null;
  /** `pm.visualizer.set` in a post script, or null. */
  visualization: ScriptVisualization | null;
  durationMs: number;
};

export interface ScriptSandboxPort {
  run(input: ScriptInput): Promise<ScriptOutcome>;
}

export const SCRIPT_LIMITS = {
  /** CPU time the script itself gets inside the context. */
  scriptMs: 3_000,
  /** Everything, process start included. Past this the process is killed. */
  totalMs: 6_000,
  heapMb: 64,
  maxLogs: 200,
  maxLineLength: 2_000,
  maxTests: 200,
  maxValueLength: 10_000,
  maxWrites: 100,
  /** `pm.visualizer.set`: a template is markup, its data is a response's worth of JSON. */
  maxTemplateLength: 200_000,
  maxVisualizationData: 2_000_000,
  /** Processes alive at once. A burst of «Enviar» queues rather than forks without end. */
  concurrency: 4,
} as const;

/** The same rule the environments editor and the API apply to a variable name. */
const VARIABLE_NAME = /^[A-Za-z_][A-Za-z0-9_.-]*$/;
const LEVELS: ScriptLogLevel[] = ["log", "info", "warn", "error"];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const clip = (value: string, length: number) => (value.length > length ? `${value.slice(0, length)}…` : value);

function stringMap(value: unknown, limit: number, names = false): Record<string, string> {
  if (!isRecord(value)) return {};
  const entries = Object.entries(value)
    .filter(([name, item]) => typeof item === "string" && (!names || VARIABLE_NAME.test(name)))
    .slice(0, limit)
    .map(([name, item]) => [name, clip(item as string, SCRIPT_LIMITS.maxValueLength)]);
  return Object.fromEntries(entries);
}

export const failedOutcome = (error: string, durationMs: number): ScriptOutcome => ({
  error,
  logs: [],
  tests: [],
  environmentSet: {},
  environmentUnset: [],
  variables: {},
  headers: null,
  visualization: null,
  durationMs,
});

/** Whatever the worker sent, as an outcome with every field of the right type and size. */
export function sanitizeOutcome(raw: unknown, durationMs: number): ScriptOutcome {
  if (!isRecord(raw)) return failedOutcome("El script no devolvió un resultado legible", durationMs);
  const logs = (Array.isArray(raw.logs) ? raw.logs : [])
    .filter(isRecord)
    .slice(0, SCRIPT_LIMITS.maxLogs)
    .map((log) => ({
      level: LEVELS.includes(log.level as ScriptLogLevel) ? (log.level as ScriptLogLevel) : "log",
      text: clip(String(log.text ?? ""), SCRIPT_LIMITS.maxLineLength),
    }));
  const tests = (Array.isArray(raw.tests) ? raw.tests : [])
    .filter(isRecord)
    .slice(0, SCRIPT_LIMITS.maxTests)
    .map((test) => ({
      name: clip(String(test.name ?? ""), 200),
      passed: test.passed === true,
      message: typeof test.message === "string" ? clip(test.message, SCRIPT_LIMITS.maxLineLength) : null,
    }));
  return {
    error: typeof raw.error === "string" ? clip(raw.error, SCRIPT_LIMITS.maxLineLength) : null,
    logs,
    tests,
    environmentSet: stringMap(raw.environmentSet, SCRIPT_LIMITS.maxWrites, true),
    environmentUnset: (Array.isArray(raw.environmentUnset) ? raw.environmentUnset : [])
      .filter((name): name is string => typeof name === "string" && VARIABLE_NAME.test(name))
      .slice(0, SCRIPT_LIMITS.maxWrites),
    variables: stringMap(raw.variables, SCRIPT_LIMITS.maxWrites, true),
    headers: isRecord(raw.headers) ? stringMap(raw.headers, 100) : null,
    visualization: visualizationOf(raw.visualization),
    durationMs,
  };
}

/** Readable JSON of at most `limit` characters, or null. */
function jsonText(value: unknown, limit: number): string | null {
  if (typeof value !== "string" || value.length > limit) return null;
  try {
    JSON.parse(value);
    return value;
  } catch {
    return null;
  }
}

function visualizationOf(value: unknown): ScriptVisualization | null {
  if (!isRecord(value) || typeof value.template !== "string") return null;
  if (value.template.length > SCRIPT_LIMITS.maxTemplateLength) return null;
  const data = jsonText(value.data, SCRIPT_LIMITS.maxVisualizationData);
  if (data === null) return null;
  const options = jsonText(value.options, 10_000);
  return { template: value.template, data, options: options && isRecord(JSON.parse(options)) ? options : "{}" };
}

/**
 * The outcome as a person may see it: every secret replaced by the mask.
 *
 * A script reads sensitive variables — signing a request needs the key — and `console.log` is one
 * keystroke away. Revealing a secret is `admin`; sending a request is `editor`. Without this the
 * console would be the way for an editor to read what the reveal button refuses them.
 */
export function redactOutcome(outcome: ScriptOutcome, secrets: string[]): ScriptOutcome {
  const hidden = [...new Set(secrets.filter((secret) => secret.length >= 4))].sort((a, b) => b.length - a.length);
  if (!hidden.length) return outcome;
  const redact = (text: string) => hidden.reduce((result, secret) => result.split(secret).join("••••••••"), text);
  return {
    ...outcome,
    visualization: outcome.visualization && redactVisualization(outcome.visualization, redact),
    error: outcome.error === null ? null : redact(outcome.error),
    logs: outcome.logs.map((log) => ({ ...log, text: redact(log.text) })),
    tests: outcome.tests.map((test) => ({
      ...test,
      name: redact(test.name),
      message: test.message === null ? null : redact(test.message),
    })),
  };
}

/**
 * The visualization with its secrets masked, walking the data rather than its text.
 *
 * A secret replaced inside the JSON text would break it the moment it sat outside a string — a
 * numeric PIN, a key the script used as a property name — and the frame would get nothing. So the
 * data is parsed, every string, key and number is masked on its own, and it is written back. A
 * number that held a secret comes back as the masked string.
 */
function redactVisualization(
  visualization: ScriptVisualization,
  redact: (text: string) => string,
): ScriptVisualization {
  const walk = (value: unknown): unknown => {
    if (typeof value === "string") return redact(value);
    if (typeof value === "number") {
      const masked = redact(String(value));
      return masked === String(value) ? value : masked;
    }
    if (Array.isArray(value)) return value.map(walk);
    if (isRecord(value))
      return Object.fromEntries(Object.entries(value).map(([key, item]) => [redact(key), walk(item)]));
    return value;
  };
  return {
    template: redact(visualization.template),
    data: JSON.stringify(walk(JSON.parse(visualization.data))),
    options: JSON.stringify(walk(JSON.parse(visualization.options))),
  };
}
