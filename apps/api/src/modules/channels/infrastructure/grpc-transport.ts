/**
 * El transporte de un canal gRPC: el único fichero del módulo que sabe que existe `@grpc/grpc-js`.
 *
 * **La guarda de red, igual que un socket.** Se resuelve y se comprueba la IP con `resolveTarget` —el
 * mismo código, con `grpc:`/`grpcs:` como esquemas pedidos— y se conecta **a esa IP**: el destino de
 * grpc-js es `ipv4:1.2.3.4:443`, que no pregunta al DNS, así que no hay segunda resolución que pueda
 * contestar otra cosa. El nombre sigue viajando donde tiene que viajar:
 *
 * - en `:authority`, con `grpc.default_authority`, que es lo que el servidor usa para enrutar;
 * - en el SNI y en la comprobación del certificado, con `grpc.ssl_target_name_override`. Con él,
 *   grpc-js valida el certificado **contra el nombre** y no contra la IP —ver `checkServerIdentity`
 *   en `channel-credentials.js`—, que es lo que un certificado de verdad nombra. Es el mismo fallo
 *   que tuvo `safe-fetch.ts` al fijar la IP en la URL, y aquí se evita desde el principio.
 *
 * Y tres opciones más que no son de adorno: sin proxy (`grpc.enable_http_proxy: 0`), porque un
 * `https_proxy` en el entorno sería otro camino hacia la red que la guarda no ve; un pool de
 * subcanales propio, para que cerrar la sesión cierre de verdad la conexión; y el tope de mensaje
 * **dentro** de la biblioteca (`grpc.max_receive_message_length`), por lo mismo que `maxPayload` en
 * un WebSocket: el contador de la conversación llega tarde para un mensaje de 1 GB.
 */
import type { EventEmitter } from "node:events";
import { isIP } from "node:net";
import { Inject, Injectable } from "@nestjs/common";
import {
  Client,
  Metadata,
  connectivityState,
  credentials,
  status as grpcStatus,
  type CallOptions,
  type ChannelOptions,
  type ClientDuplexStream,
  type ClientReadableStream,
  type ClientUnaryCall,
  type ClientWritableStream,
  type ServiceError,
  type StatusObject,
} from "@grpc/grpc-js";

import { ENV, type Env } from "@/shared/config/env";
import { ConflictError } from "@/shared/errors/domain-error";
import { policyFromEnv } from "@/shared/http/safe-fetch.provider";
import { resolveTarget, type SafeFetchPolicy } from "@/shared/http/safe-fetch";
import { GRPC_SCHEMES, grpcPort, isBinaryMetadata } from "../domain/grpc";
import type { GrpcSchema, ResolvedMethod } from "../domain/grpc-schema";
import { reflectSchema } from "./grpc-reflection";
import type { ChannelListeners, OpenChannel } from "./ws-transport";

export const GRPC_TRANSPORT = Symbol("GRPC_TRANSPORT");

/** A quién se llama y con qué: ya resuelto contra el entorno por quien llama. */
export type GrpcTarget = {
  /** `grpc://` o `grpcs://`, sin variables. */
  url: string;
  metadata: Record<string, string>;
  /** Cuánto se espera a que la conexión esté lista. */
  connectTimeoutMs: number;
  /** El tope de un mensaje recibido, dentro de la biblioteca. */
  maxMessageBytes: number;
};

/** La llamada: el método ya resuelto y el mensaje ya comprobado. */
export type GrpcCall = {
  method: ResolvedMethod;
  /** El texto de la petición, tal como se anota, y el objeto que viaja. Solo unaria y de servidor. */
  request: { text: string; value: object } | null;
  deadlineMs: number | null;
  /** Texto de un mensaje del stream → objeto que viaja. Lanza con el motivo si no vale. */
  decode(text: string): object;
};

/**
 * La llamada de un canal con reflexión: se sabe qué método es solo después de preguntarle al
 * servidor. Recibe el esquema reflejado y devuelve la llamada, o lanza con el motivo (un método que
 * ya no está, un mensaje que no encaja).
 */
