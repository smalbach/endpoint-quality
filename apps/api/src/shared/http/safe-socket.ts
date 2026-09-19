/**
 * Abrir un WebSocket hacia una URL que eligió un usuario, con la misma guarda que una petición.
 *
 * Un `ws://` es un GET con `Upgrade`, así que las cuatro reglas de `safe-fetch.ts` valen tal cual y
 * aquí no se reescribe ninguna: se resuelve y se comprueba la IP con `resolveTarget` —el mismo
 * código, con `ws:`/`wss:` como esquemas pedidos—, y lo que este fichero añade es solo lo que un
 * socket necesita distinto.
 *
 * **Por qué `ws` y no el `WebSocket` que ya trae Node.** El global es el de undici: vuelve a
 * resolver el nombre por su cuenta y no deja elegir a qué dirección conecta. Eso rompe la regla 3
 * —conectar a la IP que se comprobó— y reabre exactamente la ventana de DNS rebinding que la
 * cabecera de `safe-fetch.ts` describe: se comprueba `evil.com → 1.2.3.4`, y al conectar el nombre
 * ya dice `127.0.0.1`. Con `ws` la conexión la abre `createConnection`, y aquí se abre **contra la
 * dirección comprobada**, mientras el nombre original sigue viajando en `Host` y en el SNI.
 *
 * Dos cosas más, y las dos son de los sockets:
 *
 * - **Una redirección en el handshake se rechaza, no se sigue.** `safeFetch` puede seguirlas porque
 *   revalida cada salto y degrada las escrituras a GET; un upgrade no tiene nada equivalente, y un
 *   302 hacia `ws://10.0.0.5` es la forma de siempre de saltarse una comprobación hecha una vez.
 * - **El tope de trama va dentro de la biblioteca** (`maxPayload`), y no solo en el contador de
 *   `conversation.ts`. `permessage-deflate` cuenta después de inflar: sin el tope ahí, 10 KB en el
 *   cable pueden ser 1 GB en memoria antes de que ningún contador llegue a verlos.
 */
import { connect as netConnect, isIP, type Socket } from "node:net";
import { connect as tlsConnect } from "node:tls";
import type { ClientRequestArgs, IncomingMessage } from "node:http";
import WebSocket from "ws";

import { resolveTarget, type SafeFetchPolicy } from "./safe-fetch";

/** Los esquemas de un socket. Pedidos a `resolveTarget` por nombre: la lista de siempre no cambia. */
export const SOCKET_SCHEMES = ["ws:", "wss:"] as const;

export type SafeSocketOptions = {
  /** Las cabeceras del upgrade. `Host` no: la pone la conexión con el nombre de la URL. */
  headers?: Record<string, string>;
  subprotocols?: string[];
  /** El tope de una trama, **después** de inflar. Obligatorio: sin él no hay tope de memoria. */
  maxPayload: number;
  /** Cuánto se espera al upgrade. Un servidor que acepta el TCP y no contesta es un socket colgado. */
  handshakeTimeoutMs: number;
};

/**
 * Lo que quien abre el socket quiere oír, entregado **desde antes de abrir**.
 *
 * Es parte de la firma y no algo que se engancha después por una razón medida: un servidor que
 * saluda al conectar —la mayoría— manda el saludo en el mismo paquete que el 101, y `ws` lo entrega
 * en cuanto procesa el upgrade. Con las escuchas puestas tras resolver la promesa, **44 de 50
 * saludos se perdían** contra un servidor en loopback. Y el primer mensaje suele ser el que importa:
 * la sesión, el id, el «estás dentro».
 */
export type SocketListeners = {
  /**
   * La apertura, **antes** que cualquier mensaje. La promesa resuelve también, pero en una
   * microtarea: un saludo que viaja con el 101 ya se ha entregado para entonces, y la conversación
   * tendría un mensaje recibido antes de haber abierto.
   */
  onOpen?: (handshake: { status: number; headers: Record<string, string> }) => void;
  onMessage: (data: Buffer, binary: boolean) => void;
  onClose: (code: number, reason: string) => void;
  /** Solo los errores **después** de abrir. Los de antes rechazan la promesa. */
  onError: (error: Error) => void;
};

/**
 * El upgrade contestó otra cosa que 101.
 *
 * Con el estado, porque es la mitad de los fallos de verdad de un WebSocket —un 401 porque el token
 * iba en la query y no llegó, un 403 por el `Origin`— y «no se pudo conectar» sin el número no le
 * dice a nadie qué arreglar.
 */
