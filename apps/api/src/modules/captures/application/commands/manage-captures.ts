/**
 * Abrir, parar y borrar sesiones de captura, e importar lo capturado.
 *
 * Abrir devuelve **el token en claro una vez**, como crear un mock privado o un token de API: de él
 * se guarda el hash. Y una sesión por proyecto: abrir otra cierra la anterior (`replaced`), porque
 * dos sesiones vivas son dos tokens válidos y una captura partida en dos listas.
 *
 * Importar **no tiene lector propio**. Lo elegido se escribe como un HAR y entra por
 * `ImportAnythingCommand`, la misma puerta que un HAR soltado en el diálogo: el mismo filtro de
 * ruido, la misma ruta repetida convertida en ejemplo, la misma credencial sin valor y el mismo
 * resumen. El flujo, cuando se pide, entra por el importador de flujos de Postman.
 */
import { randomUUID } from "node:crypto";
import { Inject } from "@nestjs/common";
import { CommandBus, CommandHandler, type ICommand, type ICommandHandler } from "@nestjs/cqrs";
import type {
  CaptureSessionView,
  CaptureStartedView,
  ImportAnythingResult,
  PostmanFlowsImportResult,
} from "@eq/contracts";

import { CLOCK, type ClockPort } from "@/shared/clock/clock.port";
import { generateOpaqueToken, hashOpaqueToken } from "@/shared/crypto/opaque-token";
import { InvalidInputError, NotFoundError } from "@/shared/errors/domain-error";
import { PROJECT_REPOSITORY, type ProjectRepositoryPort } from "@/modules/projects/domain/ports";
import { writableProject } from "@/modules/endpoints/application/commands/manage-endpoints";
import { ImportAnythingCommand } from "@/modules/projects/application/commands/import-anything";
import { ImportPostmanFlowsCommand } from "@/modules/workflows/application/commands/import-postman-flows";
import {
  ENCRYPTED_NOTE,
  captureToFlowCollection,
  captureToHar,
  viewCaptureSession,
  type CaptureSession,
} from "../../domain/model";
import { CAPTURE_REPOSITORY, type CaptureRepositoryPort } from "../../domain/ports";
import { CaptureAuthority } from "../../infrastructure/capture-authority";
import { CAPTURE_PROXY_USERNAME, CaptureProxyService, disabled } from "../../infrastructure/capture-proxy.service";

/** Cuántas peticiones se importan de una vez. Es el tope de una sesión por omisión. */
export const MAX_IMPORT_ITEMS = 500;

export class StartCaptureCommand implements ICommand {
  constructor(
    readonly organizationId: string,
    readonly projectId: string,
    readonly actorId: string,
    readonly input: { decryptHttps?: boolean } = {},
  ) {}
}

@CommandHandler(StartCaptureCommand)
export class StartCaptureHandler implements ICommandHandler<StartCaptureCommand, CaptureStartedView> {
  constructor(
    @Inject(PROJECT_REPOSITORY) private readonly projects: ProjectRepositoryPort,
    @Inject(CAPTURE_REPOSITORY) private readonly captures: CaptureRepositoryPort,
    @Inject(CLOCK) private readonly clock: ClockPort,
    private readonly proxy: CaptureProxyService,
    private readonly authority: CaptureAuthority,
  ) {}

