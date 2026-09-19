import { randomUUID } from "node:crypto";
import { Inject, Injectable } from "@nestjs/common";
import { safeParseSection, type ConfigSection, type RequestAuth, type WorkflowDocument } from "@eq/runner-core";

import { ConflictError } from "@/shared/errors/domain-error";
import { CONFIG_REPOSITORY, type ConfigRepositoryPort, type ConfigRow } from "@/modules/config/domain/ports";
import { ENDPOINT_REPOSITORY, type EndpointRepositoryPort } from "@/modules/endpoints/domain/ports";
import type { Endpoint } from "@/modules/endpoints/domain/model";
import { ENVIRONMENT_REPOSITORY, type EnvironmentRepositoryPort } from "@/modules/environments/domain/ports";
import {
  CREDENTIAL_ROLE_NAME,
  RESERVED_CREDENTIAL_ROLES,
  type Environment,
  type EnvironmentVariables,
} from "@/modules/environments/domain/model";
import { WORKFLOW_REPOSITORY, type WorkflowRepositoryPort } from "@/modules/workflows/domain/ports";
import type { DatasetRow, RequestTemplateRow, SuiteRow, WorkflowRow } from "@/modules/workflows/domain/model";
import { ROLE_REPOSITORY, type RoleRepositoryPort } from "@/modules/roles/domain/ports";
import { CHANNEL_REPOSITORY, type ChannelRepositoryPort } from "@/modules/channels/domain/ports";
import { CHANNEL_PROTO_REPOSITORY, type ChannelProtoRepositoryPort } from "@/modules/channels/domain/grpc";
import { storableHeader, type Channel } from "@/modules/channels/domain/model";
import type { Role, RolePermission, RoleRule } from "@/modules/roles/domain/model";
import { deriveAccess, readAccess } from "@/modules/roles/domain/derive-access";
import { isSecretParam, redactAuth, withoutLiteralSecrets } from "@/modules/workflows/domain/postman-auth";
import type { Project } from "../domain/model";
import {
  PROJECT_FORK_REPOSITORY,
  PROJECT_REPOSITORY,
  type ProjectForkRepositoryPort,
  type ProjectRepositoryPort,
} from "../domain/ports";
import {
  completeLineage,
  LINKED_KINDS,
  type ForkWritePlan,
  type Lineage,
  type LinkedKind,
  type ProjectContents,
  type ProjectFork,
} from "../domain/fork";
import {
  diffToken,
  entryId,
  MERGE_KINDS,
  withAllKinds,
  threeWayDiff,
  winner,
  type DiffEntry,
  type ForkSnapshot,
  type MergeKind,
  type Resolutions,
} from "../domain/fork-merge";
import { forkKeys, parentKeys, snapshotOf, syncedSection, type KeyMap } from "../domain/fork-snapshot";
import { storableChannel, uniqueName } from "../domain/copying";
import { ownedProject } from "./commands/update-project";

/** `pull`: del original a la bifurcación. `merge`: de la bifurcación al original. */
export const SYNC_DIRECTIONS = ["pull", "merge"] as const;
export type SyncDirection = (typeof SYNC_DIRECTIONS)[number];

/** Todo lo que hace falta para enseñar una comparación y, después, aplicarla. */
export type Comparison = {
  direction: SyncDirection;
  fork: ProjectFork;
  forkProject: Project;
  parent: Project;
  source: { project: Project; contents: ProjectContents; keys: KeyMap; snapshot: ForkSnapshot };
  target: { project: Project; contents: ProjectContents; keys: KeyMap; snapshot: ForkSnapshot };
  /** Las parejas guardadas más las que se encontraron por nombre en esta comparación. */
  lineage: Lineage;
  entries: DiffEntry[];
  token: string;
};

export type SyncSkip = { what: string; detail: string };

export type SyncOutcome = {
  direction: SyncDirection;
  version: number;
  applied: Record<MergeKind, number>;
  skipped: SyncSkip[];
};

/**
 * Comparar una bifurcación con su original y convertir las decisiones en un plan de escritura.
 *
 * Un servicio y no dos manejadores con la mitad cada uno porque la vista previa y la aplicación
 * tienen que leer **exactamente** lo mismo: lo que se aplica es lo que se enseñó, y la huella lo
 * comprueba. Si las dos lecturas vivieran en sitios distintos, bastaría con que una aprendiera a
 * ignorar un campo para que la otra aplicara cambios que nadie vio.
 */
@Injectable()
export class ForkSync {
  constructor(
    @Inject(PROJECT_REPOSITORY) private readonly projects: ProjectRepositoryPort,
    @Inject(PROJECT_FORK_REPOSITORY) private readonly forks: ProjectForkRepositoryPort,
    @Inject(ENDPOINT_REPOSITORY) private readonly endpoints: EndpointRepositoryPort,
    @Inject(WORKFLOW_REPOSITORY) private readonly workflows: WorkflowRepositoryPort,
    @Inject(ENVIRONMENT_REPOSITORY) private readonly environments: EnvironmentRepositoryPort,
    @Inject(ROLE_REPOSITORY) private readonly roles: RoleRepositoryPort,
    @Inject(CONFIG_REPOSITORY) private readonly config: ConfigRepositoryPort,
    @Inject(CHANNEL_REPOSITORY) private readonly channels: ChannelRepositoryPort,
    @Inject(CHANNEL_PROTO_REPOSITORY) private readonly protos: ChannelProtoRepositoryPort,
  ) {}

