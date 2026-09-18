import { randomUUID } from "node:crypto";
import { Inject } from "@nestjs/common";
import { CommandHandler, type ICommand, type ICommandHandler } from "@nestjs/cqrs";
import type { WorkflowDocument } from "@eq/runner-core";
import type { ImportElementsResultView } from "@eq/contracts";

import { CLOCK, type ClockPort } from "@/shared/clock/clock.port";
import { ENDPOINT_REPOSITORY, type EndpointRepositoryPort } from "@/modules/endpoints/domain/ports";
import { endpointKey } from "@/modules/endpoints/domain/model";
import { WORKFLOW_REPOSITORY, type WorkflowRepositoryPort } from "@/modules/workflows/domain/ports";
import { ENVIRONMENT_REPOSITORY, type EnvironmentRepositoryPort } from "@/modules/environments/domain/ports";
import { CHANNEL_REPOSITORY, type ChannelRepositoryPort } from "@/modules/channels/domain/ports";
import { CHANNEL_PROTO_REPOSITORY, type ChannelProtoRepositoryPort } from "@/modules/channels/domain/grpc";
import { MAX_CHANNELS_PER_PROJECT, type Channel } from "@/modules/channels/domain/model";
import { ConflictError } from "@/shared/errors/domain-error";
import { PROJECT_REPOSITORY, type ProjectRepositoryPort } from "../../domain/ports";
import { ownedProject } from "./update-project";
import { storableChannel, uniqueName, withoutSecrets } from "../../domain/copying";
import { redactAuth, withoutLiteralSecrets } from "@/modules/workflows/domain/postman-auth";

export type ImportElementsInput = {
  sourceProjectId: string;
  endpointIds: string[];
  workflowIds: string[];
  environmentIds: string[];
};

export class ImportElementsCommand implements ICommand {
  constructor(
    readonly organizationId: string,
    readonly projectId: string,
    readonly input: ImportElementsInput,
    readonly actorId: string,
  ) {}
}

/**
 * Bringing chosen pieces of one project into another, element by element.
 *
 * The whole-project copy exists for starting from a template; this is the finer tool: three
 * endpoints from here, one flow from there. The same tenant rule holds — both projects go through
 * `ownedProject` — and the same secret rule — an environment's sensitive values keep their names and
 * lose their contents, because a copied secret is a secret in two places. A flow drags the requests
 * its steps name and its datasets with it, so it does not land pointing at nothing.
 *
 * Y los canales que abren sus nodos `channel`, con sus `.proto` y sin sus secretos, como al bifurcar:
 * sin ellos el nodo seguiría nombrando un canal **de otro proyecto**, que al guardar el flujo es un
 * 422 y al correrlo un rojo de «el canal ya no existe». Un flujo cuyo canal ya no está ni en el
 * origen no se copia y se dice por qué: no hay a qué remapearlo.
 *
 * Lo mismo con los sub-flujos: un nodo `subflow` nombra otro flujo **del mismo proyecto**, así que el
 * flujo que ejecuta viene arrastrado —y los que ejecute ese, hasta el final— y el nodo pasa a nombrar
 * la copia. Sin eso llegaría apuntando al flujo del origen: un 422 al guardarlo, y una corrida en
 * error al lanzarlo. Un sub-flujo que ya no está en el origen deja fuera al flujo que lo usa, dicho.
 */
@CommandHandler(ImportElementsCommand)
export class ImportElementsHandler implements ICommandHandler<ImportElementsCommand, ImportElementsResultView> {
  constructor(
    @Inject(PROJECT_REPOSITORY) private readonly projects: ProjectRepositoryPort,
    @Inject(ENDPOINT_REPOSITORY) private readonly endpoints: EndpointRepositoryPort,
    @Inject(WORKFLOW_REPOSITORY) private readonly workflows: WorkflowRepositoryPort,
    @Inject(ENVIRONMENT_REPOSITORY) private readonly environments: EnvironmentRepositoryPort,
    @Inject(CLOCK) private readonly clock: ClockPort,
    @Inject(CHANNEL_REPOSITORY) private readonly channels: ChannelRepositoryPort,
    @Inject(CHANNEL_PROTO_REPOSITORY) private readonly protos: ChannelProtoRepositoryPort,
  ) {}

