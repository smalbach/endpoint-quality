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
 * Se cuenta por IP en los contadores compartidos (`RateLimitStorePort`): con `REDIS_URL`, en Redis, y
 * el tope es de todas las instancias juntas —si no, con N réplicas serían N×20—. Detrás de un NAT
 * —un contenedor, una oficina— todos comparten la IP, y es aceptable: el tope es alto para una
 * persona que teclea mal y bajo para un bucle. **El token probado no se guarda ni se escribe en ningún registro**: solo la cuenta.
 */
import type { RateLimitStorePort } from "@/shared/rate-limit/rate-limit-store";

export type AuthFailureLimit = {
  /** Cuántas credenciales malas se aceptan por IP dentro de la ventana. */
  max: number;
  windowMs: number;
};

export const DEFAULT_AUTH_FAILURE_LIMIT: AuthFailureLimit = { max: 20, windowMs: 60_000 };

export class AuthFailureLimiter {
  constructor(
    private readonly limit: AuthFailureLimit,
    private readonly store: RateLimitStorePort,
  ) {}

  /** Si esa IP ya gastó sus intentos: entonces ni se mira la credencial. Devuelve los segundos que faltan. */
  async blocked(ip: string): Promise<number | null> {
    const window = await this.store.peek(key(ip));
    if (!window || window.hits < this.limit.max) return null;
    return Math.max(1, Math.ceil(window.resetInMs / 1000));
  }

  /** Un intento fallido más de esa IP. */
  async failed(ip: string): Promise<void> {
    await this.store.hit(key(ip), this.limit.windowMs);
  }
}

/** La IP tal cual: el contador no guarda nada más, y menos el token probado. */
const key = (ip: string) => `capture-auth:${ip}`;
