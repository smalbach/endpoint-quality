/**
 * A Postman collection as flows of this project.
 *
 * The other importers read a collection for its *requests* — a list of saved requests, or a list of
 * endpoints. This one reads it for what the requests are wired into: a folder of a collection is
 * almost always a scenario somebody wrote in order — log in, create it, read it back, delete it —
 * and that order, with the `{{ids}}` passed from one step to the next, is the part nobody can
 * retype. It is also the part Postman can only express as scripts.
 *
 * So the mapping is deliberate and narrow:
 *
 * - **A top-level folder becomes a flow**, and the requests at the root of the collection become
 *   one more. It is the only grouping the format offers, and grouping by anything else would be
 *   this importer deciding what somebody's scenario is.
 * - **The order becomes the edges.** Postman's runner walks a folder top to bottom, so each node
 *   depends on the one before it. A chain and not a fan: two requests with no edge between them
 *   would be free to run at the same time, which is not what the collection did.
 * - **A `prerequest` script becomes a `script` node before the request**, and a `test` script
 *   becomes checks and captures on the request when {@link translatePostmanScript} can read it, or
 *   a `script` node after it when it cannot. Either way what the script asserted still runs.
 * - **A request the active contract declares becomes a `request` node** over a saved request of
 *   this project, which is what keeps drift detectable. One it does not declare becomes a `fetch`
 *   node with the call written out — the node that exists for exactly this: the call the contract
 *   does not describe. Nothing here invents an operation.
 *
 * Pure. Which request template a node names and whether a flow is created or updated are the
 * command's business, because both span rows.
 */
import type { PostmanItem } from "./import-requests";
import { translatePostmanScript } from "./postman-scripts";
import {
  FETCH_METHODS,
  type FetchMethod,
  type RequestBody,
  type StepCheck,
  type StepFetch,
  type WorkflowCapture,
  type WorkflowDocument,
  type WorkflowStep,
} from "@eq/runner-core";

/** The requests of one prospective flow, in the order the collection listed them. */
export type PostmanFlow = { name: string; items: PostmanItem[] };

/**
 * The flows a collection describes: one per top-level folder, plus one for what sits at the root.
 *
 * The root one is named after the collection and comes first, because a collection whose requests
 * are all at the root is the common small case and «la colección» is what its flow is.
 */
export function flowsOf(collection: { name: string; items: PostmanItem[] }): PostmanFlow[] {
  const flows: PostmanFlow[] = [];
  const byFolder = new Map<string, PostmanItem[]>();

  for (const item of collection.items) {
    const folder = item.trail[0] ?? "";
    const list = byFolder.get(folder);
    if (list) list.push(item);
    else byFolder.set(folder, [item]);
  }

  const root = byFolder.get("");
  if (root) flows.push({ name: collection.name.trim() || "Colección importada", items: root });
  for (const [folder, items] of byFolder) {
    if (folder) flows.push({ name: folder.trim(), items });
  }
  return flows;
}

/** What a node sends: a saved request of this project, or a call written on the node. */
export type StepSource = { kind: "request"; requestTemplateId: string } | { kind: "fetch"; fetch: StepFetch };

/** One item, read: the node it becomes and everything its scripts turned into. */
export type PostmanStepDraft = {
  /** What the flow calls the node. */
  label: string;
  source: StepSource;
  checks: StepCheck[];
  captures: WorkflowCapture[];
  /** The `prerequest` code, verbatim, or empty. */
  prerequest: string;
  /** The `test` code, verbatim, when it could not be read as checks. Empty when it could. */
  test: string;
};

/**
 * The two scripts of an item, read.
 *
 * `expectedStatus` is pulled **out** of the checks when the test asserted one: the status is what a
 * case's primary assertion already is, in this product and in every report it writes, so leaving it
 * as a check as well would name the same claim twice and — worse — let the node's own expectation
 * disagree with it.
 */