  async contents(projectId: string): Promise<ProjectContents> {
    const [
      endpoints,
      templates,
      workflows,
      datasets,
      suites,
      environments,
      roles,
      rolePermissions,
      roleRules,
      sections,
    ] = await Promise.all([
      this.endpoints.listAll(projectId),
      this.workflows.listTemplates(projectId),
      this.workflows.listWorkflows(projectId),
      this.workflows.listDatasets(projectId),
      this.workflows.listSuites(projectId),
      this.environments.listForProject(projectId),
      this.roles.list(projectId),
      this.roles.listPermissions(projectId),
      this.roles.listRules(projectId),
      this.config.listSections(projectId),
    ]);
    const channels = await this.channels.listByProject(projectId);
    // Solo los de gRPC tienen `.proto`; preguntar por los demás sería una consulta por canal para nada.
    const channelProtos = Object.fromEntries(
      await Promise.all(
        channels
          .filter((channel) => channel.protocol === "grpc")
          .map(async (channel) => [channel.id, await this.protos.list(channel.id)] as const),
      ),
    );
    return {
      channels,
      channelProtos,
      endpoints,
      templates,
      workflows,
      datasets,
      suites,
      environments,
      roles,
      rolePermissions,
      roleRules,
      sections,
    };
  }

  /**
   * La bifurcación y su original, los dos de esta organización.
   *
   * Un original que ya no está —borrado, o en otra organización por lo que sea— es un 409 y no un
   * 404: la bifurcación sí existe, y lo que no se puede es sincronizarla. Decir «no existe» haría
   * pensar que el id está mal.
   */
  async pair(organizationId: string, forkProjectId: string) {
    const forkProject = await ownedProject(this.projects, organizationId, forkProjectId);
    const stored = await this.forks.findByFork(forkProject.id);
    if (!stored) throw new ConflictError("Este proyecto no es una bifurcación", "not-a-fork");
    // Una bifurcación de antes de que se compararan suites, roles y secciones: sin esos tipos.
    const fork = { ...stored, base: withAllKinds(stored.base), lineage: completeLineage(stored.lineage) };
    const parent = await this.projects.findById(fork.parentProjectId);
    if (!parent || parent.organizationId !== organizationId)
      throw new ConflictError("El proyecto original ya no existe", "fork-parent-gone");
    return { fork, forkProject, parent };
  }

  async compare(organizationId: string, forkProjectId: string, direction: SyncDirection): Promise<Comparison> {
    const { fork, forkProject, parent } = await this.pair(organizationId, forkProjectId);
    const [parentContents, forkContents] = await Promise.all([this.contents(parent.id), this.contents(forkProject.id)]);
    const pKeys = parentKeys(parentContents);
    const { keys: fKeys, implicit } = forkKeys(forkContents, fork.lineage, parentContents);
    const parentSide = {
      project: parent,
      contents: parentContents,
      keys: pKeys,
      snapshot: snapshotOf(parentContents, pKeys),
    };
    const forkSide = {
      project: forkProject,
      contents: forkContents,
      keys: fKeys,
      snapshot: snapshotOf(forkContents, fKeys),
    };
    const [source, target] = direction === "pull" ? [parentSide, forkSide] : [forkSide, parentSide];
    const lineage = Object.fromEntries(
      LINKED_KINDS.map((kind) => [kind, [...fork.lineage[kind], ...implicit[kind]]]),
    ) as Lineage;
    // La clave de un elemento enlazado es el id del original, así que una pareja por nombre se
    // reconoce por el id del original que emparejó.
    const byName = new Set(LINKED_KINDS.flatMap((kind) => implicit[kind].map((pair) => `${kind}:${pair.parentId}`)));
    return {
      direction,
      fork,
      forkProject,
      parent,
      source,
      target,
      lineage,
      entries: threeWayDiff(fork.base, source.snapshot, target.snapshot).map((entry) =>
        byName.has(entryId(entry)) ? { ...entry, pairedByName: true } : entry,
      ),
      token: diffToken(fork.base, source.snapshot, target.snapshot),
    };
  }

  /** Escribe el plan, todo o nada, y devuelve lo que pasó. */
  async apply(plan: ForkWritePlan): Promise<void> {
    await this.forks.apply(plan);
  }

  /**
   * Las decisiones, convertidas en filas.
   *
   * La nueva foto común es **la del origen**, siempre. Es la única regla que deja bien las cuatro
   * salidas posibles de un elemento: lo que venía del origen queda igual en los dos lados y en la
   * foto; lo que el destino tenía y el origen no, sigue apareciendo como trabajo del destino y sale
   * en la comparación del sentido contrario; y un conflicto que ganó el destino se queda como
   * cambio del destino —no se pierde, ni vuelve a llegar en silencio en la siguiente—.
   */
  plan(
    comparison: Comparison,
    resolutions: Resolutions,
    actorId: string,
    now: Date,
  ): {
    plan: ForkWritePlan;
    outcome: SyncOutcome;
  } {
    const builder = new PlanBuilder(comparison, actorId, now);
    for (const entry of comparison.entries) {
      if (winner(entry, resolutions) !== "source" || entry.sourceChange === "none") continue;
      builder.take(entry);
    }
    return builder.build();
  }
}

type Row = Endpoint | RequestTemplateRow | WorkflowRow | SuiteRow | Channel | Environment | Role | ConfigRow;

/** El id de una fila en su proyecto. Una sección no tiene: su nombre hace de id. */
const idOf = (row: Row): string => ("id" in row ? row.id : row.section);

const byKind = <T>(make: () => T): Record<MergeKind, T> =>
  Object.fromEntries(MERGE_KINDS.map((kind) => [kind, make()])) as Record<MergeKind, T>;

