/**
 * Everything the coupled dashboard hard-coded, as one object a project owns.
 *
 * The rule that decided the shape of this type: **anything that cannot be derived from an
 * OpenAPI document lives here**. A contract says a parameter is called `ean_sap`; it does not
 * say `7702001234567` is an EAN the fixtures contain. It says an operation answers 403; it does
 * not say which of your tokens is the one that falls short. It declares `POST /v1/products`; it
 * says nothing about whether you have routed it yet.
 *
 * Every field below maps to a numbered coupling point in `docs/decoupling-plan.md §1`.
 */
import type { HttpMethod, ScenarioAuth, ScenarioFlow } from "./types.ts";
import { bundles, type Locale, type TextBundle } from "./text.ts";

/** A value to try for one parameter. The object form carries the status that value is expected
 * to produce, which is how `limit=0 → 422` stops being an `if` in the generator. */
export type SampleValue = string | { value: string; expectedStatus?: number; name?: string; description?: string };

export type ScenarioTemplate = {
  id: string;
  name: string;
  description: string;
  expectedStatus: number;
  parameters?: Record<string, string>;
  body?: Record<string, unknown>;
  flow?: ScenarioFlow;
  auth?: ScenarioAuth;
};

/**
 * A case that only exists when the operation accepts a given set of query parameters.
 *
 * This one field replaces the whole `if (queryParameters.includes("lat"))` block: the six
 * geographic cases, the corrupt cursor and the `store_id + is_enabled` combination were all
 * "emit these cases when the operation has these parameters", written three different ways.
 * They keep their declared order, because the order they are emitted in is part of the golden.
 */
export type ConditionalScenario = ScenarioTemplate & { requiresParameters: string[] };

/** One row of the authorization matrix, generated against what the contract declares. */
export type AuthRule = {
  id: string;
  credential: Exclude<ScenarioAuth, "default">;
  expectedStatus: number;
  /** Emitted only when the operation matches. `declaredStatus` is the whole point: the case
   * exists because the contract promises that status, so a contract that stops promising it
   * stops generating the case. */
  when: { declaredStatus?: number; methods?: HttpMethod[] };
  /** Whether the operation's payload travels with it. A 401 on a POST is only meaningful if the
   * request is otherwise valid. */
  sendBody?: boolean;
  name?: string;
  description?: string;
};

export type BodyTemplate = {
  body?: Record<string, unknown>;
  /** A payload that collides with the resource's natural key, for a declared 409. */
  conflictBody?: Record<string, unknown>;
  /** What a PUT sends. Kept explicit rather than derived from the path, which is what the
   * coupled version did with a six-branch `updatedBody()` chain over `/products`, `/stores/`… */
  replaceBody?: Record<string, unknown>;
};

/**
 * A latency target, matched in declaration order — first hit wins.
 *
 * **No rule means no assertion.** The generator emits nothing for an operation nothing matches,
 * rather than a green tick over a threshold that was never published. That was the single most
 * important decision in the coupled `budgets.mjs` and it survives verbatim.
 */
export type BudgetRule = {
  id: string;
  methods?: HttpMethod[];
  pathEquals?: string;
  pathSuffix?: string;
  pathPrefix?: string;
  /** Regular expression source, tested against the resolved path *with* its query string. */
  queryMatches?: string;
  thresholdMs: number;
  label: string;
  source: string;
};

/** Which envelope a successful response is expected to carry, matched in declaration order. */
export type EnvelopeRule = {
  id: string;
  match: { methods?: HttpMethod[]; operationId?: string; operationIdPrefix?: string; pathSuffix?: string };
  shape: string;
};

export type OperationOverride = {
  /** Replaces the generated functional cases entirely. `/health` is the archetype: it is a GET
   * that is not a read of a resource, and inferring `found` / `not-found` for it is nonsense. */
  functional?: ScenarioTemplate[];
  /** Appended after the generated functional cases. */
  extraFunctional?: ScenarioTemplate[];
};