  async execute(command: ImportElementsCommand): Promise<ImportElementsResultView> {
    const target = await ownedProject(this.projects, command.organizationId, command.projectId);
    await ownedProject(this.projects, command.organizationId, command.input.sourceProjectId);
    const source = command.input.sourceProjectId;
    const now = this.clock.now();
    const result: ImportElementsResultView = { endpoints: 0, workflows: 0, environments: 0, channels: 0, skipped: [] };

    // Los flujos elegidos y los que ejecutan como sub-flujo, hasta el final: todo lo que sigue —canales,
    // pruebas, conjuntos— se calcula sobre este conjunto y no sobre la selección.
    const workflowIds = await this.withSubflows(source, command.input.workflowIds);
    // El tope de canales antes de escribir nada: a medias quedarían endpoints copiados y flujos no.
    const channels = await this.channelsFor(source, workflowIds);
    if (channels.size && (await this.channels.countByProject(target.id)) + channels.size > MAX_CHANNELS_PER_PROJECT)
      throw new ConflictError(
        `Con los ${channels.size} canales de esos flujos, el proyecto pasaría de ${MAX_CHANNELS_PER_PROJECT}; no se ha importado nada`,
        "channels-full",
      );

    await this.copyEndpoints(source, target.id, new Set(command.input.endpointIds), command.actorId, now, result);
    const channelIds = await this.copyChannels(channels, target.id, command.actorId, now, result);
    await this.copyWorkflows(source, target.id, workflowIds, command.actorId, now, result, channelIds);
    await this.copyEnvironments(source, target.id, new Set(command.input.environmentIds), now, result);
    return result;
  }

  private async copyEndpoints(
    source: string,
    targetId: string,
    ids: Set<string>,
    actorId: string,
    now: Date,
    result: ImportElementsResultView,
  ): Promise<void> {
    if (!ids.size) return;
    const taken = new Set(
      (await this.endpoints.listAll(targetId)).map((endpoint) => endpointKey(endpoint.method, endpoint.path)),
    );
    let orderIndex = await this.endpoints.nextOrderIndex(targetId);
    const rows = (await this.endpoints.listAll(source))
      .filter((endpoint) => ids.has(endpoint.id))
      .filter((endpoint) => {
        const key = endpointKey(endpoint.method, endpoint.path);
        if (taken.has(key)) {
          result.skipped.push({ what: "endpoint", detail: `${endpoint.method} ${endpoint.path} ya existe` });
          return false;
        }
        taken.add(key);
        return true;
      })
      .map((endpoint) => ({
        ...endpoint,
        // Una fila de antes de que un endpoint tapara sus secretos puede traer uno: no se copia.
        auth: redactAuth(endpoint.auth).auth,
        id: randomUUID(),
        projectId: targetId,
        origin: "import" as const,
        orderIndex: orderIndex++,
        createdAt: now,
        updatedAt: now,
        updatedBy: actorId,
        deletedAt: null,
      }));
    if (rows.length) await this.endpoints.saveMany(rows);
    result.endpoints = rows.length;
  }

  /**
   * Los flujos elegidos más los que ejecutan sus nodos `subflow`, recorridos hasta el final. Un id que
   * no es de un flujo del origen no entra: el flujo que lo nombra se queda fuera al copiar, dicho.
   */
  private async withSubflows(source: string, chosen: string[]): Promise<Set<string>> {
    if (!chosen.length) return new Set();
    const byId = new Map((await this.workflows.listWorkflows(source)).map((workflow) => [workflow.id, workflow]));
    const ids = new Set<string>();
    const pending = chosen.filter((id) => byId.has(id));
    while (pending.length) {
      const id = pending.pop()!;
      if (ids.has(id)) continue;
      ids.add(id);
      for (const step of byId.get(id)!.definition.steps) {
        const child = step.subflow?.workflowId;
        if (child && byId.has(child) && !ids.has(child)) pending.push(child);
      }
    }
    return ids;
  }