/** Lo que una clave nombra en cada lado, por tipo. */
function rowsByKey(contents: ProjectContents, keys: KeyMap): Record<MergeKind, Map<string, Row>> {
  const index = <T extends { id: string }>(kind: MergeKind, rows: T[]) =>
    new Map(rows.map((row) => [keys[kind].get(row.id)!, row as unknown as Row]));
  return {
    endpoint: index("endpoint", contents.endpoints),
    template: index("template", contents.templates),
    workflow: index("workflow", contents.workflows),
    suite: index("suite", contents.suites),
    channel: index("channel", contents.channels),
    environment: index("environment", contents.environments),
    role: index("role", contents.roles),
    section: new Map(
      contents.sections.filter((row) => syncedSection(row.section)).map((row) => [row.section, row as Row]),
    ),
  };
}

/**
 * Construye el plan de una sincronización, elemento a elemento.
 *
 * Primero se decide qué se escribe y con qué id —los flujos nombran pruebas y otros flujos por id,
 * y esos ids tienen que existir antes de reescribir ningún documento—; después se escriben las
 * filas. Lo que no puede hacerse sin romper otra cosa —borrar una prueba que un flujo del destino
 * sigue usando, borrar un flujo que una suite nombra, un rol con el nombre de otro— no se hace, y
 * se dice.
 */
class PlanBuilder {
  private readonly source: Record<MergeKind, Map<string, Row>>;
  private readonly target: Record<MergeKind, Map<string, Row>>;
  /** Clave → id en el destino después del plan. */
  private readonly targetIds: Record<MergeKind, Map<string, string>>;
  private readonly writes = byKind(() => new Set<string>());
  private readonly removals = byKind(() => new Set<string>());
  private readonly skipped: SyncSkip[] = [];
  private readonly lineage: Lineage;

  constructor(
    private readonly comparison: Comparison,
    private readonly actorId: string,
    private readonly now: Date,
  ) {
    this.source = rowsByKey(comparison.source.contents, comparison.source.keys);
    this.target = rowsByKey(comparison.target.contents, comparison.target.keys);
    this.targetIds = Object.fromEntries(
      (Object.keys(this.target) as MergeKind[]).map((kind) => [
        kind,
        new Map([...this.target[kind]].map(([key, row]) => [key, idOf(row)])),
      ]),
    ) as Record<MergeKind, Map<string, string>>;
    this.lineage = Object.fromEntries(
      LINKED_KINDS.map((kind) => [kind, comparison.lineage[kind].map((pair) => ({ ...pair }))]),
    ) as Lineage;
  }

  take(entry: DiffEntry): void {
    if (entry.sourceChange === "deleted") {
      if (this.target[entry.kind].has(entry.key)) this.removals[entry.kind].add(entry.key);
      return;
    }
    this.writes[entry.kind].add(entry.key);
    if (!this.targetIds[entry.kind].has(entry.key))
      this.targetIds[entry.kind].set(entry.key, entry.kind === "section" ? entry.key : randomUUID());
  }

  build(): { plan: ForkWritePlan; outcome: SyncOutcome } {
    this.dragWorkflows();
    this.guardWorkflowRemovals();
    this.dragTemplates();
    this.dragChannels();
    const workflows = this.workflowRows();
    this.guardTemplateRemovals(workflows);
    this.guardChannelRemovals(workflows);
    const channels = this.channelRows();
    const templates = this.templateRows();
    const suites = this.suiteRows();
    const environments = this.environmentRows();
    const datasets = this.datasetRows();
    const endpoints = this.endpointRows();
    const roles = this.roleRows();
    const permissions = this.permissionRows(roles);
    const rules = this.ruleRows();
    const sections = this.sectionRows();
    const access = this.accessSection(roles, permissions, endpoints);
    if (access) sections.push(access);
    const target = this.comparison.target.project;
    const removed = (kind: MergeKind) =>
      [...this.removals[kind]].map((key) => idOf(this.target[kind].get(key)!)).filter(Boolean);

    for (const kind of LINKED_KINDS) {
      for (const key of this.removals[kind]) this.unlink(kind, { targetId: idOf(this.target[kind].get(key)!) });
      for (const key of this.writes[kind]) {
        if (this.target[kind].has(key)) continue;
        this.link(kind, idOf(this.source[kind].get(key)!), this.targetIds[kind].get(key)!);
      }
    }

    const fork = this.nextFork();
    const plan: ForkWritePlan = {
      targetProjectId: target.id,
      endpoints: { save: endpoints, remove: removed("endpoint") },
      templates: { save: templates, remove: removed("template") },
      workflows: { save: workflows, remove: removed("workflow") },
      datasets,
      suites: { save: suites, remove: removed("suite") },
      channels: { ...channels, remove: removed("channel") },
      environments: { save: environments, remove: removed("environment") },
      roles: { save: roles, remove: removed("role"), permissions, rules },
      sections: { save: sections, remove: removed("section") as ConfigSection[] },
      project: this.nextProject(environments),
      fork,
      expectedVersion: this.comparison.fork.version,
      at: this.now,
    };
    const applied = Object.fromEntries(
      (Object.keys(this.writes) as MergeKind[]).map((kind) => [
        kind,
        this.writes[kind].size + this.removals[kind].size,
      ]),
    ) as Record<MergeKind, number>;
    return {
      plan,
      outcome: { direction: this.comparison.direction, version: fork.version, applied, skipped: this.skipped },
    };
  }