  async execute(command: StartCaptureCommand): Promise<CaptureStartedView> {
    const project = await writableProject(this.projects, command.organizationId, command.projectId);
    if (!this.proxy.enabled) throw disabled();
    const decryptHttps = command.input.decryptHttps === true;
    // Antes de tocar nada: pedir descifrar sin que el despliegue lo permita, o sin una CA que se
    // pueda usar, es un error con el motivo, y no una sesión que en silencio no descifra.
    if (decryptHttps) await this.authority.ensure();

    // Una por proyecto: la que siguiera abierta se cierra antes de dar un token nuevo.
    for (const previous of await this.captures.listSessions(project.id, 20)) {
      if (previous.status !== "active") continue;
      await this.proxy.stop(previous, "replaced");
    }

    const token = generateOpaqueToken();
    const now = this.clock.now();
    const limits = this.proxy.limits();
    const session: CaptureSession = {
      id: randomUUID(),
      projectId: project.id,
      status: "active",
      tokenHash: hashOpaqueToken(token),
      limits,
      itemCount: 0,
      startedAt: now,
      expiresAt: new Date(now.getTime() + limits.durationMs),
      stoppedAt: null,
      stopReason: null,
      startedBy: command.actorId,
      decryptHttps,
    };
    await this.captures.saveSession(session);
    let port: number;
    try {
      port = await this.proxy.open(session);
    } catch (error) {
      // Una sesión que no llegó a escuchar no queda «activa» en la lista.
      await this.captures.stopSession(session.projectId, session.id, "manual", now);
      throw error;
    }
    return {
      session: viewCaptureSession(session),
      token,
      proxy: { host: this.proxy.publicHost, port, username: CAPTURE_PROXY_USERNAME },
    };
  }
}

export class StopCaptureCommand implements ICommand {
  constructor(
    readonly organizationId: string,
    readonly projectId: string,
    readonly sessionId: string,
  ) {}
}

@CommandHandler(StopCaptureCommand)
export class StopCaptureHandler implements ICommandHandler<StopCaptureCommand, CaptureSessionView> {
  constructor(
    @Inject(PROJECT_REPOSITORY) private readonly projects: ProjectRepositoryPort,
    @Inject(CAPTURE_REPOSITORY) private readonly captures: CaptureRepositoryPort,
    private readonly proxy: CaptureProxyService,
  ) {}

  async execute(command: StopCaptureCommand): Promise<CaptureSessionView> {
    const project = await writableProject(this.projects, command.organizationId, command.projectId);
    const current = await this.captures.findSession(project.id, command.sessionId);
    if (!current) throw notFound();
    // Parar dos veces no es un error: el segundo «Parar» llega de una pantalla que no se enteró.
    if (current.status !== "active") return viewCaptureSession(current);

    // Cierra con un `UPDATE` condicional: si el proxy la cerró antes por el tope, se queda ese motivo.
    await this.proxy.stop(current, "manual");
    // Se relee después: la cuenta de lo capturado la ha ido subiendo el proxy, en esta instancia o en otra.
    return viewCaptureSession((await this.captures.findSession(project.id, current.id)) ?? current);
  }
}

export class DeleteCaptureCommand implements ICommand {
  constructor(
    readonly organizationId: string,
    readonly projectId: string,
    readonly sessionId: string,
  ) {}
}

/**
 * Borrar una sesión y todo lo que grabó.
 *
 * Una captura es tráfico real de alguien, tapado pero con sus datos: nombres, correos,
 * identificadores. Quien la hizo tiene que poder quitarla sin esperar a ninguna retención.
 */
@CommandHandler(DeleteCaptureCommand)
export class DeleteCaptureHandler implements ICommandHandler<DeleteCaptureCommand, void> {
  constructor(
    @Inject(PROJECT_REPOSITORY) private readonly projects: ProjectRepositoryPort,
    @Inject(CAPTURE_REPOSITORY) private readonly captures: CaptureRepositoryPort,
    private readonly proxy: CaptureProxyService,
  ) {}

  async execute(command: DeleteCaptureCommand): Promise<void> {
    const project = await writableProject(this.projects, command.organizationId, command.projectId);
    const current = await this.captures.findSession(project.id, command.sessionId);
    if (!current) throw notFound();
    await this.proxy.stop(current, "manual");
    await this.captures.removeSession(project.id, current.id);
  }
}

export class ImportCaptureCommand implements ICommand {
  constructor(
    readonly organizationId: string,
    readonly projectId: string,
    readonly sessionId: string,
    readonly input: { itemIds: string[]; flow?: boolean },
    readonly actorId: string,
  ) {}
}

