/**
 * The configuration, as validators.
 *
 * They live beside the types rather than in the API because a schema kept in the transport layer
 * drifts from the type it is supposed to describe, and the drift is silent: the validator accepts
 * a shape the engine cannot read, the write succeeds, and the failure shows up later as an empty
 * matrix. Here `ProjectConfigSchema` is checked against `ProjectConfig` by the compiler.
 *
 * The configuration is stored **as documents, one per section**, rather than as normalized rows
 * per sample and per budget rule. The plan sketched tables; this is a deliberate departure and
 * worth stating:
 *
 * - order is data here — the budget rules and the conditional scenarios are matched first-hit,
 *   and a `position` column is a worse way to say that than an array;
 * - a section is written as one unit, so a half-applied edit is not a state that exists;
 * - nothing queries across projects for "every rule under 50 ms", which is the only thing the
 *   normalized shape would buy.
 *
 * What it costs is that Postgres cannot enforce the shape, which is exactly why these schemas
 * exist and why every write goes through them.
 */
import { z } from "zod";
import type { ProjectConfig } from "./config.ts";
import { ROLE_PREFIX, SCENARIO_AUTH } from "./types.ts";

const httpMethod = z.enum(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]);
const jsonObject = z.record(z.string(), z.unknown());

export const sampleValueSchema = z.union([
  z.string(),
  z.object({
    value: z.string(),
    expectedStatus: z.number().int().min(100).max(599).optional(),
    name: z.string().optional(),
    description: z.string().optional(),
  }),
]);

export const scenarioFlowSchema = z.enum([
  "request",
  "create-read",
  "replace-read",
  "patch-read",
  "delete-read",
  "deleted-read",
  "bulk-read",
]);
export const scenarioAuthSchema = z.enum(SCENARIO_AUTH);

/**
 * What a case may name as the credential it presents: one of the four fixed selectors, or a role.
 *
 * The role name is checked against the same rule a variable name follows, and for the same reason:
 * it is written by hand in a configuration section, read back in a case id, and typed again in the
 * environment that supplies its credential. Three places to spell it, so the spelling has to be
 * something a person can repeat.
 */
export const scenarioCredentialSchema = z.union([
  scenarioAuthSchema,
  z
    .string()
    .regex(new RegExp(`^${ROLE_PREFIX}[A-Za-z_][A-Za-z0-9_.-]{0,39}$`), "nombre de rol inválido")
    .transform((value) => value as `${typeof ROLE_PREFIX}${string}`),
]);

export const scenarioTemplateSchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  description: z.string(),
  expectedStatus: z.number().int().min(100).max(599),
  parameters: z.record(z.string(), z.string()).optional(),
  body: jsonObject.optional(),
  flow: scenarioFlowSchema.optional(),
  auth: scenarioAuthSchema.optional(),
});

export const conditionalScenarioSchema = scenarioTemplateSchema.extend({
  requiresParameters: z.array(z.string()).min(1),
});

export const authRuleSchema = z.object({
  id: z.string().min(1),
  credential: z.enum(["none", "insufficient", "api-key"]),
  expectedStatus: z.number().int().min(100).max(599),
  when: z.object({
    declaredStatus: z.number().int().min(100).max(599).optional(),
    methods: z.array(httpMethod).optional(),
  }),
  sendBody: z.boolean().optional(),
  name: z.string().optional(),
  description: z.string().optional(),
});

export const bodyTemplateSchema = z.object({
  body: jsonObject.optional(),
  conflictBody: jsonObject.optional(),
  replaceBody: jsonObject.optional(),
});

export const budgetRuleSchema = z.object({
  id: z.string().min(1),
  methods: z.array(httpMethod).optional(),
  pathEquals: z.string().optional(),
  pathSuffix: z.string().optional(),
  pathPrefix: z.string().optional(),
  // Compiled on write rather than on every request: a rule with a broken pattern must be
  // rejected by the person who typed it, not discovered mid-run as a failed case.
  queryMatches: z.string().refine(isValidRegExp, { message: "no es una expresión regular válida" }).optional(),
  thresholdMs: z.number().int().positive(),
  label: z.string().min(1),
  source: z.string(),
});