export type GrpcCallFromSchema = (schema: GrpcSchema) => GrpcCall;

export interface GrpcTransportPort {
  /** La definición del servidor, por reflexión. */
  reflect(target: GrpcTarget): Promise<GrpcSchema>;
  /**
   * Invocar. Resuelve cuando la conexión está hecha, y lo demás llega por las escuchas.
   *
   * Con una función en vez de la llamada, primero se refleja **por la misma conexión** y después se
   * invoca: una sesión con reflexión abre una conexión, no dos.
   */
  call(target: GrpcTarget, call: GrpcCall | GrpcCallFromSchema, listeners: ChannelListeners): Promise<OpenChannel>;
}

/**
 * Un cliente conectado a la dirección comprobada.
 *
 * Exportada para poder probarla sola, como `pinnedConnection`: es la función que cierra la ventana
 * de rebinding y la que pone el nombre en el certificado.
 */
export async function pinnedClient(
  rawUrl: string,
  policy: SafeFetchPolicy,
  maxMessageBytes: number,
): Promise<{ client: Client; hostname: string; address: string }> {
  const { url, address, family } = await resolveTarget(rawUrl, policy, { schemes: GRPC_SCHEMES });
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  const port = grpcPort(url);
  const secure = url.protocol === "grpcs:";
  const target = family === 6 ? `ipv6:[${address}]:${port}` : `ipv4:${address}:${port}`;
  const authority = `${isIP(hostname) === 6 ? `[${hostname}]` : hostname}:${port}`;
  const options: ChannelOptions = {
    "grpc.default_authority": authority,
    "grpc.enable_http_proxy": 0,
    "grpc.use_local_subchannel_pool": 1,
    "grpc.max_receive_message_length": maxMessageBytes,
    // Un reintento transparente sería una segunda llamada que la transcripción no cuenta.
    "grpc.enable_retries": 0,
    // A una IP literal no se le manda SNI, y el certificado se comprueba contra la IP, que es lo que
    // se escribió.
    ...(secure && !isIP(hostname) ? { "grpc.ssl_target_name_override": hostname } : {}),
  };
  const client = new Client(target, secure ? credentials.createSsl() : credentials.createInsecure(), options);
  return { client, hostname, address };
}

/**
 * La metadata de la llamada. Las claves viajan en minúsculas: grpc-js las normaliza así.
 *
 * Una clave `-bin` lleva bytes y se escribe en base64 (estándar o URL): aquí se decodifica, y
 * grpc-js la vuelve a codificar para el cable. Mandar el texto tal cual lanzaría dentro de grpc-js.
 */
export function toMetadata(values: Record<string, string>): Metadata {
  const metadata = new Metadata();
  for (const [name, value] of Object.entries(values)) {
    const key = name.toLowerCase();
    metadata.add(key, isBinaryMetadata(key) ? Buffer.from(value.trim(), "base64") : value);
  }
  return metadata;
}

/** La metadata que llegó, plana: los valores repetidos en uno solo, y lo binario en base64. */
export function flatMetadata(metadata: Metadata): Record<string, string> {
  return Object.fromEntries(
    Object.entries(metadata.toJSON()).map(([name, values]) => [
      name,
      values.map((value) => (Buffer.isBuffer(value) ? value.toString("base64") : String(value))).join(", "),
    ]),
  );
}

type AnyCall =
  ClientUnaryCall | ClientReadableStream<object> | ClientWritableStream<object> | ClientDuplexStream<object, object>;

@Injectable()
export class GrpcChannelTransport implements GrpcTransportPort {
  constructor(@Inject(ENV) private readonly env: Env) {}

  async reflect(target: GrpcTarget): Promise<GrpcSchema> {
    const { client } = await pinnedClient(target.url, policyFromEnv(this.env), target.maxMessageBytes);
    try {
      return await reflectSchema(client, toMetadata(target.metadata), target.connectTimeoutMs);
    } finally {
      client.close();
    }
  }

