/**
 * Los canales de un proyecto, y sus sesiones.
 *
 * Leer es `viewer`; crear, abrir, mandar y cerrar es `editor`, como con un endpoint: abrir un socket
 * contra un entorno y mandarle mensajes es tan capaz de cambiar cosas como un `POST`.
 *
 * Las rutas de una sesión cuelgan de `channels/sessions/:sessionId` y no del canal: una sesión se
 * sigue, se recarga y se cierra por su id, y quien vuelve a ella desde un enlace no tiene por qué
 * saber de qué canal era.
 */
import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Sse, UseGuards } from "@nestjs/common";
import { CommandBus, QueryBus } from "@nestjs/cqrs";
import { SkipThrottle } from "@nestjs/throttler";
import { Observable } from "rxjs";

import {
  CurrentUser,
  OrgRoleGuard,
  RequireRole,
  type Principal,
} from "@/modules/auth/infrastructure/guards/auth.guard";
import { ConflictError } from "@/shared/errors/domain-error";
import {
  CreateChannelCommand,
  DeleteChannelCommand,
  UpdateChannelCommand,
} from "../application/commands/manage-channels";
import {
  ChangeChannelSubscriptionCommand,
  CloseChannelSessionCommand,
  OpenChannelSessionCommand,
  SendChannelMessageCommand,
} from "../application/commands/manage-sessions";
import { GetChannelQuery, GetChannelSessionQuery, ListChannelsQuery } from "../application/queries/read-channels";
import type { ChannelSessionView } from "../application/views";
import { ChannelProgressStream } from "../infrastructure/channel-progress.stream";
import {
  ChannelSubscriptionDto,
  CreateChannelDto,
  OpenChannelSessionDto,
  SendChannelMessageDto,
  UpdateChannelDto,
} from "./dto/channels.dto";

const actorId = (principal: Principal): string => (principal.kind === "user" ? principal.userId : principal.tokenId);

@Controller("orgs/:organizationId/projects/:projectId/channels")
@UseGuards(OrgRoleGuard)
export class ChannelsController {
  constructor(
    private readonly commandBus: CommandBus,
    private readonly queryBus: QueryBus,
    private readonly progress: ChannelProgressStream,
  ) {}

  @Get()
  @RequireRole("viewer")
  list(@Param("organizationId") organizationId: string, @Param("projectId") projectId: string) {
    return this.queryBus.execute(new ListChannelsQuery(organizationId, projectId));
  }

  @Post()
  @RequireRole("editor")
  create(
    @Param("organizationId") organizationId: string,
    @Param("projectId") projectId: string,
    @Body() body: CreateChannelDto,
    @CurrentUser() principal: Principal,
  ) {
    return this.commandBus.execute(new CreateChannelCommand(organizationId, projectId, body, actorId(principal)));
  }

  @Get("sessions/:sessionId")
  @RequireRole("viewer")
  session(
    @Param("organizationId") organizationId: string,
    @Param("projectId") projectId: string,
    @Param("sessionId") sessionId: string,
  ) {
    return this.queryBus.execute(new GetChannelSessionQuery(organizationId, projectId, sessionId));
  }

  @Post("sessions/:sessionId/messages")
  @RequireRole("editor")
  @HttpCode(202)
  async send(
    @Param("organizationId") organizationId: string,
    @Param("projectId") projectId: string,
    @Param("sessionId") sessionId: string,
    @Body() body: SendChannelMessageDto,
  ) {
    // El tema, la QoS y el `retain` solo existen en MQTT; en un WebSocket no se mandan y no viajan.
    const publish =
      body.topic !== undefined
        ? {
            topic: body.topic,
            qos: body.qos ?? 0,
            retain: body.retain ?? false,
            ...(body.userProperties !== undefined ? { userProperties: body.userProperties } : {}),
          }
        : undefined;
    await this.commandBus.execute(
      new SendChannelMessageCommand(organizationId, projectId, sessionId, body.text, publish),
    );
    return { accepted: true };
  }

  /**
   * Suscribirse a mitad de sesión. Un no del broker **no** es un error de la API: es un 200 con
   * `granted: null` y el motivo, y queda en la transcripción como un evento.
   */
  @Post("sessions/:sessionId/subscribe")
  @RequireRole("editor")
  @HttpCode(200)
  subscribe(
    @Param("organizationId") organizationId: string,
    @Param("projectId") projectId: string,
    @Param("sessionId") sessionId: string,
    @Body() body: ChannelSubscriptionDto,
  ) {
    return this.commandBus.execute(
      new ChangeChannelSubscriptionCommand(
        organizationId,
        projectId,
        sessionId,
        "subscribe",
        body.topic,
        body.qos ?? 0,
      ),
    );
  }

  @Post("sessions/:sessionId/unsubscribe")
  @RequireRole("editor")
  @HttpCode(200)
  unsubscribe(
    @Param("organizationId") organizationId: string,
    @Param("projectId") projectId: string,
    @Param("sessionId") sessionId: string,
    @Body() body: ChannelSubscriptionDto,
  ) {
    return this.commandBus.execute(
      new ChangeChannelSubscriptionCommand(organizationId, projectId, sessionId, "unsubscribe", body.topic),
    );
  }

