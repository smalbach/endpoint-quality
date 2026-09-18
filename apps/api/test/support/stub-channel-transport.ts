/**
 * Un transporte de canal guionizado: lo que un servidor de sockets haría, sin abrir un puerto.
 *
 * Con la forma de `StubSafeFetch`: la prueba guioniza una URL y el doble registra cada apertura y
 * cada mensaje mandado. Y con la misma asimetría: **una URL que la prueba no guionizó sale por el
 * transporte real**, para que las pruebas contra un servidor de verdad en loopback pasen por el
 * mismo proveedor y la política de red se decida en un solo sitio.
 *
 * Lo que tiene que imitar bien, porque es donde está el fallo que ya costó encontrar: el saludo se
 * entrega **en el mismo tic** que la apertura, antes de que `open()` devuelva. Así es como llega
 * desde un servidor de verdad —en el mismo paquete que el 101—, y un doble que lo entregara después
 * escondería justo la carrera que perdía 44 de cada 50 saludos.
 */
import type { SafeSocketOptions, SocketListeners } from "@/shared/http/safe-socket";
import { HandshakeRejectedError } from "@/shared/http/safe-socket";
import type { ChannelTransportPort, OpenChannel } from "@/modules/channels/infrastructure/ws-transport";

export type ChannelScript = {
  /** Si el upgrade no es un 101, con qué número contesta. */
  rejectWith?: number;
  /** Lo que el servidor dice nada más abrir. */
  greeting?: string[];
  /** Lo que contesta a cada mensaje. */
  reply?: (text: string) => string[];
  /** Si cierra él solo después del saludo, con qué código. */
  closeAfterGreeting?: number;
};

export class StubChannelTransport implements ChannelTransportPort {
  private readonly scripts = new Map<string, ChannelScript>();
  readonly opened: { url: string; options: SafeSocketOptions }[] = [];
  readonly sent: { url: string; text: string }[] = [];
  readonly closed: { url: string; code: number; reason: string }[] = [];

  constructor(private readonly real: ChannelTransportPort | null = null) {}

  script(url: string, script: ChannelScript): void {
    this.scripts.set(url, script);
  }

  reset(): void {
    this.scripts.clear();
    this.opened.length = 0;
    this.sent.length = 0;
    this.closed.length = 0;
  }

  async open(url: string, options: SafeSocketOptions, listeners: SocketListeners): Promise<OpenChannel> {
    const script = this.scripts.get(url);
    if (!script) {
      if (!this.real) throw new Error(`URL de canal no guionizada en la prueba: ${url}`);
      return this.real.open(url, options, listeners);
    }
    this.opened.push({ url, options });
    if (script.rejectWith) throw new HandshakeRejectedError(script.rejectWith, url);

    let open = true;
    const handshake = { status: 101, headers: { "sec-websocket-protocol": options.subprotocols?.[0] ?? "" } };
    // Apertura y saludo seguidos, en el mismo tic y antes de devolver: ver la cabecera.
    listeners.onOpen?.(handshake);
    for (const text of script.greeting ?? []) listeners.onMessage(Buffer.from(text), false);
    if (script.closeAfterGreeting) {
      open = false;
      listeners.onClose(script.closeAfterGreeting, "");
    }

    return {
      handshake,
      send: (text) => {
        if (!open) throw new Error("el socket ya está cerrado");
        this.sent.push({ url, text });
        // La respuesta llega en otro tic, como llegaría por la red.
        setImmediate(() => {
          if (!open) return;
          for (const answer of script.reply?.(text) ?? []) listeners.onMessage(Buffer.from(answer), false);
        });
      },
      close: (code, reason) => {
        if (!open) return;
        open = false;
        this.closed.push({ url, code, reason });
      },
    };
  }
}