export type ProjectConfig = {
  locale: Locale;
  text: TextBundle;

  /** §1.4 — the values to try per parameter name. */
  parameterSamples: Record<string, SampleValue[]>;
  /** What a parameter with no samples gets. One value, so an unconfigured filter still produces
   * a case that proves the API does not reject it. */
  fallbackSamples: SampleValue[];
  /** Parameters that get no case of their own because they are only meaningful in combination —
   * `lat` without `lon` is not half a search. They are covered by `conditionalScenarios`. */
  excludeFromSoloScenarios: string[];
  /** §1.5 — the geographic cases, the corrupt cursor, the filter combinations. */
  conditionalScenarios: ConditionalScenario[];

  /** §1.8 — the value a path placeholder takes when the case wants the resource to exist. */
  pathDefaults: Record<string, string>;
  fallbackPathValue: string;
  /** The value a path placeholder takes when the case wants the resource to be missing. */
  missingIdValue: string;

  /** §1.3 — the payloads, keyed by operationId. */
  bodyTemplates: Record<string, BodyTemplate>;
  /** §1.2 — what the API actually routes today. `null` means "assume everything is routed",
   * which is the honest default for a project that has not said. */
  implemented: string[] | null;

  authRules: AuthRule[];
  /** Operations the authorization matrix does not apply to at all — a public health probe. */
  authExcludedOperationIds: string[];
  /** The scope name interpolated into the 403 case's description. */
  scopes: { default: string; byMethod?: Partial<Record<HttpMethod, string>> };

  /** How a collection endpoint is recognised, so it gets the filter matrix instead of the
   * `found` / `not-found` pair. */
  listOperations: { methods: HttpMethod[]; operationIdPrefix?: string };
  /** How a bulk write is recognised, so its case runs the `bulk-read` flow. */
  bulkOperationIdPrefix?: string;
  operationOverrides: Record<string, OperationOverride>;

  budgets: BudgetRule[];
  envelope: { rules: EnvelopeRule[]; fallbackShape: string; errorShape: string };
};

export type ProjectConfigInput = Partial<Omit<ProjectConfig, "text">> & { text?: Partial<TextBundle> };

/**
 * The defaults a project starts from: a contract, no fixtures, nothing assumed.
 *
 * Deliberately almost empty. Every list that is empty here was a hard-coded literal in the
 * coupled version, and a product that shipped Bogotá's coordinates as a default would have
 * decoupled the code and not the thinking. What *is* defaulted is only what follows from HTTP
 * and from the contract itself: the 401/403 matrix is generated from declared statuses, and the
 * envelope falls back to Problem Details for errors.
 */
export const DEFAULT_CONFIG: ProjectConfig = {
  locale: "es",
  text: bundles.es,
  parameterSamples: {},
  fallbackSamples: ["test"],
  excludeFromSoloScenarios: [],
  conditionalScenarios: [],
  pathDefaults: {},
  fallbackPathValue: "1",
  missingIdValue: "999999",
  bodyTemplates: {},
  implemented: null,
  authRules: [
    { id: "auth-none", credential: "none", expectedStatus: 401, when: { declaredStatus: 401 }, sendBody: true },
    {
      id: "auth-insufficient",
      credential: "insufficient",
      expectedStatus: 403,
      when: { declaredStatus: 403 },
      sendBody: true,
    },
  ],
  authExcludedOperationIds: [],
  scopes: { default: "lectura" },
  listOperations: { methods: ["GET"], operationIdPrefix: "list" },
  bulkOperationIdPrefix: "bulk",
  operationOverrides: {},
  budgets: [],
  envelope: { rules: [], fallbackShape: "{ data: Resource }", errorShape: "ProblemDetails" },
};

/** Fills a partial project configuration with the defaults. Shallow by design except `text`,
 * which merges key by key so a project can reword one case without restating the bundle. */
export function defineProjectConfig(input: ProjectConfigInput = {}): ProjectConfig {
  const locale = input.locale ?? DEFAULT_CONFIG.locale;
  return {
    ...DEFAULT_CONFIG,
    ...input,
    locale,
    text: { ...bundles[locale], ...(input.text ?? {}) },
  };
}

/** Normalises the string form of a sample to the object form the generators work with. */
export function toSample(value: SampleValue): Exclude<SampleValue, string> {
  return typeof value === "string" ? { value } : value;
}
