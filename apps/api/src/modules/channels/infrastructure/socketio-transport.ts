/**
 * El transporte de un canal Socket.IO: el único fichero del módulo que sabe que existe
 * `socket.io-client`.
 *
 * Un puerto, como `mqtt-transport.ts` y por lo mismo: las pruebas pueden sustituirlo, y lo que solo
 * existe con bytes de verdad —el `CONNECT` del espacio de nombres, el acuse, la guarda— se prueba
 * contra un servidor `socket.io` en proceso.
 *
 * Como el de MQTT, entrega **tramas** y no bytes: un mensaje Socket.IO es un evento con nombre y
 * argumentos, y traducirlo a la transcripción es cosa del que sabe Socket.IO. Quien abre la sesión
 * solo les pone la hora y las pasa a `applyFrame`: redactar, recortar y contar siguen en un solo
 * sitio. Lo que en Socket.IO pasa sin ser un mensaje —conectar, el rechazo del `CONNECT`,
 * desconectar, un acuse que no llega— entra como un `event` con el nombre que le da la biblioteca.
 */
import { Inject, Injectable } from "@nestjs/common";
import type { Socket } from "socket.io-client";

import { ENV, type Env } from "@/shared/config/env";
import { policyFromEnv } from "@/shared/http/safe-fetch.provider";
import { openSafeSocketIo } from "@/shared/http/safe-socketio";
import { argsBody, type SocketIoSessionPlan } from "../domain/socketio";
import type { TimelessFrame } from "./mqtt-transport";
import type { OpenChannel } from "./ws-transport";

export const SOCKETIO_TRANSPORT = Symbol("SOCKETIO_TRANSPORT");

/**
 * Lo que cabe en un mensaje de Engine.IO además de los argumentos: el tipo de paquete, el espacio de
 * nombres, el nombre del evento y el id del acuse. El tope del canal habla de lo que la transcripción
 * enseña; el de la biblioteca lo deja pasar con esto.
 */
export const PACKET_OVERHEAD_BYTES = 4 * 1024;

export type SocketIoOpenOptions = SocketIoSessionPlan & {
  headers: Record<string, string>;
  maxMessageBytes: number;
  connectTimeoutMs: number;
  /** Cuánto se espera un acuse antes de anotar que no llegó. */
  ackTimeoutMs: number;
};

export interface SocketIoTransportPort {
  open(url: string, options: SocketIoOpenOptions, emit: (frame: TimelessFrame) => void): Promise<OpenChannel>;
}

@Injectable()
export class SocketIoChannelTransport implements SocketIoTransportPort {
  constructor(@Inject(ENV) private readonly env: Env) {}

  async open(url: string, options: SocketIoOpenOptions, emit: (frame: TimelessFrame) => void): Promise<OpenChannel> {
    let opened = false;
    const { socket } = await openSafeSocketIo(
      url,
      policyFromEnv(this.env),
      {
        path: options.path,
        namespace: options.namespace,
        auth: options.auth,
        query: options.query,
        headers: options.headers,
        transports: options.transports,
        maxPayload: options.maxMessageBytes + PACKET_OVERHEAD_BYTES,
        connectTimeoutMs: options.connectTimeoutMs,
      },
      (socket) => {
        // La apertura, en la misma escucha que el `CONNECT` y antes que nada: un servidor que emite en
        // su `connection` lo manda detrás del `CONNECT` en el mismo paquete, y la apertura anotada al
        // resolver la promesa llegaría **después** de ese primer evento.
        socket.on("connect", () => {
          opened = true;
          emit({ direction: "open" });
          emit({ direction: "event", event: "connect", body: `conectado a ${options.namespace}` });
        });
        socket.on("connect_error", (error: Error & { data?: unknown }) => {
          // Antes de abrir: la promesa se rechaza con el motivo, y esto deja el motivo y la `data` del
          // servidor en la transcripción, tapados como cualquier otro mensaje.
          const data = error.data === undefined ? "" : ` ${argsBody([error.data])}`;
          emit({ direction: "event", event: "connect_error", body: `${error.message}${data}` });
        });
        socket.on("disconnect", (reason: string) => {
          if (!opened) return;
          emit({ direction: "event", event: "disconnect", body: reason });
          emit({ direction: "close", closeReason: reason });
        });
        const incoming = (event: string, args: unknown[]) => emit(inFrame(event, args));
        if (options.listenAll) socket.onAny((event: string, ...args: unknown[]) => incoming(event, args));
        else for (const event of options.events) socket.on(event, (...args: unknown[]) => incoming(event, args));
      },
    );

    return {
      handshake: undefined,
      send: () => {
        // `registry.send` lleva un canal Socket.IO por `emit`: llegar aquí es un error del programa.
        throw new Error("En Socket.IO se emite un evento con nombre");
      },
      emit: (event, args, ack) => emitWith(socket, event, args, ack, options.ackTimeoutMs, emit),
      close: () => {
        socket.disconnect();
      },
    };
  }
}

/**
 * Un evento recibido, como trama. Un servidor que pide acuse (`socket.emit("x", data, cb)`) trae una
 * función al final: no se contesta —nadie ha escrito qué contestar— y no entra en el cuerpo.
 */
function inFrame(event: string, args: unknown[]): TimelessFrame {
  const body = argsBody(args.filter((arg) => typeof arg !== "function"));
  return { direction: "in", kind: "text", event, body, bytes: Buffer.byteLength(body, "utf8") };
}

/**
 * Emitir, y si se pidió, esperar el acuse con plazo. El acuse entra como **recibido** del mismo
 * evento, con `ack`; uno que no llega a tiempo, como un `event` que lo dice —no es un error de la
 * conexión, y cerrar la sesión por él sería perder lo que sí llegó—.
 */
function emitWith(
  socket: Socket,
  event: string,
  args: unknown[],
  ack: boolean,
  timeoutMs: number,
  emit: (frame: TimelessFrame) => void,
): void {
  if (!ack) {
    socket.emit(event, ...args);
    return;
  }
  socket.timeout(timeoutMs).emit(event, ...args, (error: Error | null, ...response: unknown[]) => {
    if (error) {
      emit({ direction: "event", event, body: `sin acuse de ${event} en ${timeoutMs} ms` });
      return;
    }
    emit({ ...inFrame(event, response), ack: true });
  });
}
