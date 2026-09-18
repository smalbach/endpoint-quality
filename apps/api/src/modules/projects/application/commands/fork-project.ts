import { randomUUID } from "node:crypto";
import { Inject } from "@nestjs/common";
import { CommandHandler, type ICommand, type ICommandHandler } from "@nestjs/cqrs";
import type { WorkflowDocument } from "@eq/runner-core";
import type { ForkCreatedView } from "@eq/contracts";

import { CLOCK, type ClockPort } from "@/shared/clock/clock.port";
import { CONFIG_REPOSITORY, type ConfigRepositoryPort } from "@/modules/config/domain/ports";
import {
  ENDPOINT_REPOSITORY,
  EXAMPLE_REPOSITORY,
  type EndpointRepositoryPort,
  type ExampleRepositoryPort,
} from "@/modules/endpoints/domain/ports";
import { ENVIRONMENT_REPOSITORY, type EnvironmentRepositoryPort } from "@/modules/environments/domain/ports";
import { ROLE_REPOSITORY, type RoleRepositoryPort } from "@/modules/roles/domain/ports";
import { CHANNEL_REPOSITORY, type ChannelRepositoryPort } from "@/modules/channels/domain/ports";
import { CHANNEL_PROTO_REPOSITORY, type ChannelProtoRepositoryPort } from "@/modules/channels/domain/grpc";
import { syncAccessSection } from "@/modules/roles/application/sync-access";
import { SPEC_REPOSITORY, type SpecRepositoryPort } from "@/modules/specs/domain/ports";
import { WORKFLOW_REPOSITORY, type WorkflowRepositoryPort } from "@/modules/workflows/domain/ports";
import { redactAuth, withoutLiteralSecrets } from "@/modules/workflows/domain/postman-auth";
import { slugifyProject, type Project } from "../../domain/model";
import type { StoredProjectAuth } from "../../domain/project-auth";
import {
  PROJECT_FORK_REPOSITORY,
  PROJECT_REPOSITORY,
  type ProjectForkRepositoryPort,
  type ProjectRepositoryPort,
} from "../../domain/ports";
import { emptyLineage, type Lineage } from "../../domain/fork";
import { parentKeys, snapshotOf } from "../../domain/fork-snapshot";
import { storableChannel, withoutSecrets } from "../../domain/copying";
import { ForkSync } from "../fork-sync";
import { freeSlug } from "./create-project";
import { ownedProject } from "./update-project";

type Contents = Awaited<ReturnType<ForkSync["contents"]>>;

export type ForkProjectInput = { name?: string; description?: string };

export class ForkProjectCommand implements ICommand {
  constructor(
    readonly organizationId: string,
    readonly parentProjectId: string,
    readonly input: ForkProjectInput,
    readonly actorId: string,
  ) {}
}

/**
 * Una bifurcación: un proyecto nuevo con todo lo del original, que recuerda de dónde salió.
 *
 * Sustituye a «Copiar de otro proyecto». Aquella copia servía para empezar un proyecto desde otro
 * que ya funcionaba, y lo hacía **dentro** de uno ya creado y sin memoria: una vez copiado, los dos
 * proyectos no volvían a saber nada el uno del otro, y un arreglo en el original había que
 * repetirlo a mano en cada copia. Esto es lo mismo con memoria —el original, la foto común y qué
 * elemento de aquí es cuál de allí—, que es lo que permite después traer y fusionar cambios.
 *
 * Las reglas de la copia siguen todas:
 *
 * - **La misma organización.** El original pasa por `ownedProject`; uno de otra organización es un
 *   404, no un 403, que confirmaría que el id existe.
 * - **Ids nuevos, referencias traducidas.** Un flujo nombra sus pruebas —y un subflujo, su flujo—
 *   por id dentro de un `jsonb`; copiarlo tal cual dejaría un grafo apuntando a las filas del otro.
 * - **Ningún secreto cruza.** Ni credenciales, ni el valor de una variable sensible, ni el secreto
 *   de la autenticación del proyecto, ni un literal en la autenticación de una petición. Llegan con
 *   su nombre y vacíos, y la respuesta dice cuáles hay que volver a escribir.
 *
 * Lo que no se lleva, y por qué: las corridas y las sesiones de los canales son de quien las
 * corrió; los mocks, la documentación publicada y los monitores tienen una URL pública o un
 * horario, y duplicarlos en silencio publicaría o dispararía algo que nadie pidió; los planes de
 * carga apuntan a un entorno concreto.
 */
