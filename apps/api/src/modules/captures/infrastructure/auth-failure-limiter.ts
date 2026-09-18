/**
 * Los intentos fallidos de credencial contra el proxy de captura, contados por IP del cliente.
 *
 * El token tiene 256 bits y no hay diccionario que probar, así que esto no protege el token: protege
 * **el proceso**. Sin tope, alguien que encuentre el puerto abierto puede tenerlo ocupado calculando
 * hashes y consultando la base una vez por intento, y cada intento es además una línea de ruido en
 * quien mire el tráfico. Con él, pasado el tope en la ventana, la IP recibe un 429 sin que se mire
 * la credencial.
 *
 * Solo cuenta una credencial **presentada y mala**. Un navegador pide la primera vez sin credencial,
 * recibe el 407 y repite con ella: contar eso castigaría a cualquiera que use el proxy de verdad.
 *
 * Se cuenta por IP y en memoria de cada instancia. Detrás de un NAT —un contenedor, una oficina—
 * todos comparten la IP, y es aceptable: el tope es alto para una persona que teclea mal y bajo para
 * un bucle. **El token probado no se guarda ni se escribe en ningún registro**: solo la cuenta.
 */
export type AuthFailureLimit = {
  /** Cuántas credenciales malas se aceptan por IP dentro de la ventana. */
  max: number;
  windowMs: number;
};

export const DEFAULT_AUTH_FAILURE_LIMIT: AuthFailureLimit = { max: 20, windowMs: 60_000 };

/** Cuántas IPs se recuerdan como mucho. Pasado el tope se olvidan las ventanas ya vencidas. */
const MAX_TRACKED = 10_000;

export class AuthFailureLimiter {
  private readonly windows = new Map<string, { startedAt: number; failures: number }>();

  constructor(
    private readonly limit: AuthFailureLimit,
    private readonly now: () => number,
  ) {}

  /** Si esa IP ya gastó sus intentos: entonces ni se mira la credencial. Devuelve los segundos que faltan. */
  blocked(ip: string): number | null {
    const window = this.current(ip);
    if (!window || window.failures < this.limit.max) return null;
    return Math.max(1, Math.ceil((window.startedAt + this.limit.windowMs - this.now()) / 1000));
  }

  /** Un intento fallido más de esa IP. */
  failed(ip: string): void {
    const window = this.current(ip);
    if (window) window.failures += 1;
    else {
      if (this.windows.size >= MAX_TRACKED) this.sweep();
      // Si ni barriendo cabe, se olvida la más antigua: es preferible a crecer sin fin.
      if (this.windows.size >= MAX_TRACKED) this.windows.delete(this.windows.keys().next().value!);
      this.windows.set(ip, { startedAt: this.now(), failures: 1 });
    }
  }

  private current(ip: string): { startedAt: number; failures: number } | null {
    const window = this.windows.get(ip);
    if (!window) return null;
    if (this.now() - window.startedAt >= this.limit.windowMs) {
      this.windows.delete(ip);
      return null;
    }
    return window;
  }

  private sweep(): void {
    const now = this.now();
    for (const [ip, window] of this.windows) if (now - window.startedAt >= this.limit.windowMs) this.windows.delete(ip);
  }
}