@CommandHandler(ImportCaptureCommand)
export class ImportCaptureHandler implements ICommandHandler<ImportCaptureCommand, ImportAnythingResult> {
  constructor(
    private readonly commandBus: CommandBus,
    @Inject(PROJECT_REPOSITORY) private readonly projects: ProjectRepositoryPort,
    @Inject(CAPTURE_REPOSITORY) private readonly captures: CaptureRepositoryPort,
    @Inject(CLOCK) private readonly clock: ClockPort,
    private readonly proxy: CaptureProxyService,
  ) {}

  async execute(command: ImportCaptureCommand): Promise<ImportAnythingResult> {
    const { organizationId, projectId, actorId } = command;
    const project = await writableProject(this.projects, organizationId, projectId);
    const session = await this.captures.findSession(project.id, command.sessionId);
    if (!session) throw notFound();
    // Lo que el proxy acaba de grabar puede estar todavía en la cola.
    await this.proxy.flush(session.id);

    const ids = [...new Set(command.input.itemIds)].slice(0, MAX_IMPORT_ITEMS);
    const items = await this.captures.findItems(project.id, session.id, ids);
    if (!items.length) {
      throw new InvalidInputError(
        "No hay nada que importar",
        [{ field: "itemIds", detail: "Elige alguna de las peticiones capturadas" }],
        "nothing-to-import",
      );
    }
    const tunnels = items.filter((item) => item.encrypted);
    const readable = items.filter((item) => !item.encrypted);
    if (!readable.length) {
      throw new InvalidInputError(
        "Lo elegido son túneles HTTPS, y de un túnel no se sabe más que el destino",
        [
          {
            field: "itemIds",
            detail: `${tunnels.length} ${tunnels.length === 1 ? "túnel" : "túneles"}: ${ENCRYPTED_NOTE}`,
          },
        ],
        "capture-only-tunnels",
      );
    }

    const stamp = this.clock.now().toISOString().slice(0, 16).replace("T", " ");
    const result = await this.commandBus.execute<ImportAnythingCommand, ImportAnythingResult>(
      new ImportAnythingCommand(
        organizationId,
        project.id,
        { sources: [{ name: `captura ${stamp}.har`, text: captureToHar(readable) }] },
        actorId,
      ),
    );

    const item = result.items[0];
    if (item && tunnels.length) {
      const endpoints = item.results.find((entry) => entry.target === "endpoints");
      const note = `${tunnels.length} ${tunnels.length === 1 ? "túnel HTTPS no se importa" : "túneles HTTPS no se importan"}: ${ENCRYPTED_NOTE}`;
      if (endpoints) endpoints.notes = [...(endpoints.notes ?? []), note];
    }

    if (command.input.flow && item) {
      const flow = captureToFlowCollection(`Captura ${stamp}`, readable);
      if (!flow.steps) {
        item.results.push({
          target: "flows",
          name: `Captura ${stamp}`,
          summary: null,
          error: "Ninguna de las peticiones elegidas es de la API: el flujo quedaría vacío",
        });
      } else {
        try {
          const flows = await this.commandBus.execute<ImportPostmanFlowsCommand, PostmanFlowsImportResult>(
            new ImportPostmanFlowsCommand(organizationId, project.id, { text: flow.text }, actorId),
          );
          item.results.push({
            target: "flows",
            name: `Captura ${stamp}`,
            summary: flows.flows
              .map(
                (entry) =>
                  `${entry.name} (${entry.action === "created" ? "nuevo" : "actualizado"}, ${entry.steps} nodos)`,
              )
              .join(" · "),
            error: null,
            notes: flows.notes,
          });
        } catch (error) {
          item.results.push({
            target: "flows",
            name: `Captura ${stamp}`,
            summary: null,
            error: error instanceof Error ? error.message : "No se pudo crear el flujo",
          });
        }
      }
    }
    return result;
  }
}

const notFound = () => new NotFoundError("Esa sesión de captura no existe", "capture-not-found");

export const CAPTURE_COMMAND_HANDLERS = [
  StartCaptureHandler,
  StopCaptureHandler,
  DeleteCaptureHandler,
  ImportCaptureHandler,
];
