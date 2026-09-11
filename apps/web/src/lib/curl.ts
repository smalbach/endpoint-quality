/**
 * The request that was just sent, written as a `curl` somebody else can run.
 *
 * It is the one format every backend developer already has a terminal for, and the reason it
 * matters here is that the two halves of a bug report are «qué mandaste» and «qué contestó». The
 * panel above shows the second; until now the first could only be retyped from a JSON tree, and a
 * retyped request is a request that no longer reproduces anything.
 *
 * **The credential is masked, and stays masked.** What this builds comes from what the API sent
 * back, and the API masks anything whose header name looks like a secret before the row is even
 * written — that redaction is not this file's to undo, and it could not: the clear value never
 * reached the browser. The consequence is worth saying out loud rather than hiding, because it is
 * mostly a feature: a cURL pasted into a ticket is a cURL somebody's staging token would otherwise
 * have travelled in.
 */

/** Header names the API redacts. The same rule, so the hint can say which lines need filling in
 * without guessing from the value — `••••••••` is also a perfectly legal header value. */
const SECRET_HEADER = /authorization|api[-_]?key|token|secret|cookie/i;

export type CurlRequest = { method: string; url: string; headers: Record<string, string>; body: unknown };

/**
 * Single quotes, always, and `'` escaped the only way a POSIX shell allows.
 *
 * Inside single quotes a shell interprets nothing — no `$`, no backtick, no backslash — which is
 * exactly what a URL with a query string and a JSON body need. The price is that a single quote
 * cannot be escaped *inside* them, so the string is closed, an escaped quote is emitted, and it is
 * reopened: `'it'\''s'`. Ugly, correct, and what every generator does.
 */
export const shellQuote = (value: string): string => `'${value.replace(/'/g, `'\\''`)}'`;

/**
 * The request as a multi-line `curl`.
 *
 * Multi-line because it gets pasted into a ticket and read by a person: one header per line is
 * diffable and a single 400-character line is not. Headers are sorted so that the same request
 * exported twice is the same text — a report somebody compares against last week's should not
 * differ by the order a map happened to iterate in.
 *
 * `--request` is omitted for GET, which is what curl does anyway, so the common case reads as the
 * one-liner people recognise.
 */
export function toCurl(request: CurlRequest): string {
  const lines = [`curl ${request.method === "GET" ? "" : `--request ${request.method} `}${shellQuote(request.url)}`];
  for (const name of Object.keys(request.headers).sort()) {
    lines.push(`  --header ${shellQuote(`${name}: ${request.headers[name]}`)}`);
  }
  if (request.body !== null && request.body !== undefined) {
    // A string body is what crossed the wire — a form, somebody's XML — and goes out as it is.
    // Anything else is the JSON object the panel shows, and is re-serialised compactly: the
    // indentation the viewer adds is not what was sent.
    const payload = typeof request.body === "string" ? request.body : JSON.stringify(request.body);
    lines.push(`  --data ${shellQuote(payload)}`);
  }
  return lines.join(" \\\n");
}

/** The headers whose value came back redacted, so the panel can name them instead of leaving
 * somebody to discover the 401 in a terminal. */
export function maskedHeaders(headers: Record<string, string>): string[] {
  return Object.keys(headers)
    .filter((name) => SECRET_HEADER.test(name))
    .sort();
}
