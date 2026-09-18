/**
 * What the API accepts as a flow and as a reusable request.
 *
 * Separate from `schema.ts` because these are **not** configuration sections: they are rows, and
 * the section registry there carries a compile-time proof that its entries together cover
 * `ProjectConfig`. Putting a validator for a table in that object would make the proof false.
 *
 * What Postgres cannot enforce, this does: acyclicity, and that every edge names a step that
 * exists. The other half of the integrity — that a step names a request template of *this*
 * project — spans two tables and belongs to the command handler.
 */
import { z } from "zod";

import { AUTH_TYPES } from "./auth.ts";

import { scenarioCredentialSchema } from "./schema.ts";
import type { WorkflowStep } from "./workflows.ts";
import { VARIABLE_NAME } from "./variables.ts";
import { GRAPHQL_OPERATION_NAME, graphqlVariablesProblem } from "./graphql.ts";
import { CHECK_OPERATORS, RESPONSE_CHECK_SOURCES } from "./checks.ts";
import { stepNotifySchema } from "./notify.ts";
import { mockBodyProblem } from "./mock.ts";
import {
  CAPTURE_SOURCES,
  FETCH_METHODS,
  STEP_ON_ERROR,
  STEP_WAITS,
  concurrentPairs,
  loopBody,
  rerunPath,
} from "./workflows.ts";

const jsonValue: z.ZodType<unknown> = z.lazy(() =>
  z.union([z.string(), z.number(), z.boolean(), z.null(), z.array(jsonValue), z.record(z.string(), jsonValue)]),
);
const jsonObject = z.record(z.string(), jsonValue);

/** RFC 9110's token, and a value with no control character in it. */
/**
 * La autenticación de una llamada escrita a mano.
 *
 * Un tope por parámetro porque esto vive en el documento del flujo, que es un `jsonb`: el payload
 * de un JWT es lo más largo que cabe aquí legítimamente.
 */
const authSchema = z.object({
  type: z.enum(AUTH_TYPES),
  params: z.record(z.string().max(200), z.string().max(4_000)).default({}),
});

const headerName = z
  .string()
  .regex(/^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/, "nombre de cabecera inválido")
  .max(120);
const headerValue = z
  .string()
  .regex(/^[^\r\n]*$/, "una cabecera no puede llevar un salto de línea")
  .max(4000);

/**
 * The payload of a saved request, as the five things it can be.
 *
 * A discriminated union and not an object with everything optional, so the 422 names the variant:
 * «raw necesita contentType» is a message somebody can act on, and «body inválido» over a union of
 * five shapes is not.
 *
 * The ceilings are the editor's, not the storage's. A raw body is something a person typed or
 * pasted; a megabyte of it is a fixture that belongs in a dataset, and letting it into a `jsonb`
 * column means every list of requests carries it.
 */
const formFields = z.record(z.string().min(1).max(200), z.string().max(100_000));
export const requestBodySchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("none") }),
  z.object({ type: z.literal("json"), json: jsonObject }),
  z.object({
    type: z.literal("raw"),
    text: z.string().max(1_000_000),
    // A media type and nothing else: it goes straight into a header, so the same line-break rule
    // that protects the others protects this one.
    contentType: z
      .string()
      .min(1)
      .max(200)
      .regex(/^[^\r\n]+$/, "el content-type no puede llevar un salto de línea"),
  }),
  z.object({ type: z.literal("form-data"), fields: formFields, disabledFields: formFields }),
  z.object({ type: z.literal("x-www-form-urlencoded"), fields: formFields, disabledFields: formFields }),
]);

export const requestTemplateBodySchema = z.object({
  name: z.string().min(1).max(120),
  operationId: z.string().min(1).max(200),
  description: z.string().max(500).optional(),
  expectedStatus: z.number().int().min(100).max(599),
  parameters: z.record(z.string(), z.string()).optional(),
  disabledParameters: z.record(z.string(), z.string()).optional(),
  /**
   * Header names as HTTP defines them, and values without a line break in them.
   *
   * The pattern is not decoration: a newline inside a header value is request splitting, and the
   * value here comes from a text field that a `{{variable}}` can also be substituted into. Refused
   * on write rather than escaped on send, because a header somebody cannot save is a message they
   * can act on and a header quietly rewritten at 3am is not.
   */
  headers: z.record(headerName, headerValue).optional(),
  disabledHeaders: z.record(headerName, headerValue).optional(),
  body: requestBodySchema.optional(),
  auth: scenarioCredentialSchema.optional(),
});

export const workflowCaptureSchema = z
  .object({
    variable: z.string().regex(VARIABLE_NAME, "nombre de variable inválido"),
    from: z.enum(CAPTURE_SOURCES),
    path: z.string().min(1).max(500),
  })
  .superRefine((capture, context) => {
    if (capture.from !== "regex") return;
    try {
      new RegExp(capture.path);
    } catch {
      // Caught at write time. A bad pattern discovered mid-run comes back as «no se encontró», and
      // whoever reads that report has no reason to suspect the pattern rather than the target.
      context.addIssue({ code: "custom", message: "la expresión regular no es válida", path: ["path"] });
    }
  });

