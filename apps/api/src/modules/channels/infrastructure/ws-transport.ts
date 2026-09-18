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

export const CHANNEL_TRANSPORT = Symbol("CHANNEL_TRANSPORT");

/** Un socket abierto, visto desde la sesión: mandar y cerrar. Lo demás llega por las escuchas. */
export type OpenChannel = {
  handshake: { status: number; headers: Record<string, string> };
  send(text: string): void;
  close(code: number, reason: string): void;
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