export class HandshakeRejectedError extends Error {
  constructor(
    readonly status: number,
    readonly target: string,
  ) {
    super(
      status >= 300 && status < 400
        ? `el upgrade contestó ${status}: una redirección en el handshake no se sigue`
        : `el upgrade contestó ${status}`,
    );
    this.name = "HandshakeRejectedError";
  }
}

/**
 * La conexión, abierta contra la dirección comprobada y no contra el nombre.
 *
 * Exportada para poder probarla sola: es la línea que cierra la ventana de rebinding, y si algún día
 * alguien la «simplifica» dejando que la biblioteca resuelva, esto es lo que tiene que ponerse rojo.
 */
export function pinnedConnection(
  address: string,
  secure: boolean,
  hostname: string,
): (options: ClientRequestArgs) => Socket {
  return (options) => {
    const port = Number(options.port);
    if (!secure) return netConnect({ host: address, port });
    // El SNI lleva el nombre, no la IP: sin él, media internet contesta con el certificado de otro
    // sitio o no contesta. Y a una IP literal no se le manda SNI, que el estándar no lo permite.
    return tlsConnect({ host: address, port, servername: isIP(hostname) ? "" : hostname });
  };
}

/**
 * Un socket abierto, o el motivo de que no lo esté.
 *
 * Lanza `BlockedTargetError` cuando la guarda dice que no —y eso es `config`, no `network`: nadie
 * llegó a llamar—, `HandshakeRejectedError` cuando el servidor contestó y no fue un 101, y el error
 * de red tal cual en el resto.
 */
export async function openSafeSocket(
  rawUrl: string,
  policy: SafeFetchPolicy,
  options: SafeSocketOptions,
  listeners: SocketListeners,
): Promise<{ socket: WebSocket; handshake: { status: number; headers: Record<string, string> } }> {
  const { url, address } = await resolveTarget(rawUrl, policy, { schemes: SOCKET_SCHEMES });
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  const secure = url.protocol === "wss:";

  // Las cabeceras que escribió alguien, menos las que no le tocan: `Host` la pone la conexión con el
  // nombre de la URL, y fijarla a mano sería decirle al servidor un nombre y conectar a otro.
  const headers = Object.fromEntries(
    Object.entries(options.headers ?? {}).filter(([name]) => name.toLowerCase() !== "host"),
  );

  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, options.subprotocols ?? [], {
      headers,
      maxPayload: options.maxPayload,
      handshakeTimeout: options.handshakeTimeoutMs,
      followRedirects: false,
      createConnection: pinnedConnection(address, secure, hostname),
    });

    // Enganchadas aquí, con el socket recién creado y todavía sin conectar: nada puede llegar antes.
    // Sin `binaryType` puesto, `ws` entrega siempre un `Buffer` (las tramas partidas, ya juntas).
    socket.on("message", (data, binary) => listeners.onMessage(data as Buffer, binary));
    socket.on("close", (code, reason) => {
      if (settled) listeners.onClose(code, reason.toString());
    });

    let settled = false;
    const fail = (error: Error) => {
      if (settled) {
        listeners.onError(error);
        return;
      }
      settled = true;
      socket.terminate();
      reject(error);
    };

    socket.once("upgrade", (response: IncomingMessage) => {
      // `open` sigue a `upgrade` en el mismo tic, y nada puede haber fallado entre los dos. El estado
      // de una respuesta que llegó por la red siempre está.
      socket.once("open", () => {
        settled = true;
        const handshake = { status: response.statusCode!, headers: flatHeaders(response) };
        listeners.onOpen?.(handshake);
        resolve({ socket, handshake });
      });
    });
    // Escuchar este evento es lo que evita que `ws` lo convierta en un error sin estado. Con él se
    // sabe el número, y se aborta a mano.
    socket.once("unexpected-response", (request, response: IncomingMessage) => {
      request.destroy();
      fail(new HandshakeRejectedError(response.statusCode!, rawUrl));
    });
    socket.on("error", fail);
  });
}

/** Una cabecera que llegó varias veces, en una sola: es como la enseña la pantalla. */
function flatHeaders(response: IncomingMessage): Record<string, string> {
  return Object.fromEntries(
    Object.entries(response.headers).map(([name, value]) => [
      name,
      Array.isArray(value) ? value.join(", ") : String(value),
    ]),
  );
}