@CommandHandler(ForkProjectCommand)
export class ForkProjectHandler implements ICommandHandler<ForkProjectCommand, ForkCreatedView> {
  constructor(
    @Inject(PROJECT_REPOSITORY) private readonly projects: ProjectRepositoryPort,
    @Inject(PROJECT_FORK_REPOSITORY) private readonly forks: ProjectForkRepositoryPort,
    @Inject(SPEC_REPOSITORY) private readonly specs: SpecRepositoryPort,
    @Inject(CONFIG_REPOSITORY) private readonly config: ConfigRepositoryPort,
    @Inject(ENDPOINT_REPOSITORY) private readonly endpoints: EndpointRepositoryPort,
    @Inject(EXAMPLE_REPOSITORY) private readonly examples: ExampleRepositoryPort,
    @Inject(WORKFLOW_REPOSITORY) private readonly workflows: WorkflowRepositoryPort,
    @Inject(ENVIRONMENT_REPOSITORY) private readonly environments: EnvironmentRepositoryPort,
    @Inject(ROLE_REPOSITORY) private readonly roles: RoleRepositoryPort,
    @Inject(CHANNEL_REPOSITORY) private readonly channels: ChannelRepositoryPort,
    @Inject(CHANNEL_PROTO_REPOSITORY) private readonly protos: ChannelProtoRepositoryPort,
    @Inject(CLOCK) private readonly clock: ClockPort,
    private readonly sync: ForkSync,
  ) {}

  async execute(command: ForkProjectCommand): Promise<ForkCreatedView> {
    const parent = await ownedProject(this.projects, command.organizationId, command.parentProjectId);
    const now = this.clock.now();
    const actorId = command.actorId;
    // Leído una vez: la foto común y la copia salen de la misma lectura, así que no puede colarse
    // entre las dos un cambio que la foto tenga y la copia no.
    const contents = await this.sync.contents(parent.id);
    const result: ForkCreatedView = {
      projectId: randomUUID(),
      slug: "",
      copied: {
        endpoints: 0,
        requestTemplates: 0,
        workflows: 0,
        suites: 0,
        channels: 0,
        environments: 0,
        roles: 0,
        sections: 0,
      },
      skipped: [],
    };
    const skip = (what: string, detail: string) => result.skipped.push({ what, detail });

    const name = (command.input.name?.trim() || `${parent.name} (bifurcación)`).slice(0, 200);
    const { auth, emptied } = withoutProjectSecret(parent.auth);
    if (emptied) skip("autenticación", "la del proyecto llega sin su secreto: hay que volver a escribirlo");
    let project: Project = {
      id: result.projectId,
      organizationId: parent.organizationId,
      name,
      slug: await freeSlug(this.projects, parent.organizationId, slugifyProject(name)),
      description: (command.input.description ?? parent.description).trim(),
      createdBy: actorId,
      createdAt: now,
      archivedAt: null,
      activeSpecVersionId: null,
      activeEnvironmentId: null,
      baseUrl: parent.baseUrl,
      tags: [...parent.tags],
      auth,
      deletedAt: null,
    };
    result.slug = project.slug;
    await this.projects.save(project);

    project = { ...project, activeSpecVersionId: await this.copyContract(parent, project.id) };
    result.copied.sections = await this.copySections(contents, project.id, actorId, now);

    const endpointIds = new Map<string, string>();
    const endpoints = contents.endpoints.map((endpoint) => {
      const id = randomUUID();
      endpointIds.set(endpoint.id, id);
      return {
        ...endpoint,
        id,
        projectId: project.id,
        // Una fila de antes de que un endpoint tapara sus secretos puede traer uno: no se copia.
        auth: redactAuth(endpoint.auth).auth,
        createdAt: now,
        updatedAt: now,
        updatedBy: actorId,
      };
    });
    if (endpoints.length) await this.endpoints.saveMany(endpoints);
    result.copied.endpoints = endpoints.length;
    const examples = (await this.examples.listByProject(parent.id))
      .filter((example) => endpointIds.has(example.endpointId))
      .map((example) => ({
        ...example,
        id: randomUUID(),
        projectId: project.id,
        endpointId: endpointIds.get(example.endpointId)!,
        createdAt: now,
        updatedAt: now,
      }));
    if (examples.length) await this.examples.saveMany(examples);

    const lineage = emptyLineage();
    result.copied.roles = await this.copyRoles(contents, project.id, endpointIds, actorId, now, lineage);
    const channelIds = await this.copyChannels(contents, project.id, actorId, now, lineage, result);
    await this.copyFlows(contents, project.id, actorId, now, lineage, result, channelIds);
    const environmentIds = await this.copyEnvironments(contents, project.id, now, lineage, result);
    if (parent.activeEnvironmentId)
      project.activeEnvironmentId = environmentIds.get(parent.activeEnvironmentId) ?? null;
    await this.projects.save(project);

    await this.forks.save({
      forkProjectId: project.id,
      parentProjectId: parent.id,
      organizationId: parent.organizationId,
      createdBy: actorId,
      createdAt: now,
      syncedAt: now,
      version: 1,
      base: snapshotOf(contents, parentKeys(contents)),
      lineage,
    });
    return result;
  }

