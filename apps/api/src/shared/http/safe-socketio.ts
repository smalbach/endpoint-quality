/**
 * Conectar con un servidor Socket.IO que eligió un usuario, con la misma guarda que una petición.
 *
 * Socket.IO va encima de Engine.IO, que va encima de un WebSocket o de un sondeo largo por HTTP. Las
 * dos cosas son HTTP hacia la URL del canal, así que la regla es la de siempre y no se reescribe: se
 * resuelve y se comprueba la IP con `resolveTarget`, y cada conexión se abre **contra la dirección
 * comprobada** con `pinnedConnection` —la línea de `safe-socket.ts` que cierra la ventana de DNS
 * rebinding—, con el nombre en `Host` y en el SNI.
 *
 * Lo que la biblioteca haría por su cuenta y aquí no se le deja hacer:
 *
 * - **Resolver el nombre.** `socket.io-client` no deja elegir a qué dirección conecta, pero los dos
 *   transportes aceptan un `agent` de Node, y el agente de aquí solo sabe abrir conexiones a la IP
 *   comprobada. El WebSocket lo recibe tal cual (`ws` lo usa para su `http.request`).
 * - **Seguir redirecciones.** El sondeo de Node usa `xmlhttprequest-ssl`, que sigue un 302 **sin** el
 *   agente: un `Location: http://169.254.169.254/` saltaba la guarda entera. Así que el sondeo es un
 *   transporte propio (`pinnedPolling`), una petición de Node con el agente, que trata una
 *   redirección como un error, como hace el upgrade de un WebSocket.
 * - **Reconectar.** `reconnection: false`: una reconexión es una conexión nueva que nadie ha
 *   comprobado, a una hora que nadie ha elegido, y una sesión que se cae tiene que decirlo.
 * - **Leer sin tope.** El WebSocket con `maxPayload` dentro de `ws` (que cuenta después de inflar),
 *   y cada respuesta del sondeo cortada en cuanto pasa del tope, antes de juntarla en memoria.
 */
import { Agent as HttpAgent, request as httpRequest, type ClientRequestArgs, type IncomingMessage } from "node:http";
import { Agent as HttpsAgent, request as httpsRequest } from "node:https";
import type { Socket as NetSocket } from "node:net";
import { Fetch, NodeWebSocket } from "engine.io-client";
// `Manager` y no `io()`: el paquete CJS exporta `io` como `module.exports`, y sus exportaciones con
// nombre que no son `Manager` ni `Socket` no existen en Node. Los transportes vienen de su motor.
import { Manager, type Socket } from "socket.io-client";

import { BlockedTargetError, resolveTarget, type SafeFetchPolicy } from "./safe-fetch";
import { pinnedConnection } from "./safe-socket";

/** Los esquemas de un servidor Socket.IO: el `http(s)` que escribe todo el mundo y el `ws(s)` del upgrade. */
export const SOCKETIO_SCHEMES = ["http:", "https:", "ws:", "wss:"] as const;

export type SafeSocketIoOptions = {
  path: string;
  namespace: string;
  auth: Record<string, unknown> | null;
  query: Record<string, string>;
  /** Las cabeceras del upgrade y de cada sondeo. `Host` no: la pone la conexión con el nombre. */
  headers: Record<string, string>;
  transports: ("websocket" | "polling")[];
  /** El tope de un mensaje de Engine.IO, **después** de inflar. Obligatorio, como en un WebSocket. */
  maxPayload: number;
  /** Cuánto se espera al `CONNECT` del espacio de nombres. */
  connectTimeoutMs: number;
};

/**
 * El servidor dijo que no al `CONNECT` del espacio de nombres (`connect_error`): el `next(new
 * Error(…))` de un `io.use()`, un espacio que no existe. Con el motivo que dio y, si mandó `data`,
 * con ella: es la mitad de los fallos de verdad de un servidor Socket.IO con autenticación.
 */
export class SocketIoRejectedError extends Error {
  constructor(
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
    this.name = "SocketIoRejectedError";
  }
}

/**
 * El agente que solo abre conexiones hacia la dirección comprobada.
 *
 * Sin `keepAlive`: cada sondeo abre la suya, y así el tope por conexión de `pinnedPolling` es un tope
 * por respuesta. Exportado para probarlo solo: es la pieza que, si alguien la «simplifica», reabre
 * el rebinding sin que nada más se ponga rojo.
 */
export function pinnedAgent(address: string, secure: boolean, hostname: string): HttpAgent {
  const connect = pinnedConnection(address, secure, hostname);
  const agent = secure ? new HttpsAgent({ keepAlive: false }) : new HttpAgent({ keepAlive: false });
  // `createConnection` es un método público de `http.Agent`, y el que usa `addRequest` para abrir.
  (agent as unknown as { createConnection: (options: ClientRequestArgs) => NetSocket }).createConnection = (options) =>
    connect(options);
  return agent;
}

/**
 * El transporte de sondeo, con el agente fijado, sin redirecciones y con tope por respuesta.
 *
 * Extiende el `Fetch` de Engine.IO por su esqueleto —el ciclo de sondeo, el formato de los paquetes,
 * la URL con `sid` y `EIO`— y cambia solo lo que habla con la red.
 */