export const envelopeRuleSchema = z.object({
  id: z.string().min(1),
  match: z.object({
    methods: z.array(httpMethod).optional(),
    operationId: z.string().optional(),
    operationIdPrefix: z.string().optional(),
    pathSuffix: z.string().optional(),
  }),
  shape: z.string().min(1),
});

export const operationOverrideSchema = z.object({
  functional: z.array(scenarioTemplateSchema).optional(),
  extraFunctional: z.array(scenarioTemplateSchema).optional(),
});

/** Lo que un endpoint dice de sus propios parámetros. Las listas del proyecto van por nombre, y
 * dos endpoints usan el mismo nombre para cosas distintas en cuanto el contrato crece. */
export const operationParametersSchema = z.object({
  parameterSamples: z.record(z.string(), z.array(sampleValueSchema)).optional(),
  pathDefaults: z.record(z.string(), z.string()).optional(),
  missingIdValue: z.string().min(1).optional(),
});

/**
 * The sections the API exposes, each writable on its own.
 *
 * Grouped by what an operator edits in one sitting rather than by the shape of the type: the
 * placeholder defaults and the missing-id value belong with the parameter samples because they
 * are all "which values do the cases use", even though they sit in different fields.
 */
/**
 * What a label may be called.
 *
 * Looser than a role or a variable — it is never substituted into anything, so it does not have to
 * survive a URL or a shell — but not free text either: it is typed into a `?labels=` on a CI
 * command line, and a label with a comma in it could never be selected there.
 */
const labelName = z
  .string()
  .regex(/^[^\s,][^,]{0,39}$/, "una etiqueta no puede llevar comas ni empezar por un espacio");

/** The same rule a variable name follows, and for the same reason: a role is written here, read
 * back inside a case id, and typed again in every environment that supplies its credential. */
const roleName = z.string().regex(/^[A-Za-z_][A-Za-z0-9_.-]{0,19}$/, "nombre de rol inválido");

/**
 * `allow` and `deny` are both listed, and neither is the complement of the other.
 *
 * A role nobody mentioned is one this project has not decided about; generating a case for it
 * would be the tool inventing a requirement. The refusal below is what stops a rule from saying
 * both things about the same role, which is a rule whose meaning depends on which list a reader
 * happens to look at first.
 */
const accessRuleSchema = z
  .object({
    operationId: z.string().min(1).max(200),
    allow: z.array(roleName).default([]),
    deny: z.array(roleName).default([]),
  })
  .superRefine((rule, context) => {
    const both = rule.allow.filter((role) => rule.deny.includes(role));
    if (both.length) {
      context.addIssue({
        code: "custom",
        message: `«${both.join(", ")}» está a la vez en allow y en deny`,
        path: ["deny"],
      });
    }
    if (!rule.allow.length && !rule.deny.length) {
      context.addIssue({ code: "custom", message: "la regla no dice nada de ningún rol", path: ["allow"] });
    }
  });

const crossRoleRuleSchema = z
  .object({
    source: roleName,
    target: roleName,
    createOperationId: z.string().min(1).max(200),
    operationId: z.string().min(1).max(200),
    allowed: z.boolean(),
  })
  .superRefine((rule, context) => {
    // A role reaching its own resource is not a cross-role case, it is the `allow` row of the
    // matrix above — and written here it would assert the opposite of what it looks like.
    if (rule.source === rule.target) {
      context.addIssue({ code: "custom", message: "origen y destino son el mismo rol", path: ["target"] });
    }
  });