/** Which operators judge the value on its own, and so take no right-hand side. */
const WITHOUT_OPERAND = ["exists", "not_exists", "is_array", "is_not_empty"];

export const stepCheckSchema = z
  .object({
    label: z.string().max(120).optional(),
    source: z.enum(RESPONSE_CHECK_SOURCES),
    path: z.string().max(500).optional(),
    operator: z.enum(CHECK_OPERATORS),
    value: jsonValue.optional(),
    severity: z.enum(["error", "warning"]).optional(),
  })
  .superRefine((check, context) => {
    // A header check with no name is not a check. A body one without a path is: it judges the
    // whole body, which is what `is_not_empty` over a list endpoint means.
    if (check.source === "header" && !check.path?.trim()) {
      context.addIssue({ code: "custom", message: "una comprobación de cabecera necesita su nombre", path: ["path"] });
    }
    if (!WITHOUT_OPERAND.includes(check.operator) && check.value === undefined) {
      context.addIssue({
        code: "custom",
        message: `el operador ${check.operator} necesita un valor con el que comparar`,
        path: ["value"],
      });
    }
    if (check.operator === "matches") {
      try {
        new RegExp(String(check.value));
      } catch {
        // Caught at write time rather than mid-run: a bad regex would otherwise fail one step of
        // one case, reported as if the target had done something.
        context.addIssue({ code: "custom", message: "la expresión regular no es válida", path: ["value"] });
      }
    }
  });

/** Capped low on purpose: `attempts` multiplies the wall clock of every run that contains the
 * step, and a flow that needs twenty tries is reporting something other than a flaky network. */
export const stepRetrySchema = z.object({
  attempts: z.number().int().min(0).max(5),
  delayMs: z.number().int().min(0).max(30_000),
  backoff: z.number().min(1).max(10).optional(),
  onStatus: z.array(z.number().int().min(100).max(599)).max(20).optional(),
});

export const stepConditionSchema = z.object({ from: z.string().min(1).max(60), check: stepCheckSchema });

/**
 * Why a schema written on a node cannot be used, or null.
 *
 * It has to be a JSON object, and it may not use `pattern`: the validator compiles that with
 * `RegExp` inside the API process, and one backtracking expression would stall every run on the
 * worker — not only the author's. A property *named* `pattern` is fine; only the keyword is refused.
 */
function customSchemaProblem(json: string | undefined): string | null {
  if (!json?.trim()) return "un esquema propio necesita su JSON Schema";
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return "el esquema propio no es JSON válido";
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    return "el esquema propio tiene que ser un objeto JSON";
  const usesPattern = (node: unknown): boolean =>
    Array.isArray(node)
      ? node.some(usesPattern)
      : Boolean(node) &&
        typeof node === "object" &&
        Object.entries(node as Record<string, unknown>).some(
          ([key, value]) => (key === "pattern" && typeof value === "string") || usesPattern(value),
        );
  return usesPattern(parsed) ? "un esquema propio no puede usar «pattern»" : null;
}

/** The kinds a retry node can watch: the ones that fail on their own. */
const RETRY_WATCHES: string[] = ["request", "login", "fetch", "graphql", "validate", "schema", "script"];