  /**
   * Un flujo que llega con un paso apuntando a una prueba que el destino no tendrá —porque allí se
   * borró, o porque el conflicto de esa prueba lo ganó el destino borrándola— se trae la prueba con
   * él. Un flujo que llega roto es peor que una prueba que vuelve.
   */
  private dragTemplates(): void {
    for (const key of this.writes.workflow) {
      const workflow = this.source.workflow.get(key) as WorkflowRow;
      for (const step of workflow.definition.steps) {
        if (!step.requestTemplateId) continue;
        const templateKey = this.comparison.source.keys.template.get(step.requestTemplateId);
        if (!templateKey || !this.source.template.has(templateKey)) continue;
        const present = this.targetIds.template.has(templateKey) && !this.removals.template.has(templateKey);
        if (present) continue;
        this.removals.template.delete(templateKey);
        this.writes.template.add(templateKey);
        if (!this.targetIds.template.has(templateKey)) this.targetIds.template.set(templateKey, randomUUID());
        this.skipped.push({
          what: "prueba",
          detail: `${(this.source.template.get(templateKey) as RequestTemplateRow).name}: vino con el flujo ${workflow.name}, que la usa`,
        });
      }
    }
  }

  /**
   * Lo mismo con los canales: un flujo que llega con un nodo canal trae el canal si el destino no lo
   * tendrá. Un nodo que apunta a un canal que no existe falla al correr con «El canal ya no existe».
   */
  private dragChannels(): void {
    for (const key of this.writes.workflow) {
      const workflow = this.source.workflow.get(key) as WorkflowRow;
      for (const step of workflow.definition.steps) {
        if (!step.channel) continue;
        const channelKey = this.comparison.source.keys.channel.get(step.channel.channelId);
        if (!channelKey || !this.source.channel.has(channelKey)) continue;
        if (this.targetIds.channel.has(channelKey) && !this.removals.channel.has(channelKey)) continue;
        if (this.writes.channel.has(channelKey)) continue;
        this.removals.channel.delete(channelKey);
        this.writes.channel.add(channelKey);
        if (!this.targetIds.channel.has(channelKey)) this.targetIds.channel.set(channelKey, randomUUID());
        this.skipped.push({
          what: "canal",
          detail: `${(this.source.channel.get(channelKey) as Channel).name}: vino con el flujo ${workflow.name}, que lo usa`,
        });
      }
    }
  }

  /** Un canal que algún flujo del destino seguirá usando después del plan no se borra. */
  private guardChannelRemovals(written: WorkflowRow[]): void {
    const writtenIds = new Set(written.map((row) => row.id));
    const remaining = [
      ...written,
      ...this.comparison.target.contents.workflows.filter((row) => {
        const key = this.comparison.target.keys.workflow.get(row.id)!;
        return !writtenIds.has(row.id) && !this.removals.workflow.has(key);
      }),
    ];
    const used = new Set(remaining.flatMap((row) => row.definition.steps.map((step) => step.channel?.channelId)));
    for (const key of [...this.removals.channel]) {
      const row = this.target.channel.get(key) as Channel;
      if (!used.has(row.id)) continue;
      this.removals.channel.delete(key);
      this.skipped.push({ what: "canal", detail: `${row.name}: no se borró, un flujo lo usa` });
    }
  }

  /**
   * Los canales, con la regla de los secretos de los entornos: **el destino conserva los suyos**. Lo
   * que llega viene sin literales —`storableChannel`—, y donde trae un hueco y el destino tenía algo,
   * se queda lo del destino: una cabecera con el mismo nombre, un parámetro de la autenticación del
   * mismo tipo. Los `.proto` de un canal gRPC viajan con él, enteros.
   */
  private channelRows(): Omit<ForkWritePlan["channels"], "remove"> {
    const save: Channel[] = [];
    const protos: ForkWritePlan["channels"]["protos"] = [];
    let orderIndex =
      this.comparison.target.contents.channels.reduce((max, row) => Math.max(max, row.orderIndex), -1) + 1;
    for (const key of this.writes.channel) {
      const source = storableChannel(this.source.channel.get(key) as Channel);
      const current = this.target.channel.get(key) as Channel | undefined;
      const id = this.targetIds.channel.get(key)!;
      const kept = new Map((current?.headers ?? []).map((header) => [header.name.toLowerCase(), header.value]));
      save.push({
        ...source,
        id,
        projectId: this.comparison.target.project.id,
        headers: source.headers.map((header) =>
          header.value === "" && kept.get(header.name.toLowerCase())
            ? storableHeader({ ...header, value: kept.get(header.name.toLowerCase())! })
            : header,
        ),
        auth: source.auth ? keepTargetSecrets(source.auth, current?.auth ?? undefined) : null,
        orderIndex: current?.orderIndex ?? orderIndex++,
        createdAt: current?.createdAt ?? this.now,
        updatedAt: this.now,
        updatedBy: this.actorId,
        deletedAt: null,
      });
      const sourceId = idOf(this.source.channel.get(key)!);
      if (source.protocol === "grpc")
        protos.push({ channelId: id, files: this.comparison.source.contents.channelProtos[sourceId] ?? [] });
    }
    return { save, protos };
  }

  private endpointRows(): Endpoint[] {
    const target = this.comparison.target.contents.endpoints;
    let orderIndex = target.reduce((max, row) => Math.max(max, row.orderIndex), -1) + 1;
    return [...this.writes.endpoint].map((key) => {
      const source = this.source.endpoint.get(key) as Endpoint;
      const current = this.target.endpoint.get(key) as Endpoint | undefined;
      return {
        ...source,
        id: this.targetIds.endpoint.get(key)!,
        projectId: this.comparison.target.project.id,
        auth: keepTargetSecrets(redactAuth(source.auth).auth, current?.auth),
        // Lo que dice de *este* proyecto se queda: su enlace con su contrato y su sitio en la lista.
        origin: current?.origin ?? source.origin,
        operationId: current?.operationId ?? null,
        orderIndex: current?.orderIndex ?? orderIndex++,
        createdAt: current?.createdAt ?? this.now,
        updatedAt: this.now,
        updatedBy: this.actorId,
        deletedAt: null,
      };
    });
  }

