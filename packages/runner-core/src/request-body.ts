/**
 * What a saved request sends as its payload, and how it becomes bytes.
 *
 * The generated matrix only ever sends JSON — it derives its payloads from JSON Schema and from
 * the project's `bodies` section, so by construction there is nothing else for it to send. A
 * request somebody wrote is not under that constraint: plenty of APIs still take a login as
 * `application/x-www-form-urlencoded`, plenty of webhooks are tested by posting the exact XML a
 * provider sends, and a `Record<string, unknown>` can express neither.
 *
 * So this is a tagged union and not four optional fields. «No payload», «this JSON», «these bytes»
 * and «these form fields» are four different things, three of them carry something the others do
 * not, and an object with a `text` and a `json` both set is a state that must not exist. The tag is
 * also what the editor draws its selector from, which is why {@link BODY_TYPES} is a runtime value:
 * a list of body types written out again in the browser is a list that can disagree.
 *
 * The switched-off form fields live in a **second map beside the first**, the same shape the
 * parameters and the headers use and for the same reason: `fields` means what is sent, everywhere,
 * and nothing downstream has to remember to filter.
 */

export const BODY_TYPES = ["none", "json", "raw", "form-data", "x-www-form-urlencoded"] as const;
export type RequestBodyType = (typeof BODY_TYPES)[number];

export type RequestBody =
  /** Not the same as an empty one. A GET with a zero-length body is a request some targets refuse,
   * and the refusal says nothing about why. */
  | { type: "none" }
  | { type: "json"; json: Record<string, unknown> }
  /** `contentType` travels with the text because raw is the case where the engine cannot guess it:
   * the same three lines could be XML, NDJSON or a CSV, and only the author knows. */
  | { type: "raw"; text: string; contentType: string }
  | { type: "form-data"; fields: Record<string, string>; disabledFields: Record<string, string> }
  | { type: "x-www-form-urlencoded"; fields: Record<string, string>; disabledFields: Record<string, string> };

/** Bytes and the content type they go out under. What every variant above eventually becomes. */
export type SerializedBody = { contentType: string; text: string };

/**
 * The multipart separator.
 *
 * Fixed rather than random, because a run has to be reproducible: a boundary from `Math.random()`
 * makes the stored request of a case differ from the same case yesterday for no reason anybody can
 * act on. It is widened — never replaced — when a value happens to contain it, which is the one
 * case where a constant would corrupt the payload instead of merely looking dull.
 */
const BOUNDARY = "----EndpointQualityFormBoundary";

function boundaryFor(values: string[]): string {
  let boundary = BOUNDARY;
  while (values.some((value) => value.includes(boundary))) boundary += "-";
  return boundary;
}

/**
 * A body as it goes on the wire, or `null` when there is none.
 *
 * Done here and not where the template is converted, because it has to happen **after** the
 * variables are substituted: `nombre={{nombre}}` serialised first and substituted second would put
 * a raw space or ampersand into a form-encoded payload, and the target would read one field where
 * two were meant. Serialising last means every value is encoded as the value it actually is.
 */
export function serializeRequestBody(body: RequestBody | undefined): SerializedBody | null {
  if (!body || body.type === "none") return null;
  if (body.type === "json") return { contentType: "application/json", text: JSON.stringify(body.json) };
  if (body.type === "raw") return { contentType: body.contentType, text: body.text };

  const entries = Object.entries(body.fields);
  if (body.type === "x-www-form-urlencoded") {
    const search = new URLSearchParams();
    for (const [name, value] of entries) search.append(name, value);
    return { contentType: "application/x-www-form-urlencoded", text: search.toString() };
  }

  // Text fields only, and deliberately: a file upload needs bytes this product never has — nothing
  // here reads the filesystem of whoever is looking at the editor — and a «file» field that could
  // only ever send text would be a promise the tool cannot keep.
  const boundary = boundaryFor(entries.map(([, value]) => value));
  const parts = entries.map(
    ([name, value]) =>
      `--${boundary}\r\nContent-Disposition: form-data; name="${escapeFieldName(name)}"\r\n\r\n${value}\r\n`,
  );
  return {
    contentType: `multipart/form-data; boundary=${boundary}`,
    text: `${parts.join("")}--${boundary}--\r\n`,
  };
}

/** RFC 6266's escaping of a quoted string, which is what a field name sits inside. A name with a
 * quote in it would otherwise end the parameter early and rename the field. */