export const workflowStepSchema = z.object({
  // Capped because it travels inside `run_cases.scenarioId`, which is a `varchar(200)`.
  id: z.string().min(1).max(60),
  // A control node (branch/wait/merge/validate) sends nothing, so it carries no template; a
  // `request` and a `login` node must (checked below).
  requestTemplateId: z.string().uuid().optional(),
  kind: z
    .enum([
      "request",
      "login",
      "branch",
      "wait",
      "merge",
      "validate",
      "fetch",
      "set",
      "script",
      "poll",
      "retry",
      "loop",
      "schema",
      "notify",
      "subflow",
      "graphql",
      "mock",
    ])
    .optional(),
  // The `mock` node: the response it answers with, no network. Same ceilings as a fetch's call.
  mock: z
    .object({
      status: z.number().int().min(100).max(599),
      headers: z.record(headerName, headerValue).optional(),
      disabledHeaders: z.record(headerName, headerValue).optional(),
      body: z.string().max(1_000_000).optional(),
      delayMs: z.number().int().min(0).max(60_000).optional(),
    })
    .optional(),
  // The `notify` node: channel, the NAME of the variable holding the webhook URL, and the message.
  notify: stepNotifySchema.optional(),
  // The `schema` node: the step whose body it validates, against the contract or a schema of its own.
  schema: z
    .object({
      from: z.string().min(1).max(60),
      source: z.enum(["contract", "custom"]),
      json: z.string().max(200_000).optional(),
      strict: z.boolean().optional(),
    })
    .optional(),
  // The `subflow` node: another flow of this project, what goes into it and what comes back. Whether
  // that flow exists, is not archived and closes no cycle spans rows — the command handler checks it.
  subflow: z
    .object({
      workflowId: z.string().uuid("elige el flujo que ejecuta"),
      inputs: z
        .array(
          z.object({
            variable: z.string().regex(VARIABLE_NAME, "nombre de variable inválido"),
            value: z.string().max(10_000),
          }),
        )
        .max(50)
        .optional(),
      outputs: z.array(z.string().regex(VARIABLE_NAME, "nombre de variable inválido")).max(50).optional(),
    })
    .optional(),
  // The `graphql` node: one operation, sent the way a fetch sends its call. The variables are checked
  // as the JSON object they must become with every `{{template}}` standing in for a value — the
  // values themselves only exist at run time, where the engine parses the substituted text again.
  graphql: z
    .object({
      url: z
        .string()
        .min(1, "un nodo GraphQL necesita una URL")
        .max(2000)
        .regex(/^[^\r\n]*$/, "la URL no puede llevar un salto de línea"),
      query: z
        .string()
        .max(200_000)
        .refine((query) => query.trim().length > 0, "un nodo GraphQL necesita su query"),
      variables: z
        .string()
        .max(1_000_000)
        .optional()
        .superRefine((text, context) => {
          const problem = graphqlVariablesProblem(text);
          if (problem) context.addIssue({ code: "custom", message: problem });
        }),
      operationName: z
        .string()
        .max(200)
        .regex(GRAPHQL_OPERATION_NAME, "operationName no es un nombre GraphQL válido")
        .optional(),
      headers: z.record(headerName, headerValue).optional(),
      disabledHeaders: z.record(headerName, headerValue).optional(),
      expectedStatus: z.number().int().min(100).max(599).optional(),
      useSession: z.boolean().optional(),
      allowErrors: z.boolean().optional(),
      auth: authSchema.optional(),
    })
    .optional(),
  // The `loop` node: the list it walks. Same ceilings as a `forEach`, for the same reason.
  loop: z
    .object({
      from: z.string().min(1).max(60),
      path: z.string().min(1).max(500),
      as: z.string().regex(VARIABLE_NAME, "nombre de variable inválido"),
      max: z.number().int().min(1).max(200).optional(),
    })
    .optional(),
  // A node on a loop's «cada» output.
  inLoop: z.string().min(1).max(60).optional(),
  // The `poll` node: the step whose request it repeats. Capped low for the same reason a retry is:
  // attempts times the delay is wall clock every run containing it pays.
  poll: z
    .object({
      from: z.string().min(1).max(60),
      attempts: z.number().int().min(1).max(20),
      delayMs: z.number().int().min(0).max(60_000),
    })
    .optional(),
  // The `retry` node: the step it watches, where it walks the flow again from, how often. Capped for
  // the same reason as a poll: every walk is requests the target sees and time the run pays.
  rerun: z
    .object({
      from: z.string().min(1).max(60),
      target: z.string().min(1).max(60),
      attempts: z.number().int().min(1).max(10),
      delayMs: z.number().int().min(0).max(60_000),
    })
    .optional(),
  // The `set` node: variables written from templates, no request.
  set: z
    .object({
      assignments: z
        .array(
          z.object({
            variable: z.string().regex(VARIABLE_NAME, "nombre de variable inválido"),
            value: z.string().max(10_000),
          }),
        )
        .min(1, "un nodo set necesita al menos una variable")
        .max(50),
    })
    .optional(),
  // The `script` node: code for the isolated sandbox, and the step whose response it reads.
  script: z.object({ code: z.string().max(20_000), from: z.string().min(1).max(60).optional() }).optional(),
  // Cómo entra la llamada. Los secretos van como `{{variables}}`: esto es una columna `jsonb`.
  // The `fetch` node: a call written out by hand instead of a saved request.
  fetch: z
    .object({
      method: z.enum(FETCH_METHODS),
      url: z
        .string()
        .min(1, "un fetch necesita una URL")
        .max(2000)
        .regex(/^[^\r\n]*$/, "la URL no puede llevar un salto de línea"),
      headers: z.record(headerName, headerValue).optional(),
      disabledHeaders: z.record(headerName, headerValue).optional(),
      body: z.string().max(1_000_000).optional(),
      expectedStatus: z.number().int().min(100).max(599).optional(),
      useSession: z.boolean().optional(),
      auth: authSchema.optional(),
    })
    .optional(),
  // The `If`: the step it reads and the check that decides «sí» from «no».
  condition: stepConditionSchema.optional(),
  // The `validate` node: the step whose response it judges, and an optional sandbox script.
  validate: z.object({ from: z.string().min(1).max(60), script: z.string().max(20_000).optional() }).optional(),
  // Which side of an `If` this node hangs off.
  branch: z.object({ of: z.string().min(1).max(60), take: z.enum(["then", "else"]) }).optional(),
  dependsOn: z.array(z.string()).optional(),
  waits: z.enum(STEP_WAITS).optional(),
  captures: z.array(workflowCaptureSchema).optional(),
  waitMs: z.number().int().min(0).max(60_000).optional(),
  runIf: stepConditionSchema.optional(),
  forEach: z
    .object({
      from: z.string().min(1).max(60),
      path: z.string().min(1).max(500),
      as: z.string().regex(VARIABLE_NAME, "nombre de variable inválido"),
      // Capped in the schema and not only at run time: the list comes from the target, so the
      // ceiling has to be something the target cannot move.
      max: z.number().int().min(1).max(200).optional(),
    })
    .optional(),
  authorizes: z
    .object({
      from: z.enum(CAPTURE_SOURCES),
      path: z.string().min(1).max(500),
      header: z.string().max(80).optional(),
      scheme: z.string().max(40).optional(),
    })
    .optional(),
  checks: z.array(stepCheckSchema).max(50).optional(),
  retry: stepRetrySchema.optional(),
  onError: z.enum(STEP_ON_ERROR).optional(),
  position: z.object({ x: z.number().finite(), y: z.number().finite() }).optional(),
});

