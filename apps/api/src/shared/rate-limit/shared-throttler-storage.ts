import type { ThrottlerModuleOptions, ThrottlerStorage } from "@nestjs/throttler";

import type { RateLimitStorePort } from "./rate-limit-store";

/** El índice de la librería no exporta el tipo del registro; se toma de la firma. */
type ThrottlerStorageRecord = Awaited<ReturnType<ThrottlerStorage["increment"]>>;

/**
 * El almacén de `@nestjs/throttler` sobre el puerto de contadores, para que el límite global y los
 * de cada ruta (`@Throttle`: el login, el registro, `/hooks/flows`…) cuenten en el mismo sitio en
 * todas las réplicas.
 *
 * El guardián sigue siendo el de la librería: él decide la clave (ruta y quién llama), pone el 429 y
 * las cabeceras. Esto solo cambia dónde se cuenta. Dos diferencias con el almacén que trae:
 *
 * - **Ventana fija** y no un golpe que caduca por separado (ver `rate-limit-store.ts`).
 * - **Sin bloqueo aparte.** Pasado el tope, se está bloqueado lo que le queda a la ventana, y
 *   `Retry-After` es eso. `blockDuration` no se usa: ninguna ruta lo pone, y por omisión la librería
 *   lo iguala a la ventana, que es lo mismo que esto.
 */
export class SharedThrottlerStorage implements ThrottlerStorage {
  constructor(private readonly store: RateLimitStorePort) {}

  async increment(
    key: string,
    ttl: number,
    limit: number,
    _blockDuration: number,
    throttlerName: string,
  ): Promise<ThrottlerStorageRecord> {
    const window = await this.store.hit(`throttle:${throttlerName}:${key}`, ttl);
    const seconds = Math.max(1, Math.ceil(window.resetInMs / 1000));
    const isBlocked = window.hits > limit;
    return { totalHits: window.hits, timeToExpire: seconds, isBlocked, timeToBlockExpire: isBlocked ? seconds : 0 };
  }
}

/**
 * El límite de toda la API: 120 por minuto y por quien llama. Las rutas que necesitan otro lo ponen
 * con `@Throttle`. Aquí y no en `AppModule` para que la aplicación de pruebas monte exactamente esto.
 */
export function throttlerOptions(store: RateLimitStorePort): ThrottlerModuleOptions {
  return { throttlers: [{ name: "default", ttl: 60_000, limit: 120 }], storage: new SharedThrottlerStorage(store) };
}
