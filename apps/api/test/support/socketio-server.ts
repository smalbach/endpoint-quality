/**
 * Un servidor Socket.IO de verdad, en proceso y en loopback, para las pruebas.
 *
 * El paquete `socket.io` y no un guion: el `CONNECT` del espacio de nombres, el rechazo de un
 * `io.use()`, el acuse y los dos transportes solo existen con bytes reales por un socket real.
 *
 * - `/`: exige `auth.token` igual a `token` (si se da); saluda con `bienvenida` —con el token que
 *   recibió dentro, como un servidor descuidado—; `eco` devuelve lo recibido como `eco`; `sumar`
 *   contesta al acuse con el total; `grande` devuelve un texto del tamaño pedido.
 * - `/admin`: saluda con `admin`.
 * - `/mudo`: acepta y calla. Es el servidor colgado que corta la inactividad.
 */
import { createServer, type Server as HttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { Server } from "socket.io";

export type TestSocketIo = {
  port: number;
  url: string;
  /** Las cabeceras y la query de cada `CONNECT` aceptado o no, para mirar lo que viajó. */
  handshakes: { headers: Record<string, unknown>; query: Record<string, unknown>; auth: Record<string, unknown> }[];
  close(): Promise<void>;
};

export async function startSocketIo(options: { token?: string } = {}): Promise<TestSocketIo> {
  const http: HttpServer = createServer();
  const io = new Server(http, { transports: ["websocket", "polling"] });
  const handshakes: TestSocketIo["handshakes"] = [];

  io.use((socket, next) => {
    handshakes.push({
      headers: { ...socket.handshake.headers },
      query: { ...socket.handshake.query },
      auth: { ...socket.handshake.auth },
    });
    if (options.token !== undefined && socket.handshake.auth?.token !== options.token) {
      next(Object.assign(new Error("no autorizado"), { data: { codigo: 401 } }));
      return;
    }
    next();
  });
  io.on("connection", (socket) => {
    socket.emit("bienvenida", { hola: "mundo", recibido: socket.handshake.auth?.token ?? null });
    socket.on("eco", (...args: unknown[]) => socket.emit("eco", ...args));
    socket.on("grande", (pedido?: { n?: number }) => socket.emit("grande", "x".repeat(pedido?.n ?? 0)));
    socket.on("sumar", (data: { a: number; b: number }, ack?: (reply: unknown) => void) =>
      ack?.({ total: data.a + data.b }),
    );
  });
  io.of("/admin").on("connection", (socket) => socket.emit("admin", { ok: true }));
  io.of("/mudo").on("connection", () => undefined);

  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  const port = (http.address() as AddressInfo).port;
  return {
    port,
    url: `http://127.0.0.1:${port}`,
    handshakes,
    close: async () => {
      io.disconnectSockets(true);
      await new Promise<void>((resolve) => io.close(() => resolve()));
    },
  };
}
