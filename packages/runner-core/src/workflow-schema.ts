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

import { scenarioAuthSchema } from "./schema.ts";
import type { WorkflowStep } from "./workflows.ts";
import { VARIABLE_NAME } from "./variables.ts";
import { CHECK_OPERATORS, CHECK_SOURCES } from "./checks.ts";
import { CAPTURE_SOURCES, STEP_ON_ERROR, STEP_WAITS, concurrentPairs } from "./workflows.ts";

const jsonValue: z.ZodType<unknown> = z.lazy(() =>
  z.union([z.string(), z.number(), z.boolean(), z.null(), z.array(jsonValue), z.record(z.string(), jsonValue)]),
);
const jsonObject = z.record(z.string(), jsonValue);

/** RFC 9110's token, and a value with no control character in it. */
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
  auth: scenarioAuthSchema.optional(),
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
    source: z.enum(CHECK_SOURCES),
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

export const workflowStepSchema = z.object({
  // Capped because it travels inside `run_cases.scenarioId`, which is a `varchar(200)`.
  id: z.string().min(1).max(60),
  requestTemplateId: z.string().uuid(),
  dependsOn: z.array(z.string()).optional(),
  waits: z.enum(STEP_WAITS).optional(),
  captures: z.array(workflowCaptureSchema).optional(),
  waitMs: z.number().int().min(0).max(60_000).optional(),
  runIf: z.object({ from: z.string().min(1).max(60), check: stepCheckSchema }).optional(),
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
    const concurrent = concurrentPairs(document.steps as WorkflowStep[]);
    for (const [left, right] of concurrent) {
      const shared = (left.captures ?? [])
        .map((capture) => capture.variable)
        .filter((name) => (right.captures ?? []).some((capture) => capture.variable === name));
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