export function readItemScripts(item: PostmanItem): {
  checks: StepCheck[];
  captures: WorkflowCapture[];
  expectedStatus: number | null;
  /** The `test` code to keep verbatim, or empty when it was fully translated. */
  test: string;
  /** Why the script was kept, for the report. Null when there was nothing to keep. */
  reason: string | null;
} {
  const translated = translatePostmanScript(item.test);
  if (translated.untranslatable !== null) {
    return { checks: [], captures: [], expectedStatus: null, test: item.test, reason: translated.untranslatable };
  }
  const status = translated.checks.find(
    (check) => check.source === "status" && check.operator === "equals" && typeof check.value === "number",
  );
  return {
    checks: translated.checks.filter((check) => check !== status),
    captures: translated.captures,
    expectedStatus: status ? (status.value as number) : null,
    test: "",
    reason: null,
  };
}

/** How far apart the nodes sit on the canvas. One column, because the flow is one chain. */
const COLUMN_X = 40;
const ROW_HEIGHT = 170;

/**
 * The graph of a flow: the chain of nodes, with their edges, checks, captures and positions.
 *
 * Each node depends on the previous one, whatever kind it is — so a `test` script that writes a
 * variable is *between* the request that produced it and the request that spends it, which is where
 * Postman ran it and the only place the dependency is real.
 */
export function definitionFrom(steps: PostmanStepDraft[]): WorkflowDocument {
  const nodes: WorkflowStep[] = [];
  const taken = new Set<string>();
  let previous: string | null = null;

  for (const draft of steps) {
    const id = freeId(draft.label, taken);

    if (draft.prerequest.trim()) {
      const preId = freeId(`${id}-antes`, taken);
      nodes.push({
        id: preId,
        kind: "script",
        script: { code: clipScript(draft.prerequest) },
        ...(previous ? { dependsOn: [previous] } : {}),
        position: { x: COLUMN_X, y: 40 + nodes.length * ROW_HEIGHT },
      });
      previous = preId;
    }

    nodes.push({
      id,
      ...(draft.source.kind === "request"
        ? { requestTemplateId: draft.source.requestTemplateId }
        : { kind: "fetch" as const, fetch: draft.source.fetch }),
      ...(previous ? { dependsOn: [previous] } : {}),
      ...(draft.checks.length ? { checks: draft.checks } : {}),
      ...(draft.captures.length ? { captures: draft.captures } : {}),
      position: { x: COLUMN_X, y: 40 + nodes.length * ROW_HEIGHT },
    });
    previous = id;

    if (draft.test.trim()) {
      const testId = freeId(`${id}-test`, taken);
      nodes.push({
        id: testId,
        kind: "script",
        // `from` is the request, so the script reads its answer as `pm.response` — the same name
        // Postman gave it, which is what lets the code run unchanged.
        script: { code: clipScript(draft.test), from: id },
        dependsOn: [id],
        position: { x: COLUMN_X, y: 40 + nodes.length * ROW_HEIGHT },
      });
      previous = testId;
    }
  }

  return { steps: nodes };
}

/** The schema's ceiling on a script node. A script longer than this is cut rather than refused:
 * what is dropped is the tail of somebody's code, and the node says so in its last line. */
const MAX_SCRIPT = 20_000;
const CUT = "\n// … el script original se cortó al importarlo: superaba los 20.000 caracteres.";

const clipScript = (code: string): string =>
  code.length <= MAX_SCRIPT ? code : `${code.slice(0, MAX_SCRIPT - CUT.length)}${CUT}`;

/**
 * A node id from the request's name: `Crear pedido` becomes `crear-pedido`.
 *
 * The name and not a UUID, because the id *is* what the report calls the step — it travels in
 * `run_cases.scenarioId` — and «falló crear-pedido» is a sentence, while «falló 3f2a…» is a lookup.
 * Capped at 40 so the suffixes below still fit the column's 60.
 */
export function freeId(name: string, taken: Set<string>): string {
  const base =
    name
      .toLowerCase()
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "paso";
  if (!taken.has(base)) {
    taken.add(base);
    return base;
  }
  for (let suffix = 2; ; suffix += 1) {
    const candidate = `${base}-${suffix}`;
    if (!taken.has(candidate)) {
      taken.add(candidate);
      return candidate;
    }
  }
}

// -----------------------------------------------------------------------------------------------
// The call a fetch node writes out
// -----------------------------------------------------------------------------------------------