  private templateRows(): RequestTemplateRow[] {
    const taken = this.namesAfter("template");
    return [...this.writes.template].map((key) => {
      const source = this.source.template.get(key) as RequestTemplateRow;
      const current = this.target.template.get(key) as RequestTemplateRow | undefined;
      return {
        ...source,
        id: this.targetIds.template.get(key)!,
        projectId: this.comparison.target.project.id,
        name: this.freeName("prueba", source.name, current?.name, taken),
        createdAt: current?.createdAt ?? this.now,
        updatedAt: this.now,
        updatedBy: this.actorId,
      };
    });
  }

  private workflowRows(): WorkflowRow[] {
    const taken = this.namesAfter("workflow");
    return [...this.writes.workflow].map((key) => {
      const source = this.source.workflow.get(key) as WorkflowRow;
      const current = this.target.workflow.get(key) as WorkflowRow | undefined;
      return {
        ...source,
        id: this.targetIds.workflow.get(key)!,
        projectId: this.comparison.target.project.id,
        name: this.freeName("flujo", source.name, current?.name, taken),
        definition: this.remapDefinition(source),
        createdAt: current?.createdAt ?? this.now,
        updatedAt: this.now,
        updatedBy: this.actorId,
      };
    });
  }

  /** Los ids del origen, traducidos a los del destino por su clave de linaje. */
  private remapDefinition(workflow: WorkflowRow): WorkflowDocument {
    const keys = this.comparison.source.keys;
    const clean = withoutLiteralSecrets(workflow.definition);
    return {
      ...clean,
      steps: clean.steps.map((step) => {
        let next = step;
        if (step.requestTemplateId) {
          const key = keys.template.get(step.requestTemplateId);
          const id = key ? this.targetIds.template.get(key) : undefined;
          if (id) next = { ...next, requestTemplateId: id };
        }
        if (step.channel) {
          const key = keys.channel.get(step.channel.channelId);
          const id = key && !this.removals.channel.has(key) ? this.targetIds.channel.get(key) : undefined;
          if (id) next = { ...next, channel: { ...step.channel, channelId: id } };
          else
            this.skipped.push({
              what: "canal",
              detail: `${workflow.name}: el paso ${step.id} usa un canal que no está en el destino`,
            });
        }
        if (step.subflow) {
          const key = keys.workflow.get(step.subflow.workflowId);
          const id = key && !this.removals.workflow.has(key) ? this.targetIds.workflow.get(key) : undefined;
          if (id) next = { ...next, subflow: { ...step.subflow, workflowId: id } };
          else
            this.skipped.push({
              what: "subflujo",
              detail: `${workflow.name}: el paso ${step.id} ejecuta un flujo que no está en el destino`,
            });
        }
        return next;
      }),
    };
  }

  /**
   * Una suite que llega trae los flujos que nombra y el destino no tendrá —porque allí se borraron,
   * o porque el conflicto lo ganó el destino borrándolos—, como un flujo trae sus pruebas: una suite
   * que llega corriendo menos flujos de los que dice es peor que un flujo que vuelve.
   */
  private dragWorkflows(): void {
    for (const key of this.writes.suite) {
      const suite = this.source.suite.get(key) as SuiteRow;
      for (const id of suite.workflowIds) {
        const workflowKey = this.comparison.source.keys.workflow.get(id);
        if (!workflowKey || !this.source.workflow.has(workflowKey)) continue;
        const present = this.targetIds.workflow.has(workflowKey) && !this.removals.workflow.has(workflowKey);
        if (present) continue;
        this.removals.workflow.delete(workflowKey);
        this.writes.workflow.add(workflowKey);
        if (!this.targetIds.workflow.has(workflowKey)) this.targetIds.workflow.set(workflowKey, randomUUID());
        this.skipped.push({
          what: "flujo",
          detail: `${(this.source.workflow.get(workflowKey) as WorkflowRow).name}: vino con la suite ${suite.name}, que lo corre`,
        });
      }
    }
  }

  /**
   * Un flujo que una suite del destino seguirá nombrando no se borra: la suite correría menos flujos
   * de los que dice. Las suites que se reescriben o se borran con este plan no cuentan —las que
   * llegan ya trajeron los suyos—.
   */
  private guardWorkflowRemovals(): void {
    const staying = this.comparison.target.contents.suites.filter((row) => {
      const key = this.comparison.target.keys.suite.get(row.id)!;
      return !this.writes.suite.has(key) && !this.removals.suite.has(key);
    });
    for (const key of [...this.removals.workflow]) {
      const workflow = this.target.workflow.get(key) as WorkflowRow;
      const suite = staying.find((row) => row.workflowIds.includes(workflow.id));
      if (!suite) continue;
      this.removals.workflow.delete(key);
      this.skipped.push({ what: "flujo", detail: `${workflow.name}: no se borró, la suite ${suite.name} lo usa` });
    }
  }

  /** Una prueba que algún flujo del destino seguirá usando después del plan no se borra. */
  private guardTemplateRemovals(written: WorkflowRow[]): void {
    const writtenIds = new Set(written.map((row) => row.id));
    const remaining = [
      ...written,
      ...this.comparison.target.contents.workflows.filter((row) => {
        const key = this.comparison.target.keys.workflow.get(row.id)!;
        return !writtenIds.has(row.id) && !this.removals.workflow.has(key);
      }),
    ];
    const used = new Set(remaining.flatMap((row) => row.definition.steps.map((step) => step.requestTemplateId)));
    for (const key of [...this.removals.template]) {
      const row = this.target.template.get(key) as RequestTemplateRow;
      if (!used.has(row.id)) continue;
      this.removals.template.delete(key);
      this.skipped.push({
        what: "prueba",
        detail: `${row.name}: no se borró, un flujo la usa`,
      });
    }
  }