/**
 * The rows of a dataset.
 *
 * Text only, and the keys have to be variable names, because that is exactly what a row becomes:
 * `{{dataset.sku}}` substituted into a path or a body. A column called `total price` could never be
 * spent, so accepting it would only postpone the discovery to the middle of a run.
 *
 * The ceilings are the run's, not the storage's. Five hundred rows of a nine-step flow is four and
 * a half thousand cases; a dataset that wants more is asking for something a test suite is not.
 */
export const datasetRowsSchema = z
  .array(z.record(z.string().regex(VARIABLE_NAME, "nombre de columna inválido"), z.string().max(10_000)))
  .max(500);

export const workflowDocumentSchema = z
  .object({ steps: z.array(workflowStepSchema) })
  .superRefine((document, context) => {
    // Everything below the cycle check reads the graph as if its edges resolved. When one of them
    // does not, they do not, and an analysis run over it invents conflicts on top of the one real
    // problem.
    let broken = false;
    const ids = new Set(document.steps.map((step) => step.id));
    if (ids.size !== document.steps.length) {
      context.addIssue({ code: "custom", message: "los ids de los pasos deben ser únicos", path: ["steps"] });
      broken = true;
    }
    for (const [index, step] of document.steps.entries()) {
      for (const dependency of step.dependsOn ?? []) {
        if (dependency === step.id) {
          context.addIssue({
            code: "custom",
            message: "un paso no puede depender de sí mismo",
            path: ["steps", index, "dependsOn"],
          });
          broken = true;
        } else if (!ids.has(dependency)) {
          context.addIssue({
            code: "custom",
            message: `el paso depende de un id inexistente: ${dependency}`,
            path: ["steps", index, "dependsOn"],
          });
          broken = true;
        }
      }

      // A condition or a loop reads the answer of another step, so that step has to have answered.
      // The dependency is what guarantees it: without the edge the order is not defined, and the
      // read would come back empty in a way that looks like a false condition or an empty list.
      for (const [field, reference] of [
        ["runIf", step.runIf?.from],
        ["forEach", step.forEach?.from],
        ["condition", step.condition?.from],
        ["validate", step.validate?.from],
        ["script", step.script?.from],
        ["poll", step.poll?.from],
        ["rerun", step.rerun?.from],
        ["loop", step.loop?.from],
        ["schema", step.schema?.from],
      ] as const) {
        if (!reference) continue;
        if (!ids.has(reference)) {
          context.addIssue({
            code: "custom",
            message: `${field} apunta a un paso inexistente: ${reference}`,
            path: ["steps", index, field, "from"],
          });
        } else if (!(step.dependsOn ?? []).includes(reference)) {
          context.addIssue({
            code: "custom",
            message: `${field} solo puede leer un paso del que este depende`,
            path: ["steps", index, field, "from"],
          });
        }
      }

      // A node is a `request` unless it says otherwise. Each kind carries its own fields, and
      // mixing them is a document that means two things at once — a request with no call, or a
      // branch that also fires one. `request` and `login` make an HTTP call; the four control
      // kinds (branch/wait/merge/validate) send nothing and must not carry a template. A `fetch`
      // sends a call too, but one written on the node itself, so it carries no template either.
      const kind = step.kind ?? "request";
      const sendsRequest = kind === "request" || kind === "login";
      if (kind === "fetch" && !step.fetch) {
        context.addIssue({
          code: "custom",
          message: "un nodo fetch necesita su método y su URL",
          path: ["steps", index, "fetch"],
        });
      }
      if (step.fetch && kind !== "fetch") {
        context.addIssue({
          code: "custom",
          message: "solo un nodo fetch lleva su bloque fetch",
          path: ["steps", index, "fetch"],
        });
      }
      if (sendsRequest && !step.requestTemplateId) {
        context.addIssue({
          code: "custom",
          message:
            kind === "login" ? "un nodo de login necesita una petición" : "un paso de petición necesita una petición",
          path: ["steps", index, "requestTemplateId"],
        });
        broken = true;
      }
      if (!sendsRequest && step.requestTemplateId) {
        context.addIssue({
          code: "custom",
          message:
            kind === "fetch" || kind === "graphql"
              ? `un nodo ${kind} lleva su petición escrita, no una guardada`
              : "un nodo de control no envía ninguna petición",
          path: ["steps", index, "requestTemplateId"],
        });
      }
      // Only the `If` carries a condition; only a `validate` carries its `validate` block.
      if (step.condition && kind !== "branch") {
        context.addIssue({
          code: "custom",
          message: "solo un nodo de bifurcación lleva condición",
          path: ["steps", index, "condition"],
        });
      }
      if (step.validate && kind !== "validate") {
        context.addIssue({
          code: "custom",
          message: "solo un nodo de validación lleva su bloque de validación",
          path: ["steps", index, "validate"],
        });
      }
      if (kind === "login" && !step.authorizes) {
        context.addIssue({
          code: "custom",
          message: "un nodo de login necesita decir de dónde sale la credencial",
          path: ["steps", index, "authorizes"],
        });
        broken = true;
      }
      if (kind === "branch" && !step.condition) {
        context.addIssue({
          code: "custom",
          message: "un nodo de bifurcación necesita una condición",
          path: ["steps", index, "condition"],
        });
        broken = true;
      }
      if (step.set && kind !== "set") {
        context.addIssue({
          code: "custom",
          message: "solo un nodo set lleva variables que asignar",
          path: ["steps", index, "set"],
        });
      }
      if (kind === "set" && !step.set) {
        context.addIssue({
          code: "custom",
          message: "un nodo set necesita al menos una variable",
          path: ["steps", index, "set"],
        });
      }
      if (step.notify && kind !== "notify") {
        context.addIssue({
          code: "custom",
          message: "solo un nodo notificar lleva su bloque notify",
          path: ["steps", index, "notify"],
        });
      }
      if (kind === "notify" && !step.notify) {
        context.addIssue({
          code: "custom",
          message: "un nodo notificar necesita canal, variable con la URL y mensaje",
          path: ["steps", index, "notify"],
        });
      }
      if (step.script && kind !== "script") {
        context.addIssue({
          code: "custom",
          message: "solo un nodo script lleva código",
          path: ["steps", index, "script"],
        });
      }
      if (kind === "script" && !step.script?.code.trim()) {
        // An empty script asserts nothing and writes nothing: a green case that proves nothing ran.
        context.addIssue({
          code: "custom",
          message: "un nodo script necesita código",
          path: ["steps", index, "script", "code"],
        });
      }
      if (step.loop && kind !== "loop") {
        context.addIssue({
          code: "custom",
          message: "solo un nodo bucle lleva su lista",
          path: ["steps", index, "loop"],
        });
      }
      if (kind === "loop" && !step.loop) {
        context.addIssue({
          code: "custom",
          message: "un bucle necesita la lista que recorre",
          path: ["steps", index, "loop"],
        });
        broken = true;
      }
      if (step.inLoop) {
        const owner = document.steps.find((other) => other.id === step.inLoop);
        if (owner?.kind !== "loop" || !(step.dependsOn ?? []).includes(step.inLoop)) {
          context.addIssue({
            code: "custom",
            message: "un nodo dentro de un bucle tiene que depender de ese bucle",
            path: ["steps", index, "inLoop"],
          });
          broken = true;
        }
      }
      if (step.schema && kind !== "schema") {
        context.addIssue({
          code: "custom",
          message: "solo un nodo esquema lleva su bloque schema",
          path: ["steps", index, "schema"],
        });
      }
      if (kind === "schema") {
        if (!step.schema) {
          context.addIssue({
            code: "custom",
            message: "un nodo esquema necesita el paso que valida",
            path: ["steps", index, "schema"],
          });
          broken = true;
        } else if (step.schema.source === "contract") {
          // The contract is looked up by operation, and only a saved request has one.
          const source = document.steps.find((other) => other.id === step.schema!.from);
          const sourceKind = source?.kind ?? "request";
          if (source && sourceKind !== "request" && sourceKind !== "login") {
            context.addIssue({
              code: "custom",
              message:
                "el esquema del contrato solo se conoce para una petición guardada o un login; usa un esquema propio",
              path: ["steps", index, "schema", "source"],
            });
          }
        } else {
          const problem = customSchemaProblem(step.schema.json);
          if (problem) context.addIssue({ code: "custom", message: problem, path: ["steps", index, "schema", "json"] });
        }
      }
      if (step.subflow && kind !== "subflow") {
        context.addIssue({
          code: "custom",
          message: "solo un nodo sub-flujo lleva su bloque subflow",
          path: ["steps", index, "subflow"],
        });
      }
      if (kind === "subflow") {
        if (!step.subflow) {
          context.addIssue({
            code: "custom",
            message: "un sub-flujo necesita el flujo que ejecuta",
            path: ["steps", index, "subflow"],
          });
          broken = true;
        }
        // Its child's cases are reserved once, when the run is prepared; a forEach would need them
        // once per element of a list nobody knows yet.
        if (step.forEach) {
          context.addIssue({
            code: "custom",
            message: "un sub-flujo no recorre una lista",
            path: ["steps", index, "forEach"],
          });
        }
      }
      if (step.graphql && kind !== "graphql") {
        context.addIssue({
          code: "custom",
          message: "solo un nodo GraphQL lleva su bloque graphql",
          path: ["steps", index, "graphql"],
        });
      }
      if (kind === "graphql" && !step.graphql) {
        context.addIssue({
          code: "custom",
          message: "un nodo GraphQL necesita su URL y su query",
          path: ["steps", index, "graphql"],
        });
      }
      if (step.mock && kind !== "mock") {
        context.addIssue({
          code: "custom",
          message: "solo un nodo mock lleva una respuesta simulada",
          path: ["steps", index, "mock"],
        });
      }
      if (kind === "mock") {
        if (!step.mock) {
          context.addIssue({
            code: "custom",
            message: "un nodo mock necesita la respuesta que da",
            path: ["steps", index, "mock"],
          });
        } else {
          const problem = mockBodyProblem(step.mock);
          if (problem) context.addIssue({ code: "custom", message: problem, path: ["steps", index, "mock", "body"] });
        }
        // It answers the same every time and logs nobody in: a retry, a list walk or a session read
        // from it would be a claim about a service that was never called.
        for (const field of ["retry", "forEach", "authorizes"] as const) {
          if (step[field]) {
            context.addIssue({
              code: "custom",
              message: "un mock no admite reintentos, forEach ni login: su respuesta está escrita",
              path: ["steps", index, field],
            });
          }
        }
      }
      if (step.poll && kind !== "poll") {
        context.addIssue({
          code: "custom",
          message: "solo un nodo reintento lleva su bloque poll",
          path: ["steps", index, "poll"],
        });
      }
      if (kind === "poll") {
        if (!step.poll) {
          context.addIssue({
            code: "custom",
            message: "un reintento necesita el paso que repite",
            path: ["steps", index, "poll"],
          });
          broken = true;
        } else {
          // What it repeats has to be one request it can send again as it is. A login would hand the
          // run a new session per attempt, and a loop has no single request to repeat.
          const source = document.steps.find((other) => other.id === step.poll!.from);
          const sourceKind = source?.kind ?? "request";
          if (source && ((sourceKind !== "request" && sourceKind !== "fetch") || source.forEach || source.authorizes)) {
            context.addIssue({
              code: "custom",
              message: "un reintento solo repite una petición o un fetch, sin bucle ni login",
              path: ["steps", index, "poll", "from"],
            });
          }
        }
        if (!step.checks?.length) {
          // Without a check nothing says when to stop: the first answer would always be the last.
          context.addIssue({
            code: "custom",
            message: "un reintento necesita al menos una comprobación que diga cuándo parar",
            path: ["steps", index, "checks"],
          });
        }
      }
      if (step.rerun && kind !== "retry") {
        context.addIssue({
          code: "custom",
          message: "solo un nodo reintento lleva su bloque rerun",
          path: ["steps", index, "rerun"],
        });
      }
      if (kind === "retry") {
        if (!step.rerun) {
          context.addIssue({
            code: "custom",
            message: "un reintento necesita el paso que vigila y desde dónde repetir",
            path: ["steps", index, "rerun"],
          });
          broken = true;
        } else {
          const { from, target } = step.rerun;
          const source = document.steps.find((other) => other.id === from);
          // What it watches has to be able to fail on its own: a wait or a merge never does, and a
          // loop, a subflow or another retry already decide their own repetition.
          if (source && !RETRY_WATCHES.includes(source.kind ?? "request")) {
            context.addIssue({
              code: "custom",
              message:
                "un reintento solo vigila una petición, un login, un fetch, GraphQL, una validación, un esquema o un script",
              path: ["steps", index, "rerun", "from"],
            });
          }
          if (!ids.has(target)) {
            context.addIssue({
              code: "custom",
              message: `rerun apunta a un paso inexistente: ${target}`,
              path: ["steps", index, "rerun", "target"],
            });
            broken = true;
          }
          // Its input is the step it watches and nothing else: a second edge in would make it wait
          // for something that has no say in whether it runs.
          if ((step.dependsOn ?? []).some((id) => id !== from)) {
            context.addIssue({
              code: "custom",
              message: "un reintento solo se conecta al paso que vigila",
              path: ["steps", index, "dependsOn"],
            });
          }
          if (
            document.steps.some((other) => other.id !== step.id && other.kind === "retry" && other.rerun?.from === from)
          ) {
            context.addIssue({
              code: "custom",
              message: `ya hay otro reintento vigilando «${from}»`,
              path: ["steps", index, "rerun", "from"],
            });
          }
        }
        for (const field of ["retry", "forEach", "runIf", "authorizes"] as const) {
          if (step[field]) {
            context.addIssue({
              code: "custom",
              message: "un reintento no admite reintentos propios, forEach, condición ni login",
              path: ["steps", index, field],
            });
          }
        }
      }
      if (kind === "wait" && !step.waitMs) {
        context.addIssue({
          code: "custom",
          message: "un nodo de espera necesita un tiempo en milisegundos",
          path: ["steps", index, "waitMs"],
        });
      }
      if (kind === "validate") {
        if (!step.validate) {
          context.addIssue({
            code: "custom",
            message: "un nodo de validación necesita el paso que lee",
            path: ["steps", index, "validate"],
          });
          broken = true;
        } else if (!step.checks?.length && !step.validate.script?.trim()) {
          // A validate that neither checks nor runs a script asserts nothing: it would report a
          // green case that proves the response existed and no more.
          context.addIssue({
            code: "custom",
            message: "una validación necesita al menos una comprobación o un script",
            path: ["steps", index, "checks"],
          });
        }
      }

      // A node that hangs off a branch has to name a real branch it depends on: the «sí»/«no» is
      // read from that node's verdict, so without the edge there is nothing to read.
      if (step.branch) {
        const owner = document.steps.find((other) => other.id === step.branch!.of);
        if (!owner) {
          context.addIssue({
            code: "custom",
            message: `la rama apunta a un paso inexistente: ${step.branch.of}`,
            path: ["steps", index, "branch", "of"],
          });
        } else if ((owner.kind ?? "request") !== "branch") {
          context.addIssue({
            code: "custom",
            message: "una rama solo puede colgar de un nodo de bifurcación",
            path: ["steps", index, "branch", "of"],
          });
        } else if (!(step.dependsOn ?? []).includes(step.branch.of)) {
          context.addIssue({
            code: "custom",
            message: "un nodo en una rama debe depender de su bifurcación",
            path: ["steps", index, "branch", "of"],
          });
        }
      }
    }

    // Kahn's algorithm, run for its verdict and not its order: a cycle is a flow that can never
    // start, and finding it here is the difference between a 422 and a run that hangs.
    const pending = new Set(document.steps.map((step) => step.id));
    while (pending.size) {
      const ready = document.steps.filter(
        (step) => pending.has(step.id) && (step.dependsOn ?? []).every((id) => !pending.has(id)),
      );
      if (!ready.length) {
        context.addIssue({ code: "custom", message: "el flujo contiene dependencias cíclicas", path: ["steps"] });
        // Everything below reads the graph as if it were ordered, and it is not. Reporting a
        // hundred invented conflicts on top of the one real problem helps nobody.
        return;
      }
      ready.forEach((step) => pending.delete(step.id));
    }

    /**
     * The two rules that make running steps at the same time safe, checked where the flow is
     * written rather than where it is run.
     *
     * A run's variables are one map. Two steps with no path between them have no order, so what
     * they write into it races — and the day somebody raises the concurrency on the run panel, a
     * flow that was saved years earlier becomes wrong without being edited. That is why this is
     * refused on the way in and not gated on a number chosen later.
     */
    if (broken) return;

    /**
     * What a retry walks again has to be walkable again as it is: the stretch from `target` down to
     * the watched step, with no loop, subflow, poll or other retry in it — those reserve case slots or
     * repeat on their own — and no `forEach`. Nor may any of it, or the retry, sit inside a loop's
     * body, which the loop walks by itself.
     */
    const loopMembers = new Set(
      document.steps
        .filter((step) => step.kind === "loop")
        .flatMap((loop) => loopBody(document.steps as WorkflowStep[], loop.id)),
    );
    for (const [index, node] of document.steps.entries()) {
      if (node.kind !== "retry" || !node.rerun) continue;
      if (loopMembers.has(node.id)) {
        context.addIssue({
          code: "custom",
          message: "un reintento no puede ir dentro de un bucle",
          path: ["steps", index, "kind"],
        });
      }
      const path = rerunPath(document.steps as WorkflowStep[], node.rerun.target, node.rerun.from);
      if (!path) {
        context.addIssue({
          code: "custom",
          message: "un reintento solo repite desde el paso que vigila o desde uno anterior a él",
          path: ["steps", index, "rerun", "target"],
        });
        continue;
      }
      for (const id of path) {
        const step = document.steps.find((other) => other.id === id)!;
        if (
          ["loop", "subflow", "poll", "retry"].includes(step.kind ?? "request") ||
          step.forEach ||
          loopMembers.has(id)
        ) {
          context.addIssue({
            code: "custom",
            message: `«${id}» no se puede repetir desde un reintento: bucles, sub-flujos, sondeos, forEach y lo que va dentro de un bucle no se vuelven a recorrer`,
            path: ["steps", index, "rerun", "target"],
          });
        }
      }
    }

    /**
     * A loop walks its body in order, once per element, starting when the loop starts. So what a
     * body step waits for has to be the loop, another body step, or something that finished before
     * the loop began — anything else has no answer yet on the first iteration. A loop inside a loop,
     * or a body step with a `forEach` of its own, would multiply case slots nobody reserved.
     */
    for (const loop of document.steps.filter((step) => step.kind === "loop")) {
      const body = new Set(loopBody(document.steps as WorkflowStep[], loop.id));
      const before = new Set<string>();
      const walk = [...(loop.dependsOn ?? [])];
      while (walk.length) {
        const id = walk.pop()!;
        if (before.has(id)) continue;
        before.add(id);
        walk.push(...(document.steps.find((step) => step.id === id)?.dependsOn ?? []));
      }
      for (const [index, step] of document.steps.entries()) {
        if (!body.has(step.id)) continue;
        if (step.kind === "loop") {
          context.addIssue({
            code: "custom",
            message: `«${step.id}» está dentro del bucle «${loop.id}»: no se pueden anidar bucles`,
            path: ["steps", index, "kind"],
          });
        }
        if (step.forEach) {
          context.addIssue({
            code: "custom",
            message: `«${step.id}» está dentro del bucle «${loop.id}» y no puede recorrer su propia lista`,
            path: ["steps", index, "forEach"],
          });
        }
        if (step.kind === "subflow") {
          context.addIssue({
            code: "custom",
            message: `«${step.id}» está dentro del bucle «${loop.id}»: un sub-flujo no puede ir dentro de un bucle`,
            path: ["steps", index, "kind"],
          });
        }
        for (const dependency of step.dependsOn ?? []) {
          if (dependency === loop.id || body.has(dependency) || before.has(dependency)) continue;
          context.addIssue({
            code: "custom",
            message: `«${step.id}» está dentro del bucle «${loop.id}» y depende de «${dependency}», que no ha terminado cuando el bucle empieza`,
            path: ["steps", index, "dependsOn"],
          });
        }
      }
    }

    const concurrent = concurrentPairs(document.steps as WorkflowStep[]);
    for (const [left, right] of concurrent) {
      // A set node writes into the same map a capture does, so its names race the same way.
      const writtenBy = (step: (typeof document.steps)[number]) => [
        ...(step.captures ?? []).map((capture) => capture.variable),
        ...(step.set?.assignments ?? []).map((assignment) => assignment.variable),
        ...(step.subflow?.outputs ?? []),
      ];
      const rightWrites = writtenBy(right);
      const shared = [...new Set(writtenBy(left).filter((name) => rightWrites.includes(name)))];
      if (shared.length) {
        context.addIssue({
          code: "custom",
          message: `«${left.id}» y «${right.id}» pueden ejecutarse a la vez y los dos capturan ${shared.join(", ")}`,
          path: ["steps", document.steps.indexOf(right), "captures"],
        });
      }
      // A session is one credential for the whole run, so the step that obtains it is a barrier:
      // anything that could run beside it might send its request with the old credential or the
      // new one, and which of the two would depend on the scheduler.
      for (const [barrier, other] of [
        [left, right],
        [right, left],
      ] as const) {
        if (!barrier.authorizes) continue;
        context.addIssue({
          code: "custom",
          message: `«${barrier.id}» inicia sesión y «${other.id}» puede ejecutarse a la vez: haz que uno dependa del otro`,
          path: ["steps", document.steps.indexOf(barrier), "authorizes"],
        });
      }
    }
  });