  /** Los canales del origen que abren los nodos de los flujos elegidos, por id. */
  private async channelsFor(source: string, workflowIds: Set<string>): Promise<Map<string, Channel>> {
    if (!workflowIds.size) return new Map();
    const used = new Set(
      (await this.workflows.listWorkflows(source))
        .filter((workflow) => workflowIds.has(workflow.id))
        .flatMap((workflow) => workflow.definition.steps.map((step) => step.channel?.channelId))
        .filter((id): id is string => Boolean(id)),
    );
    if (!used.size) return new Map();
    return new Map(
      (await this.channels.listByProject(source))
        .filter((channel) => used.has(channel.id))
        .map((channel) => [channel.id, channel]),
    );
  }

  /** Los canales, copiados como al bifurcar. Devuelve id del origen → id nuevo. */
  private async copyChannels(
    channels: Map<string, Channel>,
    targetId: string,
    actorId: string,
    now: Date,
    result: ImportElementsResultView,
  ): Promise<Map<string, string>> {
    const ids = new Map<string, string>();
    if (!channels.size) return ids;
    const taken = new Set((await this.channels.listByProject(targetId)).map((channel) => channel.name));
    for (const channel of channels.values()) {
      const id = randomUUID();
      ids.set(channel.id, id);
      const name = uniqueName(channel.name, taken);
      taken.add(name);
      const clean = storableChannel(channel);
      if (JSON.stringify([clean.auth, clean.headers]) !== JSON.stringify([channel.auth, channel.headers]))
        result.skipped.push({ what: "canal", detail: `${name}: llega sin sus secretos, hay que volver a escribirlos` });
      await this.channels.save({
        ...clean,
        id,
        projectId: targetId,
        name,
        createdAt: now,
        updatedAt: now,
        updatedBy: actorId,
        deletedAt: null,
      });
      const files = channel.protocol === "grpc" ? await this.protos.list(channel.id) : [];
      if (files.length) await this.protos.replace(id, files);
      result.channels += 1;
    }
    return ids;
  }