  /** Las suites, con sus flujos traducidos a los ids del destino y en el mismo orden. */
  private suiteRows(): SuiteRow[] {
    const taken = this.namesAfter("suite");
    return [...this.writes.suite].map((key) => {
      const source = this.source.suite.get(key) as SuiteRow;
      const current = this.target.suite.get(key) as SuiteRow | undefined;
      const workflowIds: string[] = [];
      for (const id of source.workflowIds) {
        const workflowKey = this.comparison.source.keys.workflow.get(id);
        const targetId =
          workflowKey && !this.removals.workflow.has(workflowKey)
            ? this.targetIds.workflow.get(workflowKey)
            : undefined;
        if (targetId) workflowIds.push(targetId);
        else
          this.skipped.push({ what: "suite", detail: `${source.name}: nombraba un flujo que ya no existe y se quitó` });
      }
      return {
        ...source,
        id: this.targetIds.suite.get(key)!,
        projectId: this.comparison.target.project.id,
        name: this.freeName("suite", source.name, current?.name, taken),
        workflowIds,
        createdAt: current?.createdAt ?? this.now,
        updatedAt: this.now,
        updatedBy: this.actorId,
      };
    });
  }

  /**
   * Los roles. Si el destino ya tiene **otro** rol con ese nombre, el que llega se numera como una
   * prueba, pero con la regla de nombres de las credenciales: «admin (2)» no es un nombre de rol
   * —ni cabe en una credencial ni en la matriz—, «admin-2» sí. Antes no se traía y solo se avisaba,
   * y un rol que no llega se lleva con él sus permisos y sus reglas sin que nadie lo decida.
   */
  private roleRows(): Role[] {
    const taken = this.namesAfter("role");
    let position = this.comparison.target.contents.roles.reduce((max, row) => Math.max(max, row.position), -1) + 1;
    const rows: Role[] = [];
    for (const key of [...this.writes.role]) {
      const source = this.source.role.get(key) as Role;
      const current = this.target.role.get(key) as Role | undefined;
      const name = taken.has(source.name) ? freeRoleName(source.name, taken) : source.name;
      if (!name) {
        this.writes.role.delete(key);
        if (!current) this.targetIds.role.delete(key);
        this.skipped.push({ what: "rol", detail: `${source.name}: el destino ya tiene otro rol con ese nombre` });
        continue;
      }
      taken.add(name);
      if (name !== source.name && name !== current?.name)
        this.skipped.push({ what: "rol", detail: `${source.name}: ya había otro con ese nombre, se llama ${name}` });
      rows.push({
        ...source,
        name,
        id: this.targetIds.role.get(key)!,
        projectId: this.comparison.target.project.id,
        position: current?.position ?? position++,
        createdAt: current?.createdAt ?? this.now,
        updatedAt: this.now,
      });
    }
    return rows;
  }

  /**
   * Los permisos de cada rol que se reescribe: los suyos del destino se borran y se escriben los del
   * origen, cada uno sobre el endpoint del destino con el mismo método y ruta. Un permiso sobre un
   * endpoint que el destino no tendrá no tiene dónde ir.
   */
  private permissionRows(roles: Role[]): ForkWritePlan["roles"]["permissions"] {
    const clear = roles.filter((role) => this.comparison.target.contents.roles.some((row) => row.id === role.id));
    const save: RolePermission[] = [];
    for (const key of this.writes.role) {
      const source = this.source.role.get(key) as Role;
      const roleId = this.targetIds.role.get(key)!;
      let lost = 0;
      for (const permission of this.comparison.source.contents.rolePermissions) {
        if (permission.roleId !== source.id) continue;
        const endpointKey = this.comparison.source.keys.endpoint.get(permission.endpointId);
        const endpointId =
          endpointKey && !this.removals.endpoint.has(endpointKey)
            ? this.targetIds.endpoint.get(endpointKey)
            : undefined;
        if (endpointId) save.push({ ...permission, roleId, endpointId });
        else lost += 1;
      }
      if (lost)
        this.skipped.push({
          what: "rol",
          detail: `${source.name}: ${lost} permiso(s) sobre endpoints que el destino no tiene`,
        });
    }
    return { clear: clear.map((role) => role.id), save };
  }

  /**
   * Las reglas entre roles, enteras, si algún rol cambia: las del destino cuyo rol de origen no se
   * toca, más las de cada rol que llega. Una regla hacia un rol que el destino no tendrá se cae.
   */
  private ruleRows(): RoleRule[] | null {
    if (!this.writes.role.size && !this.removals.role.size) return null;
    const projectId = this.comparison.target.project.id;
    const gone = new Set([...this.removals.role].map((key) => idOf(this.target.role.get(key)!)));
    const rewritten = new Set([...this.writes.role].map((key) => this.targetIds.role.get(key)!));
    const rules = this.comparison.target.contents.roleRules.filter(
      (rule) => !rewritten.has(rule.sourceRoleId) && !gone.has(rule.sourceRoleId) && !gone.has(rule.targetRoleId),
    );
    const present = (key: string | undefined) =>
      key && !this.removals.role.has(key) ? this.targetIds.role.get(key) : undefined;
    for (const key of this.writes.role) {
      const source = this.source.role.get(key) as Role;
      for (const rule of this.comparison.source.contents.roleRules) {
        if (rule.sourceRoleId !== source.id) continue;
        const targetRoleId = present(this.comparison.source.keys.role.get(rule.targetRoleId));
        if (!targetRoleId) {
          this.skipped.push({ what: "rol", detail: `${source.name}: una regla hacia un rol que el destino no tiene` });
          continue;
        }
        rules.push({ ...rule, projectId, sourceRoleId: this.targetIds.role.get(key)!, targetRoleId });
      }
    }
    return rules;
  }