/**
 * Headers the transport or the executor owns, which describe the copy rather than the request.
 *
 * Shorter than the list the saved-request importer drops, and deliberately: a fetch node *is* the
 * request written out, so its `Content-Type` is the author's to set — the executor only infers one
 * when the node does not carry it.
 */
const TRANSPORT_HEADER =
  /^(content-length|accept-encoding|connection|host|origin|referer|user-agent|sec-.*|upgrade-insecure-requests|pragma|cache-control|postman-token)$/i;

/** The headers that carry a credential. Kept only when the value is nothing but variable
 * references: `Bearer {{token}}` names where the secret is, and `Bearer eyJhb…` *is* one. */
const CREDENTIAL_HEADER = /^(authorization|cookie|proxy-authorization|x-api-key|api-key|apikey)$/i;
const ONLY_VARIABLES = /^(?:[A-Za-z][\w-]*\s+)?(?:\{\{\s*[A-Za-z_][A-Za-z0-9_.-]*\s*\}\}\s*)+$/;

/** A header name a fetch node's schema accepts. A collection with a mistyped one loses the header
 * rather than the whole import. */
const HEADER_NAME = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/;

export type FetchCall = {
  fetch: StepFetch;
  /** Whether a credential header was dropped. */ droppedCredential: boolean;
};

/**
 * The item as a call written on a node, or the reason it cannot be one.
 *
 * A multipart body is the only real refusal: a `fetch` node sends one string, and there is no
 * honest way to write a file upload as one. It comes back as a reason so the request is named in
 * the report instead of quietly missing from the flow.
 */
export function fetchCallFrom(item: PostmanItem, expectedStatus: number | null): FetchCall | string {
  const method = item.request.method.toUpperCase();
  if (!(FETCH_METHODS as readonly string[]).includes(method)) return `el método ${method} no se puede enviar`;
  const url = item.request.url.trim();
  if (!url || /[\r\n]/.test(url)) return "la URL no se puede leer";
  if (url.length > 2000) return "la URL es demasiado larga";

  const body = fetchBody(item.request.body);
  if (typeof body === "string") return body;

  const headers: Record<string, string> = {};
  let droppedCredential = false;
  for (const [name, value] of Object.entries(item.request.headers)) {
    const clean = name.trim();
    if (!HEADER_NAME.test(clean) || TRANSPORT_HEADER.test(clean)) continue;
    if (/[\r\n]/.test(value)) continue;
    if (CREDENTIAL_HEADER.test(clean) && !ONLY_VARIABLES.test(value)) {
      droppedCredential = true;
      continue;
    }
    headers[clean] = value;
  }
  if (body?.contentType && !Object.keys(headers).some((name) => name.toLowerCase() === "content-type")) {
    headers["Content-Type"] = body.contentType;
  }

  return {
    fetch: {
      method: method as FetchMethod,
      url,
      ...(Object.keys(headers).length ? { headers } : {}),
      ...(body?.text ? { body: body.text } : {}),
      ...(expectedStatus !== null ? { expectedStatus } : {}),
      // The credential was dropped, so the run's own session is what this call presents — which is
      // the only way it can still reach an endpoint behind a login.
      ...(droppedCredential ? { useSession: true } : {}),
      // Cómo entra, leído del bloque `auth` del fichero y ya heredado por el lector. `inherit` no
      // se guarda: es lo que hace la llamada sin bloque, y escribirlo solo engorda el documento.
      ...(item.request.auth.type !== "inherit" ? { auth: item.request.auth } : {}),
    },
    droppedCredential,
  };
}

/** The payload as the one string a fetch node sends, or the reason it cannot be written as one. */
function fetchBody(body: RequestBody): { text: string; contentType: string } | null | string {
  switch (body.type) {
    case "none":
      return null;
    case "json":
      return { text: JSON.stringify(body.json, null, 2), contentType: "application/json" };
    case "raw":
      return { text: body.text, contentType: body.contentType || "text/plain" };
    case "x-www-form-urlencoded":
      return {
        text: new URLSearchParams(Object.entries(body.fields)).toString(),
        contentType: "application/x-www-form-urlencoded",
      };
    default:
      return "un cuerpo multipart no cabe en un nodo fetch: impórtalo como endpoint";
  }
}