  private async copyWorkflows(
    source: string,
    targetId: string,
    ids: Set<string>,
    actorId: string,
    now: Date,
    result: ImportElementsResultView,
    channelIds: Map<string, string>,
  ): Promise<void> {
    if (!ids.size) return;
    const chosen = (await this.workflows.listWorkflows(source)).filter((workflow) => ids.has(workflow.id));
    // Un nodo canal cuyo canal ya no está en el origen no tiene a qué remapearse: el flujo no se copia.
    // Tampoco uno cuyo sub-flujo ya no está, ni —hacia arriba— el que ejecuta un flujo que se quedó
    // fuera por eso: llegaría apuntando al origen.
    let workflows = chosen.filter((workflow) => {
      const orphan = workflow.definition.steps.find(
        (step) => step.channel?.channelId && !channelIds.has(step.channel.channelId),
      );
      if (orphan)
        result.skipped.push({
          what: "flujo",
          detail: `${workflow.name}: el nodo «${orphan.id}» abre un canal que ya no existe en el origen`,
        });
      return !orphan;
    });
    for (let dropped = true; dropped;) {
      const kept = new Set(workflows.map((workflow) => workflow.id));
      const next = workflows.filter((workflow) => {
        const orphan = workflow.definition.steps.find(
          (step) => step.subflow?.workflowId && !kept.has(step.subflow.workflowId),
        );
        if (orphan)
          result.skipped.push({
            what: "flujo",
            detail: `${workflow.name}: el sub-flujo «${orphan.id}» ejecuta un flujo que no se ha podido traer`,
          });
        return !orphan;
      });
      dropped = next.length !== workflows.length;
      workflows = next;
    }
    if (!workflows.length) return;
    // Los ids nuevos antes de escribir ninguno: un nodo `subflow` tiene que nombrar la copia de su
    // flujo aunque se escriba antes que ella.
    const newIds = new Map(workflows.map((workflow) => [workflow.id, randomUUID()]));

    // The templates the chosen flows actually use, and no others.
    const neededTemplates = new Set(
      workflows.flatMap((workflow) => workflow.definition.steps.map((step) => step.requestTemplateId)),
    );
    const existingTemplates = new Set((await this.workflows.listTemplates(targetId)).map((row) => row.name));
    const templateIds = new Map<string, string>();
    for (const template of await this.workflows.listTemplates(source)) {
      if (!neededTemplates.has(template.id)) continue;
      const name = uniqueName(template.name, existingTemplates);
      existingTemplates.add(name);
      const id = randomUUID();
      templateIds.set(template.id, id);
      await this.workflows.saveTemplate({
        ...template,
        id,
        projectId: targetId,
        name,
        createdAt: now,
        updatedAt: now,
        updatedBy: actorId,
      });
    }

    const existingWorkflows = new Set((await this.workflows.listWorkflows(targetId)).map((row) => row.name));
    const datasets = await this.workflows.listDatasets(source);
    for (const workflow of workflows) {
      const steps = workflow.definition.steps.map((step) => ({
        ...step,
        // A branch node has no template to remap; leave it untouched.
        ...(step.requestTemplateId
          ? { requestTemplateId: templateIds.get(step.requestTemplateId) ?? step.requestTemplateId }
          : {}),
        ...(step.channel?.channelId
          ? {
              channel: { ...step.channel, channelId: channelIds.get(step.channel.channelId) ?? step.channel.channelId },
            }
          : {}),
        ...(step.subflow?.workflowId
          ? { subflow: { ...step.subflow, workflowId: newIds.get(step.subflow.workflowId)! } }
          : {}),
      }));
      const name = uniqueName(workflow.name, existingWorkflows);
      existingWorkflows.add(name);
      const workflowId = newIds.get(workflow.id)!;
      await this.workflows.saveWorkflow({
        ...workflow,
        id: workflowId,
        projectId: targetId,
        name,
        definition: withoutLiteralSecrets({ ...workflow.definition, steps } as WorkflowDocument),
        createdAt: now,
        updatedAt: now,
        updatedBy: actorId,
      });
      for (const dataset of datasets.filter((entry) => entry.workflowId === workflow.id)) {
        await this.workflows.saveDataset({
          ...dataset,
          id: randomUUID(),
          projectId: targetId,
          workflowId,
          createdAt: now,
          updatedAt: now,
          updatedBy: actorId,
        });
      }
      result.workflows += 1;
    }
  }

  private async copyEnvironments(
    source: string,
    targetId: string,
    ids: Set<string>,
    now: Date,
    result: ImportElementsResultView,
  ): Promise<void> {
    if (!ids.size) return;
    const existing = new Set((await this.environments.listForProject(targetId)).map((row) => row.name));
    for (const environment of (await this.environments.listForProject(source)).filter((row) => ids.has(row.id))) {
      const name = uniqueName(environment.name, existing);
      existing.add(name);
      const active = withoutSecrets(environment.variables);
      const parked = withoutSecrets(environment.disabledVariables);
      const emptied = [...new Set([...active.emptied, ...parked.emptied])];
      if (emptied.length)
        result.skipped.push({ what: "secreto", detail: `${name}: hay que reescribir ${emptied.join(", ")}` });
      await this.environments.save({
        ...environment,
        id: randomUUID(),
        projectId: targetId,
        name,
        variables: active.variables,
        disabledVariables: parked.variables,
        // Reset, not carried: both are answers about this target, not the source.
        writesAllowed: false,
        authEnforced: false,
        createdAt: now,
      });
      result.environments += 1;
    }
  }
}