  /**
   * La llamada, con sus cuatro formas y una sola transcripción.
   *
   * **Abrir es «la conexión está lista»**, no «el servidor contestó»: un servidor lento en contestar
   * está conectado, y un `UNIMPLEMENTED` que llega sin cabeceras —solo trailers— también. Lo único
   * que no es una apertura es una llamada que termina **antes** de conectar (`UNAVAILABLE`): eso
   * rechaza, con lo que dijo grpc-js, y la sesión sale en rojo con el motivo.
   *
   * La metadata de la respuesta llega después como una segunda apertura, con cabeceras: la
   * conversación se queda con el primer momento y con las últimas cabeceras.
   */
  async call(
    target: GrpcTarget,
    planned: GrpcCall | GrpcCallFromSchema,
    listeners: ChannelListeners,
  ): Promise<OpenChannel> {
    const { client } = await pinnedClient(target.url, policyFromEnv(this.env), target.maxMessageBytes);
    let call: GrpcCall;
    try {
      // La reflexión por el mismo cliente —la misma conexión HTTP/2— que la llamada: grpc-js
      // multiplexa los dos streams y la sesión abre una sola conexión, contra la misma IP comprobada.
      call =
        typeof planned === "function"
          ? planned(await reflectSchema(client, toMetadata(target.metadata), target.connectTimeoutMs))
          : planned;
    } catch (error) {
      client.close();
      throw error;
    }
    const { definition } = call.method;
    // Los bytes de un mensaje son los del cable: el protobuf serializado, no el JSON que se enseña.
    // Los topes (`maxBytes`, `maxMessageBytes`) y los contadores hablan de lo que viajó —y grpc-js ya
    // corta por el tamaño del cable—; contar el JSON, que con los nombres de campo suele ocupar más,
    // cortaba por «demasiados bytes» una conversación que en el cable cabía.
    const wireSizes = new WeakMap<object, number>();
    const responseDeserialize = (buffer: Buffer): object => {
      const value = definition.responseDeserialize(buffer) as object;
      if (value && typeof value === "object") wireSizes.set(value, buffer.byteLength);
      return value;
    };
    const wireOf = (value: object): number => definition.requestSerialize(value).byteLength;
    const clientStreaming = definition.requestStream;
    const serverStreaming = definition.responseStream;
    const options: CallOptions = call.deadlineMs ? { deadline: Date.now() + call.deadlineMs } : {};
    const metadata = toMetadata(target.metadata);

    return new Promise<OpenChannel>((resolve, reject) => {
      let connected = false;
      let settled = false;
      let finished = false;
      let halfClosed = false;
      let stream: AnyCall | null = null;

      const channel: OpenChannel = {
        check: (text) => {
          if (!clientStreaming)
            throw new ConflictError(
              "Este método no recibe mensajes después de invocarlo: su petición viaja con la llamada",
              "grpc-not-client-streaming",
            );
          if (halfClosed) throw new ConflictError("El envío de este stream ya terminó", "grpc-stream-ended");
          call.decode(text);
        },
        send: (text) => (stream as ClientWritableStream<object>).write(call.decode(text)),
        wireBytes: (text) => wireOf(call.decode(text)),
        end: () => {
          if (!clientStreaming)
            throw new ConflictError(
              "Este método no tiene un stream de envío que terminar",
              "grpc-not-client-streaming",
            );
          if (halfClosed) return;
          halfClosed = true;
          (stream as ClientWritableStream<object>).end();
          // Un evento y no un mensaje: no viaja nada que contar, pero en la transcripción se tiene que
          // ver cuándo terminó de mandar el cliente, que es lo que desbloquea la respuesta de un stream.
          listeners.onEvent?.("fin del envío: el cliente cerró su mitad del stream");
        },
        close: () => {
          finished = true;
          stream?.cancel();
          client.close();
        },
      };

      // Una sola vez: la llaman el reloj —que se para al abrir o al fallar— y un `UNAVAILABLE` antes de
      // conectar, que después de fallar ya no se atiende (`finished`).
      const fail = (error: Error) => {
        settled = true;
        finished = true;
        clearTimeout(timer);
        stream?.cancel();
        client.close();
        reject(error);
      };
      const timer = setTimeout(
        () => fail(new Error(`la conexión no estuvo lista en ${target.connectTimeoutMs} ms`)),
        target.connectTimeoutMs,
      );
      const ready = () => {
        if (connected || finished) return;
        connected = true;
        listeners.onOpen?.();
        if (call.request) listeners.onSent?.(call.request.text, wireOf(call.request.value as object));
        // Sin mirar `settled`: fallar pone `finished`, y con él ya no se llega aquí.
        settled = true;
        clearTimeout(timer);
        resolve(channel);
      };
      // Sin mirar `finished`: lo que llegara tras cerrar lo descarta el registro, que ya no tiene la
      // sesión viva; y `ready` no abre una llamada terminada.
      const onData = (value: object) => {
        ready();
        // El JSON del mensaje ya decodificado es lo que se lee y lo que se comprueba; `bytes`, lo que
        // ocupó en el cable (ver `wireSizes`).
        listeners.onMessage(Buffer.from(JSON.stringify(value)), false, wireSizes.get(value));
      };
      const onStatus = (status: StatusObject) => {
        if (finished) return;
        if (!connected && status.code === grpcStatus.UNAVAILABLE) {
          fail(new Error(status.details));
          return;
        }
        ready();
        finished = true;
        listeners.onClose(status.code, status.details, flatMetadata(status.metadata));
        client.close();
      };
      // El valor de una unaria o de un stream de cliente llega por el callback, **antes** del estado.
      const onValue = (error: ServiceError | null, value?: object) => {
        if (!error && value) onData(value);
      };

      // Nada de esto lanza con un cliente recién creado —los errores de serialización llegan como
      // estado—; si lanzara, el ejecutor de la promesa la rechaza y el reloj cierra el cliente.
      const { path, requestSerialize } = definition;
      let started: AnyCall;
      if (!clientStreaming && !serverStreaming)
        started = client.makeUnaryRequest(
          path,
          requestSerialize,
          responseDeserialize,
          call.request?.value ?? {},
          metadata,
          options,
          onValue,
        );
      else if (!clientStreaming)
        started = client.makeServerStreamRequest(
          path,
          requestSerialize,
          responseDeserialize,
          call.request?.value ?? {},
          metadata,
          options,
        );
      else if (!serverStreaming)
        started = client.makeClientStreamRequest(
          path,
          requestSerialize,
          responseDeserialize,
          metadata,
          options,
          onValue,
        );
      else started = client.makeBidiStreamRequest(path, requestSerialize, responseDeserialize, metadata, options);
      stream = started;

      // Las cuatro formas son `EventEmitter`; los tipos de grpc-js solo declaran en cada una lo suyo.
      const events = started as unknown as EventEmitter;
      if (serverStreaming) events.on("data", onData);
      started.on("metadata", (received: Metadata) => {
        ready();
        listeners.onOpen?.({ status: 200, headers: flatMetadata(received), via: "inicio de la llamada" });
      });
      started.on("status", onStatus);
      // El estado llega por `status`, con el código y los trailers. Sin esta escucha, el `error` que
      // grpc-js emite además sería una excepción sin atrapar que tumba el proceso.
      events.on("error", () => undefined);

      // La conexión: se pide y se mira hasta que esté lista. Un fallo no rechaza aquí —grpc-js
      // reintenta—; lo dice el `UNAVAILABLE` de la llamada, con su motivo, o el reloj de arriba.
      const grpcChannel = client.getChannel();
      const watch = () => {
        if (settled || finished) return;
        const state = grpcChannel.getConnectivityState(true);
        // `SHUTDOWN` solo llega cerrando el cliente, y cerrar pone antes `finished`.
        if (state === connectivityState.READY) return ready();
        grpcChannel.watchConnectivityState(state, Date.now() + target.connectTimeoutMs, (error) => {
          if (!error) watch();
        });
      };
      watch();
    });
  }
}
