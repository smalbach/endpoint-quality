/**
 * El transporte de un canal MQTT: el único fichero del módulo que sabe que existe `mqtt.js`.
 *
 * Un puerto, como `ws-transport.ts` y por lo mismo: las pruebas pueden sustituirlo, y lo que solo
 * existe con bytes de verdad —el `CONNACK`, el `SUBACK`, el tope de paquete— se prueba contra
 * `safe-mqtt.ts` y un broker en proceso.
 *
 * La diferencia con el de WebSocket está en la firma de las escuchas: aquí el transporte entrega
 * **tramas** (`RawFrame` sin la hora) y no bytes, porque un mensaje MQTT trae tema, QoS y `retain`,
 * y traducirlo es cosa del que sabe MQTT. Quien abre la sesión solo le pone la hora y lo pasa a
 * `applyFrame`, como cualquier otra trama: redactar, recortar y contar siguen en un solo sitio.
 */
import { Inject, Injectable } from "@nestjs/common";
import type { RawFrame } from "@eq/runner-core";

import { ENV, type Env } from "@/shared/config/env";
import { policyFromEnv } from "@/shared/http/safe-fetch.provider";
import { openSafeMqtt } from "@/shared/http/safe-mqtt";
import type { MqttPublish, MqttSessionPlan } from "../domain/mqtt";
import type { OpenChannel } from "./ws-transport";

export const MQTT_TRANSPORT = Symbol("MQTT_TRANSPORT");

/**
 * Lo que cabe en un paquete además del cuerpo: el tema (hasta 64 KB en teoría, unos cientos de
 * bytes en la práctica), el id del paquete y las propiedades de 5.0. El tope por mensaje del canal
 * habla del **cuerpo**, que es lo que la transcripción enseña; el de paquete lo deja pasar con esto.
 */
export const PACKET_OVERHEAD_BYTES = 4 * 1024;

/** Una trama sin la hora: la hora la pone quien lleva el reloj de la sesión. */
export type TimelessFrame = Omit<RawFrame, "atMs">;

export type MqttOpenOptions = MqttSessionPlan & { maxMessageBytes: number; connectTimeoutMs: number };

export interface MqttTransportPort {
  open(url: string, options: MqttOpenOptions, emit: (frame: TimelessFrame) => void): Promise<OpenChannel>;
}

@Injectable()
export class MqttChannelTransport implements MqttTransportPort {
  constructor(@Inject(ENV) private readonly env: Env) {}

  async open(url: string, options: MqttOpenOptions, emit: (frame: TimelessFrame) => void): Promise<OpenChannel> {
    const { client, handshake } = await openSafeMqtt(
      url,
      policyFromEnv(this.env),
      {
        protocolVersion: options.version,
        clientId: options.clientId,
        keepaliveSec: options.keepaliveSec,
        clean: options.cleanSession,
        username: options.username,
        password: options.password,
        subscriptions: options.subscriptions,
        maxPacketBytes: options.maxMessageBytes + PACKET_OVERHEAD_BYTES,
        connectTimeoutMs: options.connectTimeoutMs,
      },
      {
        onOpen: (opened) => emit({ direction: "open", handshake: opened }),
        onMessage: ({ topic, payload, qos, retain }) =>
          emit({
            direction: "in",
            // Un cuerpo MQTT son bytes sin tipo: se lee como texto si lo es, y como hexadecimal de lo
            // que quepa si no, igual que un mensaje binario de un WebSocket.
            ...(isText(payload)
              ? { kind: "text" as const, body: payload.toString("utf8") }
              : { kind: "binary" as const, body: payload.subarray(0, 256).toString("hex") }),
            bytes: payload.byteLength,
            topic,
            qos,
            retain,
          }),
        onClose: (reason) => emit({ direction: "close", closeReason: reason }),
        onError: (error) => emit({ direction: "error", body: error.message }),
      },
    );
    return {
      handshake,
      send: (text, publish?: MqttPublish) => {
        if (!publish) throw new Error("En MQTT se publica en un tema");
        client.publish(publish.topic, text, { qos: publish.qos, retain: publish.retain }, (error) => {
          // Un PUBACK con código de error (5.0) o un corte a medio publicar: se cuenta en la sesión.
          if (error) emit({ direction: "error", body: `no se pudo publicar: ${error.message}` });
        });
      },
      // Un DISCONNECT de verdad y no cortar el TCP: el broker lo distingue, y con un corte publicaría
      // el testamento del cliente como si se hubiera caído.
      close: () => {
        client.end(false);
      },
    };
  }
}

/**
 * Si el cuerpo es texto: UTF-8 que vuelve a dar los mismos bytes, y sin caracteres de control que
 * no sean espacios (tabulador, saltos de línea). Se mira byte a byte: en UTF-8 un byte por debajo de
 * 0x20 solo puede ser ese carácter.
 */
function isText(payload: Buffer): boolean {
  if (!Buffer.from(payload.toString("utf8"), "utf8").equals(payload)) return false;
  return payload.every((byte) => byte >= 0x20 || (byte >= 0x09 && byte <= 0x0d));
}
