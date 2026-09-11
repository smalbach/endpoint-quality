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