  @Post("sessions/:sessionId/close")
  @RequireRole("editor")
  @HttpCode(200)
  close(
    @Param("organizationId") organizationId: string,
    @Param("projectId") projectId: string,
    @Param("sessionId") sessionId: string,
  ) {
    return this.commandBus.execute(new CloseChannelSessionCommand(organizationId, projectId, sessionId));
  }

  /**
   * La conversación en vivo.
   *
   * Abre con la **sesión entera** —la transcripción hasta ahora— y sigue con los mensajes según
   * llegan: quien recarga ve lo que ya pasó y lo que pase después, sin un hueco entre las dos cosas
   * y sin repetir ninguno (ver dentro: se escucha antes de leer, y se descarta por `seq`).
   * Una sesión ya terminada contesta con la transcripción y `finished`, y el stream se cierra; es la
   * misma regla que el de una corrida, y por el mismo motivo: sin ella, quien llega tarde se queda
   * esperando un evento que no va a llegar.
   *
   * Una sesión viva **en otra instancia** es un 409 y no un stream vacío. Su socket es un descriptor
   * de otro proceso; un stream desde aquí no emitiría nunca, y parecería una sesión callada.
   */
  @Sse("sessions/:sessionId/stream")
  @SkipThrottle()
  @RequireRole("viewer")
  async stream(
    @Param("organizationId") organizationId: string,
    @Param("projectId") projectId: string,
    @Param("sessionId") sessionId: string,
  ): Promise<Observable<{ data: unknown; type: string }>> {
    // **Se escucha antes de leer.** Con `concat(instantánea, en vivo)` la suscripción a lo vivo llega
    // cuando la lectura ya terminó, y un mensaje que entra mientras tanto no está ni en la
    // instantánea ni en el stream. Así, lo que llega durante la lectura se retiene y se suelta
    // después, descartando por `seq` lo que la instantánea ya traía.
    const held: { data: unknown; type: string }[] = [];
    let forward: ((event: { data: unknown; type: string }) => void) | null = null;
    const live = this.progress
      .forSession(sessionId)
      .subscribe((event) => (forward ? forward(event) : held.push(event)));

    // Y se lee **antes** de devolver el stream, para que los dos «no» sean respuestas de verdad: una
    // vez devuelto, las cabeceras del SSE ya salieron con 200 y un 409 no llegaría como tal.
    let session: ChannelSessionView;
    try {
      session = await this.queryBus.execute<GetChannelSessionQuery, ChannelSessionView>(
        new GetChannelSessionQuery(organizationId, projectId, sessionId),
      );
    } catch (error) {
      live.unsubscribe();
      throw error;
    }
    const over = session.status === "closed" || session.status === "error";
    if (!over && !session.live) {
      live.unsubscribe();
      throw new ConflictError(
        "Esta sesión está abierta en otra instancia de la API, y su socket no se puede seguir desde aquí",
        "channel-session-not-here",
      );
    }

    return new Observable((subscriber) => {
      if (over) {
        live.unsubscribe();
        subscriber.next({ type: "finished", data: session });
        subscriber.complete();
        return;
      }
      let lastSeq = Math.max(-1, ...(session.messages ?? []).map((message) => message.seq));
      const emit = (event: { data: unknown; type: string }) => {
        if (event.type === "message") {
          const seq = (event.data as { message: { seq: number } }).message.seq;
          if (seq <= lastSeq) return;
          lastSeq = seq;
        }
        subscriber.next(event);
        if (event.type === "finished") subscriber.complete();
      };
      subscriber.next({ type: "snapshot", data: session });
      forward = emit;
      for (const event of held.splice(0)) emit(event);
      return () => live.unsubscribe();
    });
  }

  @Get(":channelId")
  @RequireRole("viewer")
  get(
    @Param("organizationId") organizationId: string,
    @Param("projectId") projectId: string,
    @Param("channelId") channelId: string,
  ) {
    return this.queryBus.execute(new GetChannelQuery(organizationId, projectId, channelId));
  }

  @Patch(":channelId")
  @RequireRole("editor")
  update(
    @Param("organizationId") organizationId: string,
    @Param("projectId") projectId: string,
    @Param("channelId") channelId: string,
    @Body() body: UpdateChannelDto,
    @CurrentUser() principal: Principal,
  ) {
    return this.commandBus.execute(
      new UpdateChannelCommand(organizationId, projectId, channelId, body, actorId(principal)),
    );
  }

  @Delete(":channelId")
  @RequireRole("editor")
  @HttpCode(204)
  async remove(
    @Param("organizationId") organizationId: string,
    @Param("projectId") projectId: string,
    @Param("channelId") channelId: string,
    @CurrentUser() principal: Principal,
  ): Promise<void> {
    await this.commandBus.execute(new DeleteChannelCommand(organizationId, projectId, channelId, actorId(principal)));
  }

  @Post(":channelId/sessions")
  @RequireRole("editor")
  open(
    @Param("organizationId") organizationId: string,
    @Param("projectId") projectId: string,
    @Param("channelId") channelId: string,
    @Body() body: OpenChannelSessionDto,
    @CurrentUser() principal: Principal,
  ) {
    return this.commandBus.execute(
      new OpenChannelSessionCommand(
        organizationId,
        projectId,
        channelId,
        body.environmentId ?? null,
        actorId(principal),
      ),
    );
  }
}
