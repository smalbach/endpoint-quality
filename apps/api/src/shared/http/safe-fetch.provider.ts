import { Inject, Injectable } from "@nestjs/common";
import { ENV, type Env } from "../config/env";
import {
  safeFetch,
  type SafeFetchPolicy,
  type SafeFetchPort,
  type SafeFetchResult,
  type SafeRequestOptions,
} from "./safe-fetch";

/**
 * La política de red del despliegue, leída en un solo sitio.
 *
 * Función y no un getter privado porque ahora hay dos consumidores —la petición y el WebSocket— y
 * la regla del comentario de abajo sigue en pie: que los dos **lean** la política de aquí, en vez
 * de que el socket construya la suya, es lo que impide que uno de los dos se deje
 * `allowPrivateTargets` encendido.
 */
export function policyFromEnv(env: Env): SafeFetchPolicy {
  return {
    allowPrivateTargets: env.ALLOW_PRIVATE_TARGETS,
    maxRedirects: env.MAX_REDIRECTS,
    timeoutMs: env.REQUEST_TIMEOUT_MS,
    maxResponseBytes: env.MAX_RESPONSE_BYTES,
  };
}

/**
 * The guard, wired to the deployment's policy.
 *
 * A provider rather than a bare function so a test can substitute it — and, more importantly, so
 * there is exactly one place where the policy is read. A second call site that built its own
 * policy object would be a second chance to leave `allowPrivateTargets` on.
 */
@Injectable()
export class ConfiguredSafeFetch implements SafeFetchPort {
  constructor(@Inject(ENV) private readonly env: Env) {}

  private get policy(): SafeFetchPolicy {
    return policyFromEnv(this.env);
  }

  get(url: string, options: { headers?: Record<string, string> } = {}): Promise<SafeFetchResult> {
    return safeFetch(url, this.policy, options);
  }

  request(url: string, options: SafeRequestOptions): Promise<SafeFetchResult> {
    return safeFetch(url, this.policy, options);
  }
}
