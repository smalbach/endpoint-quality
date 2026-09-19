import { z } from "zod";
import {
  AUTH_TYPES,
  VARIABLE_NAME,
  isConfigSection,
  safeParseDatasetRows,
  safeParseRequestTemplate,
  safeParseSection,
  safeParseWorkflowDocument,
} from "@eq/runner-core";
import { importSpec } from "@eq/spec-import";
import type { ProjectBundlePart } from "@eq/contracts";

import {
  BODY_MODES,
  ENDPOINT_METHODS,
  ENDPOINT_STATUSES,
  PARAMETER_TYPES,
  endpointProblems,
  type EndpointInput,
} from "@/modules/endpoints/domain/model";
import {
  MAX_EXAMPLES_PER_ENDPOINT,
  MAX_EXAMPLE_BODY,
  MAX_EXAMPLE_NAME,
} from "@/modules/endpoints/domain/examples";
import { DATA_SCOPES, roleProblems } from "@/modules/roles/domain/model";
import { CHANNEL_PROTOCOLS, channelProblems, type ChannelCeilings, type ChannelInput } from "@/modules/channels/domain/model";
import { protoFilesProblems } from "@/modules/channels/domain/grpc";
import { WORKFLOW_STATUSES } from "@/modules/workflows/domain/model";
import { safeParsePlanDefinition } from "@/modules/performance/domain/plan-schema";
import { projectSettingsProblems } from "./model";
import { NO_AUTH } from "./project-auth";

/**
 * A project as a file: what somebody downloads to keep, to hand to another installation, or to
 * bring one flow from a laptop to the team's instance.
 *
 * The copy between projects already exists, but it only reaches projects of the same organization
 * on the same server. A file reaches everything else — and it is also a backup somebody can read.
 *
 * The rules are the copy's rules, because the dangers are the same ones:
 *
 * - **No secret travels.** A sensitive variable leaves as its name with an empty value, credentials
 *   and the project's login secrets are not in the file at all. A file is copied, mailed and
 *   committed; a token inside it is a token in all of those places.
 * - **Ids in the file are references, not ids.** A flow names its requests, its sub-flows and its
 *   channels by the ids they had where they were exported; importing makes new ones and rewrites every reference,
 *   so nothing lands pointing at rows of another project.
 * - **Everything is validated before anything is written.** The file is untrusted input from a
 *   disk, so each piece goes through the same validator its own editor uses — and a file with one
 *   broken flow is refused whole rather than imported by halves.
 */
export const BUNDLE_FORMAT = "endpoint-quality/project";
export const BUNDLE_VERSION = 1;

export const BUNDLE_PARTS = [
  "settings",
  "contract",
  "config",
  "endpoints",
  "roles",
  "flows",
  "environments",
  "performance",
] as const satisfies readonly ProjectBundlePart[];

export const isBundlePart = (value: string): value is ProjectBundlePart =>
  (BUNDLE_PARTS as readonly string[]).includes(value);

type Problem = { field: string; detail: string };

const ref = z.string().min(1).max(100);
const name = z.string().trim().min(1).max(120);
const stringMap = z.record(z.string().max(200), z.string().max(100_000));

/** Una lista de cabeceras, con la misma forma en el endpoint y en sus ejemplos. */
const bundleHeaders = z
  .array(z.object({ name: z.string().max(200), value: z.string().max(10_000), enabled: z.boolean().default(true) }))
  .max(100)
  .default([]);