  private sectionRows(): ConfigRow[] {
    return [...this.writes.section].map((key) => ({
      projectId: this.comparison.target.project.id,
      section: key as ConfigSection,
      data: (this.source.section.get(key) as ConfigRow).data,
      updatedAt: this.now,
      updatedBy: this.actorId,
    }));
  }

  /**
   * La sección `access` del destino, derivada otra vez de los roles que tendrá, como la deriva
   * cualquier cambio en la pantalla de roles: con lo que el destino tenga de ella que no sale de los
   * roles —los estados de rechazo, las reglas cruzadas— y con cada rol renombrado renombrado también
   * ahí. Solo si algún rol cambia.
   */
  private accessSection(roles: Role[], permissions: ForkWritePlan["roles"]["permissions"], written: Endpoint[]) {
    if (!this.writes.role.size && !this.removals.role.size) return null;
    const target = this.comparison.target.contents;
    const gone = new Set([...this.removals.role].map((key) => idOf(this.target.role.get(key)!)));
    const rewritten = new Set(roles.map((role) => role.id));
    const finalRoles = [...target.roles.filter((row) => !gone.has(row.id) && !rewritten.has(row.id)), ...roles].sort(
      (left, right) => left.position - right.position,
    );
    const cleared = new Set(permissions.clear);
    const finalPermissions = [
      ...target.rolePermissions.filter((row) => !gone.has(row.roleId) && !cleared.has(row.roleId)),
      ...permissions.save,
    ];
    const removedEndpoints = new Set([...this.removals.endpoint].map((key) => idOf(this.target.endpoint.get(key)!)));
    const writtenIds = new Set(written.map((row) => row.id));
    const finalEndpoints = [
      ...target.endpoints.filter((row) => !removedEndpoints.has(row.id) && !writtenIds.has(row.id)),
      ...written,
    ];
    const stored = target.sections.find((row) => row.section === "access");
    if (!stored && !finalRoles.length) return null;
    const renamed: Record<string, string> = {};
    for (const role of roles) {
      const before = target.roles.find((row) => row.id === role.id);
      if (before && before.name !== role.name) renamed[before.name] = role.name;
    }
    const data = {
      access: deriveAccess(readAccess(stored?.data), finalRoles, finalPermissions, finalEndpoints, renamed),
    };
    if (!safeParseSection("access", data).ok) {
      this.skipped.push({ what: "sección", detail: "access: no se pudo derivar de los roles; revísala en Roles" });
      return null;
    }
    const row: ConfigRow = {
      projectId: this.comparison.target.project.id,
      section: "access",
      data,
      updatedAt: this.now,
      updatedBy: this.actorId,
    };
    return row;
  }

  /**
   * Los datasets de cada flujo que llega, emparejados por nombre con los que el destino ya tenía.
   * El de un flujo que se borra se va con él.
   */
  private datasetRows(): ForkWritePlan["datasets"] {
    const save: DatasetRow[] = [];
    const remove: string[] = [];
    const targetProject = this.comparison.target.project.id;
    for (const key of this.writes.workflow) {
      const sourceId = idOf(this.source.workflow.get(key)!);
      const targetId = this.targetIds.workflow.get(key)!;
      const current = new Map(
        this.comparison.target.contents.datasets
          .filter((row) => row.workflowId === targetId)
          .map((row) => [row.name, row]),
      );
      for (const dataset of this.comparison.source.contents.datasets.filter((row) => row.workflowId === sourceId)) {
        const existing = current.get(dataset.name);
        current.delete(dataset.name);
        save.push({
          ...dataset,
          id: existing?.id ?? randomUUID(),
          projectId: targetProject,
          workflowId: targetId,
          createdAt: existing?.createdAt ?? this.now,
          updatedAt: this.now,
          updatedBy: this.actorId,
        });
      }
      remove.push(...[...current.values()].map((row) => row.id));
    }
    for (const key of this.removals.workflow) {
      const id = idOf(this.target.workflow.get(key)!);
      remove.push(
        ...this.comparison.target.contents.datasets.filter((row) => row.workflowId === id).map((row) => row.id),
      );
    }
    return { save, remove };
  }