  /**
   * El contrato activo, como filas nuevas y sin su origen.
   *
   * No a través de la importación: activar un contrato crea los endpoints que le faltan, y la
   * bifurcación nacería con endpoints que el original había borrado —diferencias que nadie hizo—.
   * El origen tampoco viene: guarda cifradas las cabeceras con las que se lee la URL del contrato.
   */
  private async copyContract(parent: Project, projectId: string): Promise<string | null> {
    if (!parent.activeSpecVersionId) return null;
    const version = await this.specs.findVersionById(parent.activeSpecVersionId);
    if (!version) return null;
    const id = randomUUID();
    const operations = await this.specs.listOperations(version.id);
    await this.specs.saveVersion(
      { ...version, id, projectId, sourceId: null },
      operations.map((operation) => ({ ...operation, rowId: randomUUID(), specVersionId: id })),
    );
    return id;
  }

  /** Todas menos `implemented`, que es un hecho sobre el código de un proyecto y no una decisión. */
  private async copySections(contents: Contents, projectId: string, actorId: string, now: Date): Promise<number> {
    const rows = contents.sections.filter((row) => row.section !== "implemented");
    for (const row of rows) await this.config.saveSection({ ...row, projectId, updatedAt: now, updatedBy: actorId });
    return rows.length;
  }

  /** Los roles con sus permisos y sus reglas, y cada rol en el linaje: desde ahora se sincronizan. */
  private async copyRoles(
    contents: Contents,
    projectId: string,
    endpointIds: Map<string, string>,
    actorId: string,
    now: Date,
    lineage: Lineage,
  ): Promise<number> {
    const roles = contents.roles;
    if (!roles.length) return 0;
    const roleIds = new Map<string, string>();
    for (const role of roles) {
      const id = randomUUID();
      roleIds.set(role.id, id);
      lineage.role.push({ parentId: role.id, forkId: id });
      await this.roles.save({ ...role, id, projectId, createdAt: now, updatedAt: now });
    }
    const permissions = contents.rolePermissions
      .filter((permission) => roleIds.has(permission.roleId) && endpointIds.has(permission.endpointId))
      .map((permission) => ({
        ...permission,
        roleId: roleIds.get(permission.roleId)!,
        endpointId: endpointIds.get(permission.endpointId)!,
      }));
    if (permissions.length) await this.roles.applyPermissions(permissions);
    const rules = contents.roleRules
      .filter((rule) => roleIds.has(rule.sourceRoleId) && roleIds.has(rule.targetRoleId))
      .map((rule) => ({
        ...rule,
        projectId,
        sourceRoleId: roleIds.get(rule.sourceRoleId)!,
        targetRoleId: roleIds.get(rule.targetRoleId)!,
      }));
    if (rules.length) await this.roles.replaceRules(projectId, rules);
    // La sección `access` se deriva de los roles en todas partes; aquí también.
    await syncAccessSection(
      { roles: this.roles, endpoints: this.endpoints, config: this.config, clock: this.clock },
      projectId,
      actorId,
    );
    return roles.length;
  }