export type ParsedWorkflowDocument = z.infer<typeof workflowDocumentSchema>;
export type ParsedRequestTemplate = z.infer<typeof requestTemplateBodySchema>;

type ParseResult = { ok: true } | { ok: false; issues: { field: string; detail: string }[] };

const report = (result: z.ZodSafeParseResult<unknown>, fallback: string): ParseResult =>
  result.success
    ? { ok: true }
    : {
        ok: false,
        issues: result.error.issues.map((issue) => ({
          field: issue.path.length ? issue.path.join(".") : fallback,
          detail: issue.message,
        })),
      };

/** Same shape as `safeParseSection`, so the caller reports issues the one way this API reports them. */
export const safeParseWorkflowDocument = (data: unknown): ParseResult =>
  report(workflowDocumentSchema.safeParse(data), "definition");

export const safeParseRequestTemplate = (data: unknown): ParseResult =>
  report(requestTemplateBodySchema.safeParse(data), "requestTemplate");

export const safeParseDatasetRows = (data: unknown): ParseResult => report(datasetRowsSchema.safeParse(data), "rows");

/**
 * The body on its own, for the one caller that has a body and no template around it.
 *
 * «Enviar» sends what is on the form, saved or not, so there is no row to validate — and without
 * this the union would reach the serialiser unchecked, where a `type` nobody declared is a 500
 * about a request somebody typed. The rule is the same object either way, so the two cannot
 * disagree about what a payload may be.
 */
export const safeParseRequestBody = (data: unknown): ParseResult => report(requestBodySchema.safeParse(data), "body");
