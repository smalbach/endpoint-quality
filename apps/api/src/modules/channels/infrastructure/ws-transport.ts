/**
 * El transporte de un canal: el único fichero del módulo que sabe que existe `ws`.
 *
 * Un puerto y no una llamada directa a `openSafeSocket` por lo mismo que `SAFE_FETCH` es un puerto:
 * las pruebas de la API sustituyen este proveedor por uno guionizado, y así los topes, la
 * redacción, las tramas en vivo y los permisos se prueban sin abrir un puerto. Lo que solo existe
 * con bytes de verdad —el framing, el 401 del upgrade— se prueba contra `safe-socket.ts` en
 * loopback.
 */
import { Inject, Injectable } from "@nestjs/common";

import { ENV, type Env } from "@/shared/config/env";
import { policyFromEnv } from "@/shared/http/safe-fetch.provider";
import { openSafeSocket, type SafeSocketOptions, type SocketListeners } from "@/shared/http/safe-socket";
import type { MqttPublish } from "../domain/mqtt";

export const CHANNEL_TRANSPORT = Symbol("CHANNEL_TRANSPORT");

/**
 * Un socket abierto, visto desde la sesión: mandar y cerrar. Lo demás llega por las escuchas.
 *
 * `publish` solo lo lleva un canal MQTT (tema, QoS, `retain`); un WebSocket lo ignora.
 */
export type OpenChannel = {
  handshake?: { status: number; headers: Record<string, string>; via?: string };
  send(text: string, publish?: MqttPublish): void;
  close(code: number, reason: string): void;
  /**
   * Si el protocolo puede mandar este texto, **antes** de anotarlo: lanza con el motivo si no.
   *
   * Un WebSocket manda cualquier texto y no lo necesita. Una llamada gRPC solo manda JSON que encaje
   * con el tipo de entrada, y solo si el método recibe un stream: sin esto, la transcripción tendría
   * un «enviado» que nunca salió.
   */
  check?(text: string): void;
  /** Terminar de mandar sin cerrar: el medio cierre de un stream de gRPC. Quien no lo tiene, no lo trae. */
  end?(): void;
};

/**
 * Lo que la sesión escucha de cualquier protocolo: lo de un socket, más lo que un socket no tiene.
 *
 * - `onSent`: un mensaje que salió **sin** pasar por `send` —la petición de una llamada unaria, que
 *   viaja con la propia llamada— y que la transcripción tiene que contar igual.
 * - Los trailers en el cierre: donde una llamada gRPC dice su estado y lo que quiera añadir.
 * - Una apertura sin handshake: la conexión está hecha aunque el servidor aún no haya contestado.
 */
export type ChannelListeners = Omit<SocketListeners, "onClose" | "onOpen"> & {
  onOpen?: (handshake?: { status: number; headers: Record<string, string>; via?: string }) => void;
  onClose: (code: number, reason: string, trailers?: Record<string, string>) => void;
  onSent?: (text: string) => void;
};

export interface ChannelTransportPort {
  open(url: string, options: SafeSocketOptions, listeners: SocketListeners): Promise<OpenChannel>;
}

@Injectable()
export class WsChannelTransport implements ChannelTransportPort {
  constructor(@Inject(ENV) private readonly env: Env) {}

  async open(url: string, options: SafeSocketOptions, listeners: SocketListeners): Promise<OpenChannel> {
    const { socket, handshake } = await openSafeSocket(url, policyFromEnv(this.env), options, listeners);
    return {
      handshake,
      send: (text) => socket.send(text),
      // `close` y no `terminate`: un cierre con código es lo que el otro lado ve como una despedida,
      // y el código que se manda es parte de lo que la sesión cuenta.
      close: (code, reason) => socket.close(code, reason),
    };
  }
}