export function pinnedPolling(agent: HttpAgent, secure: boolean, maxResponseBytes: number): typeof Fetch {
  const send = secure ? httpsRequest : httpRequest;
  return class PinnedPolling extends Fetch {
    override doPoll(): void {
      this.exchange(undefined, (error, data) => {
        if (error) this.onError("polling read error", error);
        else this.onData(data ?? "");
      });
    }

    override doWrite(data: string, callback: () => void): void {
      this.exchange(data, (error) => {
        if (error) this.onError("polling write error", error);
        else callback();
      });
    }

    private exchange(body: string | undefined, reply: (error: Error | null, data?: string) => void): void {
      // Una sola respuesta por petición: cortar una respuesta grande también hace saltar `error`.
      let replied = false;
      const done = (error: Error | null, data?: string) => {
        if (replied) return;
        replied = true;
        reply(error, data);
      };
      const headers: Record<string, string> = { ...(this.opts.extraHeaders ?? {}) };
      if (body !== undefined) headers["content-type"] = "text/plain;charset=UTF-8";
      const request = send(this.uri(), { method: body === undefined ? "GET" : "POST", headers, agent });
      request.on("response", (response: IncomingMessage) => {
        const status = response.statusCode ?? 0;
        if (status >= 300) {
          response.resume();
          done(
            new Error(
              status < 400
                ? `el sondeo contestó ${status}: una redirección no se sigue`
                : `el sondeo contestó ${status}`,
            ),
          );
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        response.on("data", (chunk: Buffer) => {
          size += chunk.byteLength;
          if (size > maxResponseBytes) {
            // Se corta aquí, antes de juntar más: el contador de la conversación llega tarde.
            request.destroy();
            done(new Error(`una respuesta del sondeo pasó de ${maxResponseBytes} bytes`));
            return;
          }
          chunks.push(chunk);
        });
        response.on("end", () => done(null, Buffer.concat(chunks).toString("utf8")));
      });
      request.on("error", (error) => done(error));
      request.end(body);
    }
  };
}

/**
 * Un socket conectado al espacio de nombres, o el motivo de que no lo esté.
 *
 * `listen` se llama con el socket recién creado y **antes** de conectar, por lo mismo que las
 * escuchas de `openSafeSocket`: un servidor que emite en su `connection` lo hace en el mismo viaje
 * que el `CONNECT`, y una escucha puesta después se lo pierde.
 *
 * Lanza `BlockedTargetError` si la guarda dice que no, `SocketIoRejectedError` si el servidor
 * rechazó el `CONNECT`, y el error de red tal cual en el resto.
 */
export async function openSafeSocketIo(
  rawUrl: string,
  policy: SafeFetchPolicy,
  options: SafeSocketIoOptions,
  listen: (socket: Socket) => void,
): Promise<{ socket: Socket; manager: Manager }> {
  const { url, address } = await resolveTarget(rawUrl, policy, { schemes: SOCKETIO_SCHEMES });
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  const secure = url.protocol === "https:" || url.protocol === "wss:";
  const agent = pinnedAgent(address, secure, hostname);

  // La query de la URL, debajo de la de los ajustes. Engine.IO la leería de la URL y **pisaría** la de
  // las opciones, así que se junta aquí y la URL viaja sin ella.
  const query = { ...Object.fromEntries(url.searchParams), ...options.query };
  const origin = `${secure ? "https" : "http"}://${url.host}`;
  const extraHeaders = Object.fromEntries(
    Object.entries(options.headers).filter(([name]) => name.toLowerCase() !== "host"),
  );
  const transports = options.transports.map((transport) =>
    transport === "websocket" ? NodeWebSocket : pinnedPolling(agent, secure, options.maxPayload),
  );

  const manager = new Manager(origin, {
    path: options.path,
    query,
    extraHeaders,
    transports,
    // Por orden: sin reconectar nunca, sin conectar hasta tener las escuchas, sin compartir la
    // conexión con otra sesión, y sin recordar un upgrade de otra vez.
    reconnection: false,
    autoConnect: false,
    forceNew: true,
    multiplex: false,
    rememberUpgrade: false,
    upgrade: options.transports.length > 1,
    timeout: options.connectTimeoutMs,
    closeOnBeforeunload: false,
    // `agent` está tipado para el navegador (una cadena); en Node es el agente de verdad.
    agent: agent as unknown as string,
    // `ws` lo recibe como su `maxPayload`: el tope de trama dentro de la biblioteca.
    ...({ maxPayload: options.maxPayload } as object),
  });

  const socket = manager.socket(options.namespace, options.auth ? { auth: options.auth } : {});
  listen(socket);

  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error: Error | null) => {
      if (settled) return;
      settled = true;
      socket.off("connect", onConnect);
      socket.off("connect_error", onError);
      if (!error) {
        resolve({ socket, manager });
        return;
      }
      socket.disconnect();
      manager.engine?.close();
      reject(error);
    };
    const onConnect = () => finish(null);
    const onError = (error: Error & { type?: string; data?: unknown; description?: unknown }) => {
      // Tres orígenes, y solo uno es el servidor diciendo que no: un error de transporte trae
      // `type: "TransportError"` y la causa de red en `description`; el plazo del `Manager` es un
      // «timeout» a secas; y el resto es el `CONNECT_ERROR` que mandó el servidor, con su `data`.
      if (error.type === "TransportError") {
        const cause = error.description instanceof Error ? error.description.message : "";
        finish(new Error(cause ? `${error.message}: ${cause}` : error.message));
      } else if (error.message === "timeout") {
        finish(new Error(`sin respuesta al CONNECT en ${options.connectTimeoutMs} ms`));
      } else finish(new SocketIoRejectedError(error.message, error.data));
    };
    socket.on("connect", onConnect);
    socket.on("connect_error", onError);
    socket.connect();
  });
}

export { BlockedTargetError };