  /**
   * Las pruebas, los flujos con sus datasets y las suites, cada referencia traducida.
   *
   * En ese orden porque cada uno nombra al anterior por id. Los datasets sí vienen —la copia vieja
   * los dejaba, porque llevaba el flujo a otro proyecto con otros datos—: una bifurcación es el
   * mismo proyecto por otro camino, y un flujo sin sus filas no se puede correr igual que el suyo.
   */
  private async copyFlows(
    contents: Contents,
    projectId: string,
    actorId: string,
    now: Date,
    lineage: Lineage,
    result: ForkCreatedView,
    channelIds: Map<string, string>,
  ): Promise<void> {
    const templateIds = new Map<string, string>();
    for (const template of contents.templates) {
      const id = randomUUID();
      templateIds.set(template.id, id);
      lineage.template.push({ parentId: template.id, forkId: id });
      await this.workflows.saveTemplate({
        ...template,
        id,
        projectId,
        createdAt: now,
        updatedAt: now,
        updatedBy: actorId,
      });
    }
    result.copied.requestTemplates = contents.templates.length;

    // Los ids de todos los flujos antes de escribir ninguno: un subflujo puede nombrar uno que va
    // después en la lista.
    const workflowIds = new Map<string, string>(contents.workflows.map((workflow) => [workflow.id, randomUUID()]));
    for (const workflow of contents.workflows) {
      const id = workflowIds.get(workflow.id)!;
      lineage.workflow.push({ parentId: workflow.id, forkId: id });
      const steps = workflow.definition.steps.map((step) => ({
        ...step,
        ...(step.requestTemplateId
          ? { requestTemplateId: templateIds.get(step.requestTemplateId) ?? step.requestTemplateId }
          : {}),
        ...(step.subflow
          ? {
              subflow: {
                ...step.subflow,
                workflowId: workflowIds.get(step.subflow.workflowId) ?? step.subflow.workflowId,
              },
            }
          : {}),
        // Sin esto, el nodo seguía nombrando el canal del original, y correrlo en la bifurcación
        // fallaba con «El canal ya no existe»: el canal existe, pero en otro proyecto.
        ...(step.channel
          ? {
              channel: { ...step.channel, channelId: channelIds.get(step.channel.channelId) ?? step.channel.channelId },
            }
          : {}),
      }));
      const dangling = workflow.definition.steps.filter(
        (step) => step.requestTemplateId && !templateIds.has(step.requestTemplateId),
      );
      if (dangling.length) {
        const ids = dangling.map((step) => step.id).join(", ");
        result.skipped.push({
          what: "paso",
          detail: `${workflow.name}: ${ids} apunta a una prueba que no existe en el origen`,
        });
      }
      await this.workflows.saveWorkflow({
        ...workflow,
        id,
        projectId,
        definition: withoutLiteralSecrets({ ...workflow.definition, steps } as WorkflowDocument),
        createdAt: now,
        updatedAt: now,
        updatedBy: actorId,
      });
    }
    result.copied.workflows = contents.workflows.length;

    for (const dataset of contents.datasets) {
      const workflowId = workflowIds.get(dataset.workflowId);
      if (!workflowId) continue;
      await this.workflows.saveDataset({
        ...dataset,
        id: randomUUID(),
        projectId,
        workflowId,
        createdAt: now,
        updatedAt: now,
        updatedBy: actorId,
      });
    }

    for (const suite of contents.suites) {
      const id = randomUUID();
      lineage.suite.push({ parentId: suite.id, forkId: id });
      await this.workflows.saveSuite({
        ...suite,
        id,
        projectId,
        workflowIds: suite.workflowIds.map((id) => workflowIds.get(id)).filter((id): id is string => Boolean(id)),
        createdAt: now,
        updatedAt: now,
        updatedBy: actorId,
      });
    }
    result.copied.suites = contents.suites.length;
  }