const bundleEndpoint = z.object({
  method: z.enum(ENDPOINT_METHODS),
  path: z.string().min(1).max(2000),
  description: z.string().max(5000).default(""),
  pathParameters: z
    .array(
      z.object({
        name: z.string().max(100),
        type: z.enum(PARAMETER_TYPES),
        description: z.string().max(2000).default(""),
        value: z.string().max(10_000).default(""),
      }),
    )
    .max(50)
    .default([]),
  query: z
    .array(
      z.object({
        name: z.string().max(200),
        type: z.enum(PARAMETER_TYPES),
        required: z.boolean().default(false),
        description: z.string().max(2000).default(""),
        value: z.string().max(10_000).default(""),
        enabled: z.boolean().default(true),
      }),
    )
    .max(100)
    .default([]),
  headers: z
    .array(z.object({ name: z.string().max(200), value: z.string().max(10_000), enabled: z.boolean().default(true) }))
    .max(100)
    .default([]),
  body: z
    .object({
      mode: z.enum(BODY_MODES),
      text: z.string().max(1_000_000).default(""),
      contentType: z.string().max(200).default("text/plain"),
      fields: z
        .array(
          z.object({
            name: z.string().max(200),
            value: z.string().max(100_000),
            kind: z.enum(["text", "file"]),
            enabled: z.boolean().default(true),
          }),
        )
        .max(100)
        .default([]),
      // Las variables de una operación GraphQL. Sin esta línea el esquema las tiraba al leer el
      // fichero, y el endpoint volvía con la operación y sin sus variables.
      variables: z.string().max(1_000_000).optional(),
    })
    .default({ mode: "none", text: "", contentType: "text/plain", fields: [] }),
  requiresAuth: z.boolean().default(false),
  // Los secretos de un `auth` nunca son literales, así que el bundle los lleva tal cual: lo que
  // hay dentro es un `{{variable}}` o está vacío, y el entorno es quien cifra el valor.
  auth: z
    .object({
      type: z.enum(AUTH_TYPES),
      params: z.record(z.string().max(200), z.string().max(4_000)).default({}),
    })
    .default({ type: "inherit", params: {} }),
  tags: z.array(z.string()).default([]),
  status: z.enum(ENDPOINT_STATUSES).default("active"),
  operationId: z.string().max(200).nullable().default(null),
  preRequestScript: z.string().default(""),
  postResponseScript: z.string().default(""),
  /**
   * Los ejemplos guardados: el par petición/respuesta que este endpoint contestó una vez.
   *
   * Van dentro del endpoint y no en una lista suya arriba porque no significan nada sueltos, y
   * porque así la ida y la vuelta no tiene que emparejarlos por id — un bundle es un fichero que se
   * edita a mano, y un id que apunta a nada es el error que nadie ve al escribirlo.
   *
   * Lo que hay aquí **ya pasó por la redacción**: no lleva credenciales, y por eso el bundle puede
   * llevarlo entero cuando la variable sensible sale vacía.
   */
  examples: z
    .array(
      z.object({
        name: z.string().min(1).max(MAX_EXAMPLE_NAME),
        request: z.object({
          method: z.string().max(10),
          url: z.string().max(4000),
          headers: bundleHeaders,
          body: z.object({ text: z.string().max(MAX_EXAMPLE_BODY), contentType: z.string().max(200) }),
        }),
        response: z.object({
          status: z.number().int().min(100).max(599),
          headers: bundleHeaders,
          body: z.string().max(MAX_EXAMPLE_BODY),
          contentType: z.string().max(200),
          durationMs: z.number().min(0).default(0),
        }),
      }),
    )
    .max(MAX_EXAMPLES_PER_ENDPOINT)
    .default([]),
});

const bundleRole = z.object({
  name: z.string().trim().min(1).max(20),
  description: z.string().max(500).default(""),
  color: z.string().optional(),
  sameRoleDataIsolation: z.boolean().default(false),
  permissions: z
    .array(
      z.object({
        method: z.enum(ENDPOINT_METHODS),
        path: z.string().min(1).max(2000),
        access: z.enum(["allow", "deny"]),
        dataScope: z.enum(DATA_SCOPES).default("all"),
      }),
    )
    .max(10_000)
    .default([]),
});

const bundleRoleRule = z.object({
  source: z.string().min(1).max(20),
  target: z.string().min(1).max(20),
  canRead: z.boolean().default(false),
  canWrite: z.boolean().default(false),
  canDelete: z.boolean().default(false),
});

