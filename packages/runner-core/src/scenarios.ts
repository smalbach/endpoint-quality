/**
 * The cases one operation gets, generated from what the contract declares and what the project
 * configured. Pure: no network, no clock, no framework.
 *
 * The structure mirrors the coupled version one for one — functional cases, then the write
 * edges, then the authorization matrix, deduplicated by id — because that order is observable
 * in the queue and is pinned by the golden. What changed is where the values come from.
 */
import type { Operation, ResolvedOperation, ScenarioFlow, TestScenario } from "./types.ts";
import type { ConditionalScenario, ProjectConfig, ScenarioTemplate } from "./config.ts";
import { parametersFor, toSample } from "./config.ts";
import { interpolate } from "./text.ts";
import { responseShapeFor } from "./envelope.ts";
import { exampleFromSchema } from "./example.ts";

/** Path parameters are the ones the path template mentions; everything else is a query. */
export function pathParameters(operation: Operation): string[] {
  return operation.parameters.filter((name) => operation.path.includes(`{${name}}`));
}
export function queryParameters(operation: Operation): string[] {
  return operation.parameters.filter((name) => !operation.path.includes(`{${name}}`));
}

/** An operation plus the project's overlay: routed or not, its payloads, its envelope. */
export function resolveOperation(operation: Operation, config: ProjectConfig): ResolvedOperation {
  const template = config.bodyTemplates[operation.id] ?? {};
  /**
   * **Configuration first, the contract second, nothing third.**
   *
   * A schema says what is structurally valid; a project knows what is *acceptable* — which store
   * id exists, which EAN is real, which name is already taken. So a `bodies` entry always wins,
   * and the derived example only fills the silence where there used to be no payload at all and
   * every write came back 422.
   *
   * `conflictBody` is not derived on purpose: a 409 needs a payload that collides with a row that
   * is already there, which is knowledge about the data and not about the schema. Without one
   * there is no conflict case, exactly as before.
   */
  const derived = template.body ? undefined : exampleFromSchema(operation.requestSchema);
  const body =
    template.body ?? (derived && typeof derived === "object" ? (derived as Record<string, unknown>) : undefined);
  return {
    ...operation,
    implemented: config.implemented === null ? true : config.implemented.includes(operation.id),
    responseShape: responseShapeFor(operation, config),
    ...(body ? { body } : {}),
    ...(template.conflictBody ? { conflictBody: template.conflictBody } : {}),
    ...(template.replaceBody ? { replaceBody: template.replaceBody } : {}),
  };
}

export function resolveOperations(operations: Operation[], config: ProjectConfig): ResolvedOperation[] {
  return operations.map((operation) => resolveOperation(operation, config));
}

function fromTemplate(template: ScenarioTemplate): TestScenario {
  return {
    id: template.id,
    name: template.name,
    description: template.description,
    expectedStatus: template.expectedStatus,
    ...(template.parameters ? { parameters: template.parameters } : {}),
    ...(template.body ? { body: template.body } : {}),
    flow: template.flow ?? "request",
    ...(template.auth ? { auth: template.auth } : {}),
  };
}

function applies(conditional: ConditionalScenario, available: string[]): boolean {
  return conditional.requiresParameters.every((name) => available.includes(name));
}

function isListOperation(operation: Operation, config: ProjectConfig): boolean {
  const { methods, operationIdPrefix } = config.listOperations;
  if (!methods.includes(operation.method)) return false;
  return operationIdPrefix ? operation.id.startsWith(operationIdPrefix) : true;
}

/**
 * The filter matrix of a collection endpoint: the unfiltered baseline, one case per value of
 * each query parameter, then the cases that need a combination.
 *
 * One case per parameter **in isolation** is the point. A request that sends four filters at
 * once and comes back with plausible rows proves nothing about any of them; a filter that is
 * silently ignored only shows up when it is the only one applied.
 */
