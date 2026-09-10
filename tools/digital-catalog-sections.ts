/**
 * The Digital Catalog configuration, split into the sections the API stores.
 *
 * One function, in one file, used by three things that must agree: the migration script that
 * seeds a live project, the test that proves the seeded rows reproduce the frozen matrix, and
 * anybody reading it to see what "the fixtures, as data" actually amounts to.
 *
 * It reads the fixture assembled in P0 rather than restating it. Two hand-written copies of
 * twenty payloads is two chances to diverge, and the divergence would look like an engine bug.
 */
import { bundles, type ProjectConfig } from "../packages/runner-core/src/index.ts";
import { digitalCatalogConfig } from "../packages/runner-core/test/fixtures/digital-catalog.ts";

export type SectionName =
  "parameters" | "scenarios" | "bodies" | "authorization" | "budgets" | "envelope" | "implemented" | "text";

/** Splits a full configuration into the documents the API stores, one per section. */
export function toSections(config: ProjectConfig): Record<SectionName, unknown> {
  return {
    parameters: {
      parameterSamples: config.parameterSamples,
      fallbackSamples: config.fallbackSamples,
      excludeFromSoloScenarios: config.excludeFromSoloScenarios,
      pathDefaults: config.pathDefaults,
      fallbackPathValue: config.fallbackPathValue,
      missingIdValue: config.missingIdValue,
    },
    scenarios: {
      conditionalScenarios: config.conditionalScenarios,
      operationOverrides: config.operationOverrides,
      listOperations: config.listOperations,
      bulkOperationIdPrefix: config.bulkOperationIdPrefix,
    },
    bodies: { bodyTemplates: config.bodyTemplates },
    authorization: {
      authRules: config.authRules,
      authExcludedOperationIds: config.authExcludedOperationIds,
      scopes: config.scopes,
    },
    budgets: { budgets: config.budgets },
    envelope: { envelope: config.envelope },
    implemented: { implemented: config.implemented },
    // Only the strings that actually differ from the bundle are stored. Writing all thirty back
    // would turn every future improvement to the default wording into something each project has
    // to opt into by hand.
    text: { locale: config.locale, text: overriddenText(config) },
  };
}

function overriddenText(config: ProjectConfig): Record<string, string> {
  const bundle = bundles[config.locale] as Record<string, string>;
  return Object.fromEntries(
    Object.entries(config.text as Record<string, string>).filter(([key, value]) => bundle[key] !== value),
  );
}

export const digitalCatalogSections = toSections(digitalCatalogConfig);
