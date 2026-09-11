/**
 * The path a case actually requests.
 *
 * It lived inside the dashboard component, which meant the server had no way to compute it and
 * the browser was the only thing that knew what a case would send. Here both sides derive it
 * from the same function — and it matters beyond tidiness: the latency budget of a GET can
 * depend on the query string, so the resolved path is an input to the assertion, not a display
 * detail.
 */
import type { Operation } from "./types.ts";
import { parametersFor, type ProjectConfig } from "./config.ts";

export function resolvePath(operation: Operation, values: Record<string, string>, fallback = "1"): string {
  const path = operation.path.replace(/\{([^}]+)\}/g, (_, key: string) => encodeURIComponent(values[key] || fallback));
  const query = new URLSearchParams();
  operation.parameters
    .filter((name) => !operation.path.includes(`{${name}}`) && values[name])
    .forEach((name) => query.set(name, values[name]));
  return query.size ? `${path}?${query}` : path;
}

/** The path a given case requests: the project's placeholder defaults, overridden by whatever
 * the case itself declares. */
export function requestPathFor(
  operation: Operation,
  config: ProjectConfig,
  parameters: Record<string, string> = {},
): string {
  // The same names as before, resolved per operation: what `{id}` is worth now depends on which
  // operation is asking, because `{id}` in `/widgets/{id}` is not `{id}` in `/usuarios/{id}`.
  //
  // The **keys** still come from what was configured and not from the operation's parameter list.
  // `resolvePath` puts anything it is given and does not find in the path into the query string,
  // so handing it every declared name would add a filter to every request — with the fallback
  // value, on parameters nobody configured.
  const values = parametersFor(config, operation.id);
  const configured = new Set([
    ...Object.keys(config.pathDefaults),
    ...Object.keys(config.operationParameters[operation.id]?.pathDefaults ?? {}),
  ]);
  const defaults = Object.fromEntries([...configured].map((name) => [name, values.present(name)]));
  return resolvePath(operation, { ...defaults, ...parameters }, config.fallbackPathValue);
}