  /**
   * Los canales —WebSocket, MQTT y gRPC, con sus ajustes y sus `.proto`— sin sus sesiones ni sus
   * mensajes, que son de quien conversó. Las cabeceras y la autenticación, como se guardan
   * (`storableChannel`): un literal que quedara de antes no se duplica. Devuelve id del original →
   * id nuevo, para que los nodos canal de los flujos apunten a la copia.
   */
  private async copyChannels(
    contents: Contents,
    projectId: string,
    actorId: string,
    now: Date,
    lineage: Lineage,
    result: ForkCreatedView,
  ): Promise<Map<string, string>> {
    const ids = new Map<string, string>();
    for (const channel of contents.channels) {
      const id = randomUUID();
      ids.set(channel.id, id);
      lineage.channel.push({ parentId: channel.id, forkId: id });
      const clean = storableChannel(channel);
      const secret = (row: typeof channel) => JSON.stringify([row.auth, row.headers]);
      if (secret(clean) !== secret(channel))
        result.skipped.push({
          what: "canal",
          detail: `${channel.name}: llega sin sus secretos, hay que volver a escribirlos`,
        });
      await this.channels.save({
        ...clean,
        id,
        projectId,
        createdAt: now,
        updatedAt: now,
        updatedBy: actorId,
        deletedAt: null,
      });
      const files = contents.channelProtos[channel.id];
      if (files?.length) await this.protos.replace(id, files);
    }
    result.copied.channels = contents.channels.length;
    return ids;
  }

  /** El destino y sus variables, sin nada que sea un secreto. Devuelve id del original → id nuevo. */
  private async copyEnvironments(
    contents: Contents,
    projectId: string,
    now: Date,
    lineage: Lineage,
    result: ForkCreatedView,
  ): Promise<Map<string, string>> {
    const ids = new Map<string, string>();
    for (const environment of contents.environments) {
      const id = randomUUID();
      ids.set(environment.id, id);
      lineage.environment.push({ parentId: environment.id, forkId: id });
      const active = withoutSecrets(environment.variables);
      const parked = withoutSecrets(environment.disabledVariables);
      const emptied = [...new Set([...active.emptied, ...parked.emptied])];
      await this.environments.save({
        ...environment,
        id,
        projectId,
        variables: active.variables,
        disabledVariables: parked.variables,
        // Respuestas sobre *ese* destino, no sobre este: una bifurcación que llega con escrituras
        // permitidas es una cuya primera corrida podría ser la que lo descubre.
        writesAllowed: false,
        authEnforced: false,
        createdAt: now,
      });
      if (emptied.length)
        result.skipped.push({
          what: "secreto",
          detail: `${environment.name}: hay que volver a escribir ${emptied.join(", ")}`,
        });
      const credentials = await this.environments.listCredentials(environment.id);
      if (credentials.length) {
        const roles = credentials.map((credential) => credential.role).join(", ");
        result.skipped.push({
          what: "credencial",
          detail: `${environment.name}: hay que volver a crear las de ${roles}`,
        });
      }
    }
    result.copied.environments = contents.environments.length;
    return ids;
  }
}

/** El tipo y la parte que no es secreta; el secreto cifrado se queda en el original. */
function withoutProjectSecret(auth: StoredProjectAuth): { auth: StoredProjectAuth; emptied: boolean } {
  const secretFields = auth.settings.secretFields ?? [];
  return {
    auth: { type: auth.type, settings: { ...auth.settings, secretFields: [] }, secretCiphertext: null },
    emptied: secretFields.length > 0 || auth.secretCiphertext !== null,
  };
}