const bundleTemplate = z.object({
  id: ref,
  name,
  operationId: z.string().min(1).max(200),
  /** Where the operation pointed when exported, to make the file readable. The import resolves by
   * `operationId` against the target's contract, never by these. */
  method: z.string().max(10).optional(),
  path: z.string().max(2000).optional(),
  description: z.string().max(500).nullable().default(null),
  expectedStatus: z.number().int().min(100).max(599),
  parameters: stringMap.default({}),
  disabledParameters: stringMap.default({}),
  headers: stringMap.default({}),
  disabledHeaders: stringMap.default({}),
  body: z.unknown().optional(),
  auth: z.unknown().optional(),
});

const bundleWorkflow = z.object({
  id: ref,
  name,
  description: z.string().max(2000).nullable().default(null),
  status: z.enum(WORKFLOW_STATUSES).default("draft"),
  definition: z.looseObject({ steps: z.array(z.record(z.string(), z.unknown())).max(500) }),
});

const bundleDataset = z.object({ workflowId: ref, name, rows: z.unknown() });

/**
 * A channel a flow's `channel` node runs. It travels with the flows because a node without its
 * channel cannot run — and it travels as it is stored: headers and auth already without literals,
 * the `.proto` files of a gRPC one included. The shape of each setting is the channel editor's job,
 * so it is checked by `channelProblems`, not restated here.
 */
const bundleChannel = z.object({
  id: ref,
  protocol: z.enum(CHANNEL_PROTOCOLS).default("ws"),
  name,
  url: z.string().min(1).max(2000),
  subprotocols: z.array(z.string()).optional(),
  headers: z.array(z.object({ name: z.string(), value: z.string(), enabled: z.boolean().default(true) })).optional(),
  auth: z.unknown().optional(),
  limits: z.record(z.string(), z.number()).optional(),
  expectations: z.unknown().optional(),
  messages: z.array(z.unknown()).optional(),
  mqtt: z.unknown().optional(),
  grpc: z.unknown().optional(),
  socketio: z.unknown().optional(),
  protos: z.array(z.object({ path: z.string(), content: z.string() })).default([]),
});
export type BundleChannel = z.infer<typeof bundleChannel>;

/** What the channel editor would receive for a bundle channel: the same input, the same checks. */
export const channelInputOf = (channel: BundleChannel): ChannelInput & { name: string; url: string } =>
  ({
    protocol: channel.protocol,
    name: channel.name,
    url: channel.url,
    ...(channel.subprotocols !== undefined ? { subprotocols: channel.subprotocols } : {}),
    ...(channel.headers !== undefined ? { headers: channel.headers } : {}),
    ...(channel.auth !== undefined ? { auth: channel.auth } : {}),
    ...(channel.limits !== undefined ? { limits: channel.limits } : {}),
    ...(channel.expectations !== undefined ? { expectations: channel.expectations } : {}),
    ...(channel.messages !== undefined ? { messages: channel.messages } : {}),
    ...(channel.mqtt ? { mqtt: channel.mqtt } : {}),
    ...(channel.grpc ? { grpc: channel.grpc } : {}),
    ...(channel.socketio ? { socketio: channel.socketio } : {}),
  }) as ChannelInput & { name: string; url: string };

const bundleSuite = z.object({
  name,
  description: z.string().max(2000).nullable().default(null),
  workflowIds: z.array(ref).max(500).default([]),
});

const bundleVariables = z
  .record(
    z.string().regex(VARIABLE_NAME, "nombre de variable inválido"),
    z.object({
      initial: z.string().max(100_000).default(""),
      current: z.string().max(100_000).optional(),
      sensitive: z.boolean().default(false),
    }),
  )
  .default({});

const bundleEnvironment = z.object({
  name,
  baseUrl: z.string().max(2000),
  specUrl: z.string().max(2000).nullable().default(null),
  variables: bundleVariables,
  disabledVariables: bundleVariables,
});

