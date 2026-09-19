/**
 * Donde se cuentan los golpes de un límite de peticiones.
 *
 * Con un proceso, un `Map` basta. Con N réplicas detrás de un balanceador, un `Map` por réplica es un
 * límite N veces más flojo: el balanceador reparte las peticiones de una IP entre todas y cada una
 * cuenta solo las suyas. Por eso el contador es un puerto, con un adaptador en memoria —un proceso, y
 * las pruebas— y otro en Redis cuando hay `REDIS_URL`, que es lo que ya comparten las réplicas.
 *
 * **Ventana fija que empieza con el primer golpe.** Es lo que se puede hacer atómico en Redis con un
 * `INCR` y un `PEXPIRE` en el mismo guion, sin una lista por clave. Lo que cuesta: en el borde de dos
 * ventanas caben hasta el doble del tope seguidos. Para lo que protegen estos límites —un bucle, no
 * una persona— es aceptable, y es la misma forma que ya tenía el tope de intentos de la captura.
 */
export const RATE_LIMIT_STORE = Symbol("RATE_LIMIT_STORE");

/** Cómo va una ventana: cuántos golpes lleva y cuánto le falta para empezar de cero. */
export type RateWindow = { hits: number; resetInMs: number };

export interface RateLimitStorePort {
  /** Un golpe más en `key`. Si no había ventana abierta, abre una de `windowMs`. */
  hit(key: string, windowMs: number): Promise<RateWindow>;
  /** Cómo va `key` sin sumar nada; `null` si no hay ventana abierta. */
  peek(key: string): Promise<RateWindow | null>;
}

/** Cuántas claves se recuerdan como mucho en memoria. Pasado el tope se olvidan las vencidas. */
const MAX_TRACKED = 100_000;

/**
 * El contador de un solo proceso. Es el de siempre: sin `REDIS_URL` no hay otras réplicas con las que
 * compartir, y es también a lo que cae el de Redis mientras Redis no contesta.
 */
export class InMemoryRateLimitStore implements RateLimitStorePort {
  private readonly windows = new Map<string, { startedAt: number; windowMs: number; hits: number }>();

  constructor(private readonly now: () => number = Date.now) {}

  async hit(key: string, windowMs: number): Promise<RateWindow> {
    const now = this.now();
    let window = this.current(key, now);
    if (window) window.hits += 1;
    else {
      if (this.windows.size >= MAX_TRACKED) this.sweep(now);
      // Si ni barriendo cabe, se olvida la más antigua: es preferible a crecer sin fin.
      if (this.windows.size >= MAX_TRACKED) this.windows.delete(this.windows.keys().next().value!);
      window = { startedAt: now, windowMs, hits: 1 };
      this.windows.set(key, window);
    }
    return { hits: window.hits, resetInMs: window.startedAt + window.windowMs - now };
  }

  async peek(key: string): Promise<RateWindow | null> {
    const now = this.now();
    const window = this.current(key, now);
    return window ? { hits: window.hits, resetInMs: window.startedAt + window.windowMs - now } : null;
  }

  private current(key: string, now: number) {
    const window = this.windows.get(key);
    if (!window) return null;
    if (now - window.startedAt >= window.windowMs) {
      this.windows.delete(key);
      return null;
    }
    return window;
  }

  private sweep(now: number): void {
    for (const [key, window] of this.windows) if (now - window.startedAt >= window.windowMs) this.windows.delete(key);
  }
}