function listScenarios(operation: ResolvedOperation, config: ProjectConfig): TestScenario[] {
  const scenarios: TestScenario[] = [
    {
      id: "default",
      name: config.text.listDefaultName,
      description: config.text.listDefaultDescription,
      expectedStatus: 200,
      flow: "request",
    },
  ];
  const queries = queryParameters(operation);
  const values = parametersFor(config, operation.id);
  for (const parameter of queries) {
    if (config.excludeFromSoloScenarios.includes(parameter)) continue;
    for (const raw of values.samples(parameter)) {
      const sample = toSample(raw);
      scenarios.push({
        id: `${parameter}-${sample.value}`,
        name: sample.name ?? interpolate(config.text.soloName, { parameter, value: sample.value }),
        description: sample.description ?? interpolate(config.text.soloDescription, { parameter, value: sample.value }),
        expectedStatus: sample.expectedStatus ?? 200,
        parameters: { [parameter]: sample.value },
        flow: "request",
      });
    }
  }
  for (const conditional of config.conditionalScenarios) {
    if (applies(conditional, queries)) scenarios.push(fromTemplate(conditional));
  }
  return scenarios;
}

/**
 * The 401 and 403 the contract declares on nearly every operation.
 *
 * Generated from `statuses`, not from a list of operation names: an operation that stops
 * declaring 403 stops getting the case, and one that starts declaring it gets the case on the
 * next spec import. That is the difference between a matrix and a copy of a matrix.
 */
function authScenarios(operation: ResolvedOperation, config: ProjectConfig): TestScenario[] {
  if (config.authExcludedOperationIds.includes(operation.id)) return [];
  const scope = config.scopes.byMethod?.[operation.method] ?? config.scopes.default;
  const scenarios: TestScenario[] = [];
  for (const rule of config.authRules) {
    if (rule.when.declaredStatus !== undefined && !operation.statuses.includes(rule.when.declaredStatus)) continue;
    if (rule.when.methods && !rule.when.methods.includes(operation.method)) continue;
    const defaults = defaultAuthText(rule.credential, config);
    scenarios.push({
      id: rule.id,
      name: rule.name ?? defaults.name,
      description: interpolate(rule.description ?? defaults.description, {
        scope,
        method: operation.method,
        path: operation.path,
      }),
      expectedStatus: rule.expectedStatus,
      flow: "request",
      auth: rule.credential,
      ...(rule.sendBody && operation.body ? { body: operation.body } : {}),
    });
  }
  return scenarios;
}

function defaultAuthText(credential: string, config: ProjectConfig): { name: string; description: string } {
  if (credential === "none") return { name: config.text.authNoneName, description: config.text.authNoneDescription };
  if (credential === "insufficient")
    return { name: config.text.authInsufficientName, description: config.text.authInsufficientDescription };
  return { name: config.text.authApiKeyName, description: config.text.authApiKeyDescription };
}

/** The 404 of a write over a missing id, the 422 of a payload that does not validate, and the
 * 409 of a natural key that already exists — each emitted only when the contract declares it. */
function writeEdgeScenarios(operation: ResolvedOperation, config: ProjectConfig): TestScenario[] {
  const scenarios: TestScenario[] = [];
  const names = pathParameters(operation);
  const values = parametersFor(config, operation.id);
  const missing = Object.fromEntries(names.map((name) => [name, values.missing()]));
  const present = Object.fromEntries(names.map((name) => [name, values.present(name)]));

  if (operation.statuses.includes(404) && names.length) {
    scenarios.push({
      id: "not-found",
      name: config.text.notFoundWriteName,
      description: config.text.notFoundWriteDescription,
      expectedStatus: 404,
      parameters: missing,
      ...(operation.body ? { body: operation.body } : {}),
      flow: "request",
    });
  }
  if (operation.statuses.includes(422) && ["PUT", "PATCH"].includes(operation.method)) {
    scenarios.push({
      id: "invalid-body",
      name: config.text.invalidBodyName,
      description:
        operation.method === "PUT" ? config.text.invalidBodyPutDescription : config.text.invalidBodyPatchDescription,
      expectedStatus: 422,
      parameters: present,
      body: {},
      flow: "request",
    });
  }
  if (operation.statuses.includes(409) && operation.conflictBody) {
    scenarios.push({
      id: "conflict",
      name: config.text.conflictName,
      description: config.text.conflictDescription,
      expectedStatus: 409,
      body: operation.conflictBody,
      flow: "request",
    });
  }
  return scenarios;
}