export const projectBundleSchema = z.object({
  format: z.literal(BUNDLE_FORMAT, "no es un fichero exportado de endpoint-quality"),
  version: z.number().int().min(1).max(BUNDLE_VERSION, "lo exportó una versión más nueva; actualiza antes de importarlo"),
  exportedAt: z.string().max(40).optional(),
  project: z.object({ name: z.string().max(200) }).optional(),
  settings: z
    .object({
      description: z.string().max(2000).optional(),
      baseUrl: z.string().max(2000).optional(),
      tags: z.array(z.string().max(40)).max(30).optional(),
    })
    .optional(),
  /** The active OpenAPI document. Flows' requests take their method and path from it by operation id,
   * so a flow without the contract it was written against imports and cannot run. */
  contract: z
    .object({
      raw: z.string().min(1).max(8_000_000),
      title: z.string().max(500).optional(),
      version: z.string().max(200).optional(),
    })
    .optional(),
  config: z
    .array(z.object({ section: z.string().max(40), data: z.unknown() }))
    .max(20)
    .optional(),
  endpoints: z.array(bundleEndpoint).max(5000).optional(),
  roles: z.array(bundleRole).max(200).optional(),
  roleRules: z.array(bundleRoleRule).max(5000).optional(),
  flows: z
    .object({
      requestTemplates: z.array(bundleTemplate).max(2000).default([]),
      workflows: z.array(bundleWorkflow).max(500).default([]),
      datasets: z.array(bundleDataset).max(1000).default([]),
      suites: z.array(bundleSuite).max(200).default([]),
      channels: z.array(bundleChannel).max(200).default([]),
    })
    .optional(),
  environments: z.array(bundleEnvironment).max(200).optional(),
  performance: z
    .array(z.object({ name, description: z.string().max(2000).nullable().default(null), definition: z.unknown() }))
    .max(500)
    .optional(),
});

/** The file after its shape was checked. What each piece *means* is {@link bundleProblems}' job. */
export type ProjectBundle = z.infer<typeof projectBundleSchema>;
export type FlowDefinition = z.infer<typeof bundleWorkflow>["definition"];

export function parseProjectBundle(data: unknown): { ok: true; bundle: ProjectBundle } | { ok: false; issues: Problem[] } {
  const result = projectBundleSchema.safeParse(data);
  if (result.success) return { ok: true, bundle: result.data };
  return {
    ok: false,
    issues: result.error.issues.slice(0, 50).map((issue) => ({
      field: issue.path.length ? issue.path.map(String).join(".") : "bundle",
      detail: issue.message,
    })),
  };
}

/** The parts a file actually carries: a flow exported alone has `flows` and nothing else. */
export function partsIn(bundle: ProjectBundle): ProjectBundlePart[] {
  return BUNDLE_PARTS.filter((part) => {
    if (part === "roles") return Boolean(bundle.roles?.length || bundle.roleRules?.length);
    if (part === "flows") return Boolean(bundle.flows?.workflows.length || bundle.flows?.requestTemplates.length);
    if (part === "settings") return bundle.settings !== undefined;
    if (part === "contract") return Boolean(bundle.contract?.raw.trim());
    const value = bundle[part];
    return Array.isArray(value) && value.length > 0;
  });
}

/**
 * A flow's graph with its references moved to the target's ids.
 *
 * Three references live inside the document: the request a step sends, the flow a sub-flow node
 * runs and the channel a channel node opens. Anything the maps do not know is returned as missing rather than left pointing at the
 * exporting project's rows.
 */