const escapeFieldName = (name: string): string => name.replace(/\\/g, "\\\\").replace(/"/g, '\\"');

/**
 * What a step actually sends, whichever of the two ways it says it.
 *
 * `body` is the JSON payload — what the matrix generates, and the one a persistence assertion
 * compares field by field against what came back. `payload` is what a saved request describes when
 * that is not JSON. Exactly one of them is ever set, and the single place that decides which is
 * `scenarioFor`, which is already the one converter both the orchestrator and the preview go
 * through.
 */
export function payloadFor(step: { body?: Record<string, unknown>; payload?: RequestBody }): SerializedBody | null {
  if (step.payload) return serializeRequestBody(step.payload);
  return step.body === undefined ? null : { contentType: "application/json", text: JSON.stringify(step.body) };
}

/**
 * A form body written as a template, the way a `fetch` node stores it: `usuario={{user}}&nota=a+b`.
 *
 * A `fetch` node sends one string, so a form has to become text before it is stored — and doing that
 * with `URLSearchParams` percent-encodes the braces: `{{user}}` becomes `%7B%7Buser%7D%7D`, which no
 * interpolation matches, and the node is refused at run time for a variable it does have. So the
 * literal text is encoded and every `{{…}}` span is left exactly as written; {@link
 * interpolateFormBody} encodes what it turns into, at send time.
 */
export function formTemplate(fields: Record<string, string>): string {
  return Object.entries(fields)
    .map(([name, value]) => `${encodeAroundTemplates(name)}=${encodeAroundTemplates(value)}`)
    .join("&");
}

/**
 * A form template with its variables substituted and **each substituted value encoded**.
 *
 * Substituting into the whole text and encoding nothing — what every other body does — puts a raw
 * `&` or `=` from a password into the form, and the target reads one field where two were meant.
 * Encoding the whole text afterwards would encode the separators too. So the template is cut into
 * its pairs first, and only what a `{{…}}` becomes inside a `name=value` pair is encoded; the
 * literal text is sent as written (it is already encoded, see {@link formTemplate}).
 *
 * A span outside any pair —a body that is just `{{form}}`— is substituted raw: it holds the whole
 * form, separators and all, and encoding it would turn it into one field. A span that does not
 * resolve is left standing, braces and all, so `unresolvedVariables` still names it.
 */
export function interpolateFormBody(template: string, substitute: (span: string) => string): string {
  return splitOutsideTemplates(template, "&")
    .map((pair) => {
      const [name, ...rest] = splitOutsideTemplates(pair, "=");
      const encode = rest.length > 0;
      const side = (text: string) =>
        pieces(text)
          .map((piece) => {
            if (!piece.template) return piece.text;
            const value = substitute(piece.text);
            return encode && !value.includes("{{") ? encodeFormComponent(value) : value;
          })
          .join("");
      return encode ? `${side(name)}=${side(rest.join("="))}` : side(name);
    })
    .join("&");
}

/** What `URLSearchParams` writes for a value, bar the handful of marks it also encodes: `+` for a space. */
const encodeFormComponent = (text: string): string => encodeURIComponent(text).replace(/%20/g, "+");

const encodeAroundTemplates = (text: string): string =>
  pieces(text)
    .map((piece) => (piece.template ? piece.text : encodeFormComponent(piece.text)))
    .join("");

/**
 * The text cut into literal runs and `{{…}}` spans. Nested braces stay inside their span, so
 * `{{$hmacSha256:{{clave}}:texto}}` is one span and not two halves of something.
 */
function pieces(text: string): { text: string; template: boolean }[] {
  const out: { text: string; template: boolean }[] = [];
  let at = 0;
  while (at < text.length) {
    const open = text.indexOf("{{", at);
    if (open < 0) break;
    const close = closingOf(text, open);
    if (close < 0) break;
    if (open > at) out.push({ text: text.slice(at, open), template: false });
    out.push({ text: text.slice(open, close), template: true });
    at = close;
  }
  if (at < text.length) out.push({ text: text.slice(at), template: false });
  return out;
}

/** Just past the `}}` that closes the `{{` at `open`, counting the ones nested inside; -1 if none. */
function closingOf(text: string, open: number): number {
  let depth = 0;
  for (let at = open; at < text.length - 1; at++) {
    if (text.startsWith("{{", at)) {
      depth++;
      at++;
    } else if (text.startsWith("}}", at)) {
      depth--;
      at++;
      if (depth === 0) return at + 1;
    }
  }
  return -1;
}

/** `split` that leaves a separator inside a `{{…}}` span alone. */
function splitOutsideTemplates(text: string, separator: string): string[] {
  const parts: string[] = [];
  let current = "";
  for (const piece of pieces(text)) {
    if (piece.template) {
      current += piece.text;
      continue;
    }
    const cut = piece.text.split(separator);
    current += cut[0];
    for (const next of cut.slice(1)) {
      parts.push(current);
      current = next;
    }
  }
  parts.push(current);
  return parts;
}
