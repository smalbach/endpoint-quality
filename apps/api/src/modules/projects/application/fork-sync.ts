import { randomUUID } from "node:crypto";
import { Inject, Injectable } from "@nestjs/common";
import type { RequestAuth, WorkflowDocument } from "@eq/runner-core";

import { ConflictError } from "@/shared/errors/domain-error";
import { ENDPOINT_REPOSITORY, type EndpointRepositoryPort } from "@/modules/endpoints/domain/ports";
import type { Endpoint } from "@/modules/endpoints/domain/model";
import { ENVIRONMENT_REPOSITORY, type EnvironmentRepositoryPort } from "@/modules/environments/domain/ports";
import type { Environment, EnvironmentVariables } from "@/modules/environments/domain/model";
import { WORKFLOW_REPOSITORY, type WorkflowRepositoryPort } from "@/modules/workflows/domain/ports";
import type { DatasetRow, RequestTemplateRow, WorkflowRow } from "@/modules/workflows/domain/model";
import { isSecretParam, redactAuth, withoutLiteralSecrets } from "@/modules/workflows/domain/postman-auth";
import type { Project } from "../domain/model";
import {
  PROJECT_FORK_REPOSITORY,
  PROJECT_REPOSITORY,
  type ProjectForkRepositoryPort,
  type ProjectRepositoryPort,
} from "../domain/ports";
import type { ForkWritePlan, Lineage, LinkedKind, ProjectContents, ProjectFork } from "../domain/fork";
import {
  diffToken,
  threeWayDiff,
  winner,
  type DiffEntry,
  type ForkSnapshot,
  type MergeKind,
  type Resolutions,
} from "../domain/fork-merge";
import { forkKeys, parentKeys, snapshotOf, type KeyMap } from "../domain/fork-snapshot";
import { uniqueName } from "../domain/copying";
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

const LINKED: LinkedKind[] = ["template", "workflow", "environment"];

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
  ) {}

  async contents(projectId: string): Promise<ProjectContents> {
    const [endpoints, templates, workflows, datasets, suites, environments] = await Promise.all([
      this.endpoints.listAll(projectId),
      this.workflows.listTemplates(projectId),
      this.workflows.listWorkflows(projectId),
      this.workflows.listDatasets(projectId),
      this.workflows.listSuites(projectId),
      this.environments.listForProject(projectId),
    ]);
    return { endpoints, templates, workflows, datasets, suites, environments };
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
    const fork = await this.forks.findByFork(forkProject.id);
    if (!fork) throw new ConflictError("Este proyecto no es una bifurcación", "not-a-fork");
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
      LINKED.map((kind) => [kind, [...fork.lineage[kind], ...implicit[kind]]]),
    ) as Lineage;
    return {
      direction,
      fork,
      forkProject,
      parent,
      source,
      target,
      lineage,
      entries: threeWayDiff(fork.base, source.snapshot, target.snapshot),
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

type Row = Endpoint | RequestTemplateRow | WorkflowRow | Environment;

/** Lo que una clave nombra en cada lado, por tipo. */
function rowsByKey(contents: ProjectContents, keys: KeyMap): Record<MergeKind, Map<string, Row>> {
  const index = <T extends { id: string }>(kind: MergeKind, rows: T[]) =>
    new Map(rows.map((row) => [keys[kind].get(row.id)!, row as unknown as Row]));
  return {
    endpoint: index("endpoint", contents.endpoints),
    template: index("template", contents.templates),
    workflow: index("workflow", contents.workflows),
    environment: index("environment", contents.environments),
  };
}

/**
 * Construye el plan de una sincronización, elemento a elemento.
 *
 * Primero se decide qué se escribe y con qué id —los flujos nombran pruebas y otros flujos por id,
 * y esos ids tienen que existir antes de reescribir ningún documento—; después se escriben las
 * filas. Lo que no puede hacerse sin romper otra cosa —borrar una prueba que un flujo del destino
 * sigue usando, borrar un flujo que una suite nombra— no se hace, y se dice.
 */
class PlanBuilder {
  private readonly source: Record<MergeKind, Map<string, Row>>;
  private readonly target: Record<MergeKind, Map<string, Row>>;
  /** Clave → id en el destino después del plan. */
  private readonly targetIds: Record<MergeKind, Map<string, string>>;
  private readonly writes: Record<MergeKind, Set<string>> = {
    endpoint: new Set(),
    template: new Set(),
    workflow: new Set(),
    environment: new Set(),
  };
  private readonly removals: Record<MergeKind, Set<string>> = {
    endpoint: new Set(),
    template: new Set(),
    workflow: new Set(),
    environment: new Set(),
  };
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
        new Map([...this.target[kind]].map(([key, row]) => [key, row.id])),
      ]),
    ) as Record<MergeKind, Map<string, string>>;
    this.lineage = Object.fromEntries(
      LINKED.map((kind) => [kind, comparison.lineage[kind].map((pair) => ({ ...pair }))]),
    ) as Lineage;
  }

  take(entry: DiffEntry): void {
    if (entry.sourceChange === "deleted") {
      if (this.target[entry.kind].has(entry.key)) this.removals[entry.kind].add(entry.key);
      return;
    }
    this.writes[entry.kind].add(entry.key);
    if (!this.targetIds[entry.kind].has(entry.key)) this.targetIds[entry.kind].set(entry.key, randomUUID());
  }

  build(): { plan: ForkWritePlan; outcome: SyncOutcome } {
    this.guardWorkflowRemovals();
    this.dragTemplates();
    const workflows = this.workflowRows();
    this.guardTemplateRemovals(workflows);
    const templates = this.templateRows();
    const environments = this.environmentRows();
    const datasets = this.datasetRows();
    const target = this.comparison.target.project;
    const removed = (kind: MergeKind) =>
      [...this.removals[kind]].map((key) => this.target[kind].get(key)!.id).filter(Boolean);

    for (const kind of LINKED) {
      for (const key of this.removals[kind]) this.unlink(kind, { targetId: this.target[kind].get(key)!.id });
      for (const key of this.writes[kind]) {
        if (this.target[kind].has(key)) continue;
        this.link(kind, this.source[kind].get(key)!.id, this.targetIds[kind].get(key)!);
      }
    }

    const fork = this.nextFork();
    const plan: ForkWritePlan = {
      targetProjectId: target.id,
      endpoints: { save: this.endpointRows(), remove: removed("endpoint") },
      templates: { save: templates, remove: removed("template") },
      workflows: { save: workflows, remove: removed("workflow") },
      datasets,
      environments: { save: environments, remove: removed("environment") },
      project: this.nextProject(environments),
      fork,
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
   * Un flujo que una suite del destino nombra no se borra: la suite correría menos flujos de los que
   * dice. Las suites no se sincronizan, así que es el destino quien decide qué hacer con ella.
   */
  private guardWorkflowRemovals(): void {
    for (const key of [...this.removals.workflow]) {
      const workflow = this.target.workflow.get(key) as WorkflowRow;
      const suite = this.comparison.target.contents.suites.find((row) => row.workflowIds.includes(workflow.id));
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
      const row = this.target.template.get(key)!;
      if (!used.has(row.id)) continue;
      this.removals.template.delete(key);
      this.skipped.push({
        what: "prueba",
        detail: `${(row as RequestTemplateRow).name}: no se borró, un flujo la usa`,
      });
    }
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
      const sourceId = this.source.workflow.get(key)!.id;
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
      const id = this.target.workflow.get(key)!.id;
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
    const removed = new Set([...this.removals.environment].map((key) => this.target.environment.get(key)!.id));
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