export function remapDefinition(
  definition: FlowDefinition,
  templateIds: Map<string, string>,
  workflowIds: Map<string, string>,
  channelIds: Map<string, string> = new Map(),
): { definition: FlowDefinition; missing: Problem[] } {
  const missing: Problem[] = [];
  const steps = definition.steps.map((step, index) => {
    const next: Record<string, unknown> = { ...step };
    if (typeof step.requestTemplateId === "string") {
      const mapped = templateIds.get(step.requestTemplateId);
      if (mapped) next.requestTemplateId = mapped;
      else missing.push({ field: `steps.${index}.requestTemplateId`, detail: "la petición no viene en el fichero" });
    }
    const subflow = step.subflow as Record<string, unknown> | undefined;
    if (subflow && typeof subflow.workflowId === "string") {
      const mapped = workflowIds.get(subflow.workflowId);
      if (mapped) next.subflow = { ...subflow, workflowId: mapped };
      else missing.push({ field: `steps.${index}.subflow.workflowId`, detail: "el sub-flujo no viene en el fichero" });
    }
    const channel = step.channel as Record<string, unknown> | undefined;
    if (channel && typeof channel.channelId === "string") {
      const mapped = channelIds.get(channel.channelId);
      if (mapped) next.channel = { ...channel, channelId: mapped };
      else missing.push({ field: `steps.${index}.channel.channelId`, detail: "el canal no viene en el fichero" });
    }
    return next;
  });
  return { definition: { ...definition, steps }, missing };
}

/** The flows to export when some were asked for by id: those, and every flow they run as a
 * sub-flow, transitively — a sub-flow node that lands without its flow is a node that cannot run. */
export function withSubflows<T extends { id: string; definition: { steps: unknown[] } }>(
  all: T[],
  chosen: string[],
): T[] {
  const byId = new Map(all.map((flow) => [flow.id, flow]));
  const keep = new Set<string>();
  const pending = [...chosen];
  while (pending.length) {
    const id = pending.pop()!;
    const flow = byId.get(id);
    if (!flow || keep.has(id)) continue;
    keep.add(id);
    for (const step of flow.definition.steps as { kind?: string; subflow?: { workflowId?: string } }[]) {
      if (step.kind === "subflow" && step.subflow?.workflowId) pending.push(step.subflow.workflowId);
    }
  }
  return all.filter((flow) => keep.has(flow.id));
}

/** The saved requests whose operation is not among `operationIds`: they import, and cannot run. */
export function missingOperations(
  templates: { name: string; operationId: string }[],
  operationIds: Set<string>,
): string[] {
  return templates
    .filter((template) => !operationIds.has(template.operationId))
    .map((template) => `${template.name} (${template.operationId})`);
}

const httpUrlProblem = (value: string): string | null => {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? null : "Solo http o https";
  } catch {
    return "Debe ser una URL absoluta";
  }
};

/**
 * Everything wrong with the chosen parts, through the validators their own editors use.
 *
 * The id maps are the ones the import will write with, so a remapped graph is validated exactly as
 * it will be stored.
 */
