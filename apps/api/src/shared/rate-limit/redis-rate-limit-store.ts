import { Logger, type OnModuleDestroy } from "@nestjs/common";
import { Redis } from "ioredis";

import { InMemoryRateLimitStore, type RateLimitStorePort, type RateWindow } from "./rate-limit-store";

/**
 * Un golpe, en un solo paso: sumar y, si la clave no tenía caducidad —es nueva—, dársela. En un guion
 * porque `INCR` y `PEXPIRE` sueltos dejan un hueco: una réplica que muere entre los dos deja una clave
 * sin caducidad, y esa IP bloqueada para siempre.
 */
const HIT = `
local hits = redis.call('INCR', KEYS[1])
local ttl = redis.call('PTTL', KEYS[1])
if ttl < 0 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
  ttl = tonumber(ARGV[1])
end
return {hits, ttl}
`;

const PEEK = `
local hits = redis.call('GET', KEYS[1])
if not hits then return nil end
local ttl = redis.call('PTTL', KEYS[1])
if ttl < 0 then return nil end
return {tonumber(hits), ttl}
`;

/** Lo más que se espera a Redis por un golpe: el límite no puede ser lo que hace lenta una petición. */
const COMMAND_TIMEOUT_MS = 500;

/**
 * Los contadores de los límites de peticiones, en Redis: todas las réplicas que apuntan al mismo
 * Redis cuentan en la misma clave, y el tope es del despliegue y no de cada proceso.
 *
 * **Redis caído no deja la API sin servir, ni sin límite.** Mientras no contesta, cada réplica cuenta
 * en su memoria —el límite vuelve a ser por proceso, N veces más flojo, que es lo que había antes— en
 * lugar de rechazar todo o de dejar pasar todo. Rechazar convertiría un Redis caído en una API
 * caída; dejar pasar todo quitaría el tope justo cuando alguien lo está probando. Se avisa una vez al
 * caer y otra al volver, como el bus, y al volver se sigue contando en Redis: lo contado en memoria
 * mientras tanto se pierde, que en una ventana de un minuto es poco.
 */
export class RedisRateLimitStore implements RateLimitStorePort, OnModuleDestroy {
  private readonly logger = new Logger("RateLimit");
  private readonly client: Redis;
  private readonly fallback: InMemoryRateLimitStore;
  /** Si ya se dijo que Redis no está: se avisa al caer y al volver, no en cada petición. */
  private down = false;

  constructor(
    redisUrl: string,
    private readonly prefix = "eq:rl",
    now: () => number = Date.now,
  ) {
    this.fallback = new InMemoryRateLimitStore(now);
    // Sin cola fuera de línea: con Redis caído, un golpe falla en el acto y cuenta en memoria, en vez
    // de esperar a una conexión que puede no volver con la petición del usuario colgada detrás.
    this.client = new Redis(redisUrl, {
      retryStrategy: (times: number) => Math.min(times * 500, 10_000),
      enableOfflineQueue: false,
      maxRetriesPerRequest: 1,
      commandTimeout: COMMAND_TIMEOUT_MS,
    });
    this.client.on("error", (error: Error) => this.fell(error));
    this.client.on("ready", () => this.recovered());
  }

  async hit(key: string, windowMs: number): Promise<RateWindow> {
    if (this.client.status !== "ready") return this.fallback.hit(key, windowMs);
    try {
      const [hits, ttl] = (await this.client.eval(HIT, 1, this.key(key), String(windowMs))) as [number, number];
      this.recovered();
      return { hits, resetInMs: ttl };
    } catch (error) {
      this.fell(error);
      return this.fallback.hit(key, windowMs);
    }
  }

  async peek(key: string): Promise<RateWindow | null> {
    if (this.client.status !== "ready") return this.fallback.peek(key);
    try {
      const found = (await this.client.eval(PEEK, 1, this.key(key))) as [number, number] | null;
      this.recovered();
      return found ? { hits: found[0], resetInMs: found[1] } : null;
    } catch (error) {
      this.fell(error);
      return this.fallback.peek(key);
    }
  }

  /** Si ahora mismo se cuenta en Redis y no en memoria. */
  get shared(): boolean {
    return this.client.status === "ready";
  }

  async close(): Promise<void> {
    await this.client.quit().catch(() => undefined);
  }

  async onModuleDestroy(): Promise<void> {
    await this.close();
  }

  private key(key: string): string {
    return `${this.prefix}:${key}`;
  }

  private fell(error: unknown): void {
    if (this.down) return;
    this.down = true;
    this.logger.warn(
      `Sin Redis para los límites de peticiones: ${error instanceof Error ? error.message : String(error)}. Cada instancia cuenta en su memoria hasta que vuelva`,
    );
  }

  /** Al volver la conexión, o tras una orden que salió bien después de un plazo vencido sin caída. */
  private recovered(): void {
    if (!this.down) return;
    this.down = false;
    this.logger.log("Límites de peticiones compartidos otra vez en Redis");
  }
}