export const configSections = {
  parameters: z.object({
    parameterSamples: z.record(z.string(), z.array(sampleValueSchema)),
    // Con valor por defecto y no obligatorio: la sección se escribe entera en cada `PUT`, y
    // exigirlo rompería a todo el que ya tenía una guardada sin esto — que son todos.
    operationParameters: z.record(z.string(), operationParametersSchema).default({}),
    fallbackSamples: z.array(sampleValueSchema),
    excludeFromSoloScenarios: z.array(z.string()),
    pathDefaults: z.record(z.string(), z.string()),
    fallbackPathValue: z.string().min(1),
    missingIdValue: z.string().min(1),
  }),
  scenarios: z.object({
    conditionalScenarios: z.array(conditionalScenarioSchema),
    operationOverrides: z.record(z.string(), operationOverrideSchema),
    listOperations: z.object({ methods: z.array(httpMethod).min(1), operationIdPrefix: z.string().optional() }),
    bulkOperationIdPrefix: z.string().optional(),
  }),
  bodies: z.object({ bodyTemplates: z.record(z.string(), bodyTemplateSchema) }),
  access: z.object({
    access: z.object({
      /** Declared here and not read off an environment's credentials: «esta API tiene estos roles»
       * is true of the project, «este token es el del vendedor» is true of one environment. */
      roles: z.array(roleName),
      // At least one, because a rule that denies nothing asserts nothing. Capped at the codes an
      // HTTP refusal can actually be: accepting 200 here would let a project write a matrix that
      // passes by definition.
      deniedStatuses: z.array(z.number().int().min(400).max(499)).min(1).max(4).default([403, 404]),
      rules: z.array(accessRuleSchema).default([]),
      crossRole: z.array(crossRoleRuleSchema).default([]),
    }),
  }),
  authorization: z.object({
    authRules: z.array(authRuleSchema),
    authExcludedOperationIds: z.array(z.string()),
    // `partialRecord` and not `record`: over an enum key, zod requires **every** member to be
    // present, so a map that only names DELETE would be rejected for the six methods it
    // deliberately does not mention. The type is `Partial<Record<HttpMethod, string>>`.
    scopes: z.object({ default: z.string(), byMethod: z.partialRecord(httpMethod, z.string()).optional() }),
  }),
  budgets: z.object({ budgets: z.array(budgetRuleSchema) }),
  envelope: z.object({
    envelope: z.object({
      rules: z.array(envelopeRuleSchema),
      fallbackShape: z.string().min(1),
      errorShape: z.string().min(1),
    }),
  }),
  implemented: z.object({ implemented: z.array(z.string()).nullable() }),
  /** Its own section and not a field inside another, because labelling the operations is a thing
   * somebody sits down and does — which is what every section here is grouped by. */
  labels: z.object({
    labels: z.record(z.string().min(1).max(200), z.array(labelName).max(20)).default({}),
  }),
  text: z.object({ locale: z.enum(["es", "en"]), text: z.record(z.string(), z.string()) }),
} as const;

export type ConfigSection = keyof typeof configSections;
export const CONFIG_SECTIONS = Object.keys(configSections) as ConfigSection[];

export function isConfigSection(value: string): value is ConfigSection {
  return value in configSections;
}

/** Validates one section's document. The caller reports the issues; this returns them. */
export function parseSection<S extends ConfigSection>(section: S, data: unknown): z.infer<(typeof configSections)[S]> {
  return configSections[section].parse(data) as z.infer<(typeof configSections)[S]>;
}

export function safeParseSection(
  section: ConfigSection,
  data: unknown,
): { ok: true } | { ok: false; issues: { field: string; detail: string }[] } {
  const result = configSections[section].safeParse(data);
  if (result.success) return { ok: true };
  return {
    ok: false,
    issues: result.error.issues.map((issue) => ({
      field: issue.path.length ? issue.path.join(".") : section,
      detail: issue.message,
    })),
  };
}

function isValidRegExp(source: string): boolean {
  try {
    new RegExp(source);
    return true;
  } catch {
    return false;
  }
}

/**
 * A compile-time check that the sections together cover `ProjectConfig`.
 *
 * Without it, adding a field to the type and forgetting a section leaves the engine reading a
 * default nobody chose — and a run that quietly asserts the wrong thing is worse than one that
 * fails. This line makes that a build error.
 */
type SectionUnion = { [S in ConfigSection]: z.infer<(typeof configSections)[S]> }[ConfigSection];
type CoveredKeys = SectionUnion extends infer U ? (U extends unknown ? keyof U : never) : never;
type UncoveredKeys = Exclude<keyof ProjectConfig, CoveredKeys>;
const _allSectionsCovered: UncoveredKeys extends never ? true : ["falta cubrir en configSections:", UncoveredKeys] =
  true;
void _allSectionsCovered;