export function bundleProblems(
  bundle: ProjectBundle,
  parts: Set<ProjectBundlePart>,
  ids: { templates: Map<string, string>; workflows: Map<string, string>; channels: Map<string, string> },
  channelCeilings: ChannelCeilings,
): Problem[] {
  const problems: Problem[] = [];
  const push = (prefix: string, issues: Problem[]) =>
    issues.forEach((issue) => problems.push({ field: `${prefix}.${issue.field}`, detail: issue.detail }));

  if (parts.has("settings") && bundle.settings?.baseUrl)
    push("settings", projectSettingsProblems({ baseUrl: bundle.settings.baseUrl }, NO_AUTH));

  if (parts.has("contract") && bundle.contract) {
    try {
      importSpec(bundle.contract.raw)
        .problems.filter((problem) => problem.severity === "error")
        .forEach((problem) =>
          // Every error the importer reports points somewhere (`#/openapi`, `#/paths/…`).
          problems.push({ field: `contract.${problem.pointer}`, detail: problem.message }),
        );
    } catch (error) {
      // Text that is not YAML or JSON at all makes the parser throw rather than report.
      problems.push({ field: "contract", detail: `no es un documento OpenAPI legible: ${(error as Error).message}` });
    }
  }

  if (parts.has("config")) {
    bundle.config?.forEach((entry, index) => {
      if (!isConfigSection(entry.section)) {
        problems.push({ field: `config.${index}.section`, detail: `no existe la sección ${entry.section}` });
        return;
      }
      const verdict = safeParseSection(entry.section, entry.data);
      if (!verdict.ok) push(`config.${index}`, verdict.issues);
    });
  }

  if (parts.has("endpoints")) {
    bundle.endpoints?.forEach((endpoint, index) =>
      push(`endpoints.${index}`, endpointProblems(endpoint as unknown as EndpointInput)),
    );
  }

  if (parts.has("roles")) {
    const seen = new Set<string>();
    bundle.roles?.forEach((role, index) => {
      push(`roles.${index}`, roleProblems({ name: role.name, description: role.description, ...(role.color ? { color: role.color } : {}) }, true));
      if (seen.has(role.name.toLowerCase()))
        problems.push({ field: `roles.${index}.name`, detail: `«${role.name}» está dos veces en el fichero` });
      seen.add(role.name.toLowerCase());
    });
  }

  if (parts.has("flows") && bundle.flows) {
    const { requestTemplates, workflows, datasets, suites, channels } = bundle.flows;
    if (ids.channels.size !== channels.length)
      problems.push({ field: "flows.channels", detail: "hay dos canales con el mismo id" });
    channels.forEach((channel, index) => {
      push(`flows.channels.${index}`, channelProblems(channelInputOf(channel), channelCeilings));
      if (channel.protos.length) push(`flows.channels.${index}.protos`, protoFilesProblems(channel.protos));
    });
    requestTemplates.forEach((template, index) => {
      const verdict = safeParseRequestTemplate({
        name: template.name,
        operationId: template.operationId,
        expectedStatus: template.expectedStatus,
        parameters: template.parameters,
        disabledParameters: template.disabledParameters,
        headers: template.headers,
        disabledHeaders: template.disabledHeaders,
        ...(template.description !== null ? { description: template.description } : {}),
        ...(template.body !== undefined ? { body: template.body } : {}),
        ...(template.auth !== undefined ? { auth: template.auth } : {}),
      });
      if (!verdict.ok) push(`flows.requestTemplates.${index}`, verdict.issues);
    });
    if (ids.templates.size !== requestTemplates.length)
      problems.push({ field: "flows.requestTemplates", detail: "hay dos peticiones con el mismo id" });
    if (ids.workflows.size !== workflows.length)
      problems.push({ field: "flows.workflows", detail: "hay dos flujos con el mismo id" });
    workflows.forEach((workflow, index) => {
      const remapped = remapDefinition(workflow.definition, ids.templates, ids.workflows, ids.channels);
      push(`flows.workflows.${index}.definition`, remapped.missing);
      if (remapped.missing.length) return;
      const verdict = safeParseWorkflowDocument(remapped.definition);
      if (!verdict.ok) push(`flows.workflows.${index}`, verdict.issues);
    });
    datasets.forEach((dataset, index) => {
      if (!ids.workflows.has(dataset.workflowId))
        problems.push({ field: `flows.datasets.${index}.workflowId`, detail: "su flujo no viene en el fichero" });
      const verdict = safeParseDatasetRows(dataset.rows);
      if (!verdict.ok) push(`flows.datasets.${index}`, verdict.issues);
    });
    suites.forEach((suite, index) =>
      suite.workflowIds.forEach((id, position) => {
        if (!ids.workflows.has(id))
          problems.push({ field: `flows.suites.${index}.workflowIds.${position}`, detail: "ese flujo no viene en el fichero" });
      }),
    );
  }

  if (parts.has("environments")) {
    bundle.environments?.forEach((environment, index) => {
      const detail = httpUrlProblem(environment.baseUrl);
      if (detail) problems.push({ field: `environments.${index}.baseUrl`, detail });
    });
  }

  if (parts.has("performance")) {
    bundle.performance?.forEach((plan, index) => {
      const verdict = safeParsePlanDefinition(plan.definition);
      if (!verdict.ok) push(`performance.${index}`, verdict.issues);
    });
  }

  return problems;
}