function functionalScenarios(operation: ResolvedOperation, config: ProjectConfig): TestScenario[] {
  const override = config.operationOverrides[operation.id];
  if (override?.functional) return override.functional.map(fromTemplate);

  const extra = (override?.extraFunctional ?? []).map(fromTemplate);
  if (isListOperation(operation, config)) return [...listScenarios(operation, config), ...extra];

  if (operation.method === "GET") {
    const names = pathParameters(operation);
    const values = parametersFor(config, operation.id);
    const present = Object.fromEntries(names.map((name) => [name, values.present(name)]));
    const missing = Object.fromEntries(names.map((name) => [name, values.missing()]));
    return [
      {
        id: "found",
        name: config.text.getFoundName,
        description: config.text.getFoundDescription,
        expectedStatus: 200,
        parameters: present,
        flow: "request",
      },
      // **Only when there is an identifier to make missing, and only when 404 is declared.**
      //
      // Without the first condition a parameterless GET — `/health` is the one every contract
      // has — got a `not-found` case whose request is byte for byte the `found` one, because
      // there is no placeholder to substitute. One of the two then has to be wrong: the same URL
      // cannot answer 200 and 404. It was a guaranteed red row on every project, reporting a
      // fault in an endpoint that was behaving perfectly, which is precisely the false red this
      // product exists not to produce.
      //
      // The second condition is the rule the list scenarios already followed: asserting a status
      // the contract never promised tests the document, not the API.
      ...(names.length && operation.statuses.includes(404)
        ? [
            {
              id: "not-found",
              name: config.text.getNotFoundName,
              description: config.text.getNotFoundDescription,
              expectedStatus: 404,
              parameters: missing,
              flow: "request",
            } as TestScenario,
          ]
        : []),
      ...extra,
    ];
  }

  const body = operation.body ?? {};
  if (operation.method === "POST") {
    const bulk = config.bulkOperationIdPrefix && operation.id.startsWith(config.bulkOperationIdPrefix);
    return [
      {
        id: "create-read",
        name: config.text.createReadName,
        description: config.text.createReadDescription,
        expectedStatus: operation.statuses.includes(201) ? 201 : 200,
        body,
        flow: (bulk ? "bulk-read" : "create-read") as ScenarioFlow,
      },
      {
        id: "invalid-body",
        name: config.text.invalidBodyName,
        description: config.text.invalidBodyPostDescription,
        expectedStatus: 422,
        body: {},
        flow: "request",
      },
      ...extra,
    ];
  }
  if (operation.method === "PUT") {
    return [
      {
        id: "replace-read",
        name: config.text.replaceReadName,
        description: config.text.replaceReadDescription,
        expectedStatus: 200,
        body: operation.replaceBody ?? body,
        flow: "replace-read",
      },
      ...extra,
    ];
  }
  if (operation.method === "PATCH") {
    return [
      {
        id: "patch-read",
        name: config.text.patchReadName,
        description: config.text.patchReadDescription,
        expectedStatus: 200,
        body,
        flow: "patch-read",
      },
      ...extra,
    ];
  }
  return [
    {
      id: "delete-read",
      name: config.text.deleteReadName,
      description: config.text.deleteReadDescription,
      expectedStatus: 204,
      flow: "delete-read",
    },
    {
      id: "deleted-read",
      name: config.text.deletedReadName,
      description: config.text.deletedReadDescription,
      expectedStatus: 404,
      flow: "deleted-read",
    },
    ...extra,
  ];
}

/**
 * Every case one operation has.
 *
 * Deduplicated by id and first-wins: a detail GET already generates its own `not-found`, and a
 * second one would collide on the key results are stored under, where one would overwrite the
 * other's verdict.
 */
export function scenariosFor(operation: ResolvedOperation, config: ProjectConfig): TestScenario[] {
  const all = [
    ...functionalScenarios(operation, config),
    ...writeEdgeScenarios(operation, config),
    ...authScenarios(operation, config),
  ];
  return all.filter((scenario, index) => all.findIndex((other) => other.id === scenario.id) === index);
}

/**
 * The subset that can run against the target as it is configured.
 *
 * The authorization cases need an environment that actually enforces authorization. Against one
 * that grants every scope to everyone, all of them fail for a reason that has nothing to do
 * with the endpoint — which is worse than not running them.
 */
export function runnableScenarios(
  operation: ResolvedOperation,
  config: ProjectConfig,
  authEnabled: boolean,
): TestScenario[] {
  return scenariosFor(operation, config).filter(
    (scenario) => authEnabled || !scenario.auth || scenario.auth === "default",
  );
}