  /**
   * Los entornos, con la regla de los secretos al revés que al copiar: **el destino conserva los
   * suyos**. Una variable sensible del origen llega vacía —su valor es cifrado de otro proyecto, y
   * además al bifurcar se vació—, así que escribirla encima de la del destino sería borrar un
   * secreto que funciona para poner un hueco. Si el destino no la tenía, llega con su nombre y
   * vacía, y se dice.
   */
  private environmentRows(): Environment[] {
    const taken = this.namesAfter("environment");
    return [...this.writes.environment].map((key) => {
      const source = this.source.environment.get(key) as Environment;
      const current = this.target.environment.get(key) as Environment | undefined;
      const name = this.freeName("entorno", source.name, current?.name, taken);
      const kept = { ...(current?.variables ?? {}), ...(current?.disabledVariables ?? {}) };
      const emptied: string[] = [];
      const merge = (variables: EnvironmentVariables): EnvironmentVariables =>
        Object.fromEntries(
          Object.entries(variables).map(([variable, value]) => {
            if (!value.sensitive) return [variable, value];
            const mine = kept[variable];
            if (mine?.sensitive) return [variable, mine];
            emptied.push(variable);
            return [variable, { initial: "", current: "", sensitive: true }];
          }),
        );
      const variables = merge(source.variables);
      const disabledVariables = merge(source.disabledVariables);
      if (emptied.length)
        this.skipped.push({ what: "secreto", detail: `${name}: hay que escribir ${[...new Set(emptied)].join(", ")}` });
      return {
        id: this.targetIds.environment.get(key)!,
        projectId: this.comparison.target.project.id,
        name,
        baseUrl: source.baseUrl,
        specUrl: source.specUrl,
        variables,
        disabledVariables,
        // Respuestas sobre *este* destino: se quedan las suyas, y uno nuevo empieza sin permisos.
        writesAllowed: current?.writesAllowed ?? false,
        authEnforced: current?.authEnforced ?? false,
        createdAt: current?.createdAt ?? this.now,
      };
    });
  }

  /** El entorno activo sigue apuntando a uno que existe, como lo mantienen los comandos de entornos. */
  private nextProject(written: Environment[]): Project | null {
    const project = this.comparison.target.project;
    const removed = new Set([...this.removals.environment].map((key) => idOf(this.target.environment.get(key)!)));
    const remaining = [
      ...this.comparison.target.contents.environments.filter((row) => !removed.has(row.id)),
      ...written.filter((row) => !this.comparison.target.contents.environments.some((old) => old.id === row.id)),
    ];
    const active = project.activeEnvironmentId;
    if (active && !removed.has(active)) return null;
    const next = remaining[0]?.id ?? null;
    return next === active ? null : { ...project, activeEnvironmentId: next };
  }

  /** Los nombres que tendrá el destino, sin los que se van y sin los que se reescriben. */
  private namesAfter(kind: LinkedKind): Set<string> {
    const leaving = new Set([...this.removals[kind], ...this.writes[kind]]);
    return new Set(
      [...this.target[kind]].filter(([key]) => !leaving.has(key)).map(([, row]) => (row as { name: string }).name),
    );
  }

  /** Nombres únicos por proyecto: si el que llega ya lo usa otro elemento del destino, se numera. */
  private freeName(what: string, wanted: string, current: string | undefined, taken: Set<string>): string {
    const name = taken.has(wanted) ? uniqueName(wanted, taken) : wanted;
    taken.add(name);
    if (name !== wanted && name !== current)
      this.skipped.push({ what, detail: `${wanted}: ya había otro con ese nombre, se llama ${name}` });
    return name;
  }

  private link(kind: LinkedKind, sourceId: string, targetId: string): void {
    const pair =
      this.comparison.direction === "pull"
        ? { parentId: sourceId, forkId: targetId }
        : { parentId: targetId, forkId: sourceId };
    this.lineage[kind] = [
      ...this.lineage[kind].filter((row) => row.parentId !== pair.parentId && row.forkId !== pair.forkId),
      pair,
    ];
  }

  private unlink(kind: LinkedKind, { targetId }: { targetId: string }): void {
    const side = this.comparison.direction === "pull" ? "forkId" : "parentId";
    this.lineage[kind] = this.lineage[kind].filter((row) => row[side] !== targetId);
  }

  /**
   * La bifurcación con su foto nueva: la del origen, con las claves que el linaje ya actualizado le
   * da. Al traer, el origen es el original y sus claves son sus ids. Al fusionar es la bifurcación, y
   * por eso el linaje tiene que estar al día antes de hacer la foto: un flujo que acaba de nacer en
   * el original se llama ya por su id de allí.
   */
  private nextFork(): ProjectFork {
    const { fork, direction, source } = this.comparison;
    const lineage = this.lineage;
    const base =
      direction === "pull" ? source.snapshot : snapshotOf(source.contents, forkKeys(source.contents, lineage).keys);
    return { ...fork, base, lineage, version: fork.version + 1, syncedAt: this.now };
  }
}

/**
 * La autenticación que llega, con los secretos del destino donde la que llega trae un hueco.
 *
 * Solo si el tipo es el mismo: un `basic` que pasó a `bearer` no tiene nada que conservar del otro.
 */
export function keepTargetSecrets(incoming: RequestAuth, current: RequestAuth | undefined): RequestAuth {
  if (!current || current.type !== incoming.type) return incoming;
  const params = { ...incoming.params };
  for (const [key, value] of Object.entries(params)) {
    if (value === "" && isSecretParam(incoming.type, key) && current.params[key]) params[key] = current.params[key]!;
  }
  return { ...incoming, params };
}

/**
 * Un nombre libre para un rol que choca: `admin-2`, `admin-3`… dentro de la regla de las credenciales
 * (20 caracteres, sin espacios ni paréntesis) y fuera de los reservados. Nulo si no queda ninguno,
 * que con 998 intentos es un proyecto que no existe.
 */
export function freeRoleName(wanted: string, taken: Set<string>): string | null {
  for (let suffix = 2; suffix < 1000; suffix += 1) {
    const tail = `-${suffix}`;
    const candidate = `${wanted.slice(0, 20 - tail.length)}${tail}`;
    if (taken.has(candidate) || !CREDENTIAL_ROLE_NAME.test(candidate)) continue;
    // No reserved name has a «-N» tail today, so this never skips; it keeps holding if one ever does.
    /* node:coverage ignore next 2 */
    if ((RESERVED_CREDENTIAL_ROLES as readonly string[]).includes(candidate))
      continue;
    return candidate;
  }
  return null;
}
