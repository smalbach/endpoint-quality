import { Inject } from "@nestjs/common";
import { QueryHandler, type IQuery, type IQueryHandler } from "@nestjs/cqrs";
import { CONFIG_SECTIONS, DEFAULT_CONFIG, defineProjectConfig, bundles, type ConfigSection, type ProjectConfig } from "@eq/runner-core";

import { PROJECT_REPOSITORY, type ProjectRepositoryPort } from "@/modules/projects/domain/ports";
import { ownedProject } from "@/modules/projects/application/commands/update-project";
import { CONFIG_REPOSITORY, type ConfigRepositoryPort } from "../../domain/ports";

export class GetProjectConfigQuery implements IQuery {
  constructor(readonly organizationId: string, readonly projectId: string) {}
}

export type ProjectConfigView = {
  sections: Record<ConfigSection, { data: unknown; configured: boolean; updatedAt: Date | null }>;
};

/**
 * Assembles the stored sections into the object the engine consumes.
 *
 * **A missing section is not an error and not an empty matrix**: it falls back to
 * `DEFAULT_CONFIG`, which is almost empty on purpose. A brand-new project generates the cases
 * that follow from the contract alone — the 401/403 matrix from declared statuses, the 404 of a
 * detail GET, the create-and-read-back of a POST — and nothing that depends on knowing the
 * domain. It gets richer as somebody fills in the fixtures, and never pretends to know an EAN
 * nobody told it about.
 *
 * Exported as a function rather than living inside the handler because the scenarios query and
 * the run engine both need it, and two assemblies of the same rows would eventually disagree
 * about a default.
 */
export async function assembleProjectConfig(config: ConfigRepositoryPort, projectId: string): Promise<ProjectConfig> {
  const stored = await config.listSections(projectId);
  const merged = stored.reduce<Record<string, unknown>>((accumulator, row) => ({ ...accumulator, ...(row.data as Record<string, unknown>) }), {});
  // `defineProjectConfig` fills the gaps and merges the text bundle key by key, so a project that
  // reworded one case does not have to restate the other thirty.
  return defineProjectConfig(merged as Parameters<typeof defineProjectConfig>[0]);
}

/**
 * The configuration as an editor sees it: every section, with whether anybody has set it.
 *
 * `configured` matters more than it looks. Without it the UI cannot tell "this project uses the
 * default samples" from "somebody deliberately set the samples to the same thing as the
 * default", and the first is a prompt to fill something in while the second is a decision.
 */
@QueryHandler(GetProjectConfigQuery)
export class GetProjectConfigHandler implements IQueryHandler<GetProjectConfigQuery, ProjectConfigView> {
  constructor(
    @Inject(PROJECT_REPOSITORY) private readonly projects: ProjectRepositoryPort,
    @Inject(CONFIG_REPOSITORY) private readonly config: ConfigRepositoryPort,
  ) {}

  async execute(query: GetProjectConfigQuery): Promise<ProjectConfigView> {
    const project = await ownedProject(this.projects, query.organizationId, query.projectId);
    const stored = new Map((await this.config.listSections(project.id)).map((row) => [row.section, row]));

    const sections = Object.fromEntries(
      CONFIG_SECTIONS.map((section) => {
        const row = stored.get(section);
        return [section, { data: row?.data ?? defaultsFor(section), configured: Boolean(row), updatedAt: row?.updatedAt ?? null }];
      }),
    ) as ProjectConfigView["sections"];

    return { sections };
  }
}

/** The slice of `DEFAULT_CONFIG` a section covers, so an unset section renders as what the
 * engine will actually use rather than as a blank form. */
export function defaultsFor(section: ConfigSection): unknown {
  const defaults = DEFAULT_CONFIG;
  switch (section) {
    case "parameters":
      return {
        parameterSamples: defaults.parameterSamples,
        fallbackSamples: defaults.fallbackSamples,
        excludeFromSoloScenarios: defaults.excludeFromSoloScenarios,
        pathDefaults: defaults.pathDefaults,
        fallbackPathValue: defaults.fallbackPathValue,
        missingIdValue: defaults.missingIdValue,
      };
    case "scenarios":
      return {
        conditionalScenarios: defaults.conditionalScenarios,
        operationOverrides: defaults.operationOverrides,
        listOperations: defaults.listOperations,
        bulkOperationIdPrefix: defaults.bulkOperationIdPrefix,
      };
    case "bodies":
      return { bodyTemplates: defaults.bodyTemplates };
    case "authorization":
      return { authRules: defaults.authRules, authExcludedOperationIds: defaults.authExcludedOperationIds, scopes: defaults.scopes };
    case "budgets":
      return { budgets: defaults.budgets };
    case "envelope":
      return { envelope: defaults.envelope };
    case "implemented":
      return { implemented: defaults.implemented };
    case "text":
      // The bundle is returned whole rather than as the empty override object that is actually
      // stored: an editor needs to see the strings to change one of them.
      return { locale: defaults.locale, text: bundles[defaults.locale] };
  }
}
