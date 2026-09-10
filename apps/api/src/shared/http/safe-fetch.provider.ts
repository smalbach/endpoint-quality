import { Inject, Injectable } from "@nestjs/common";
import { ENV, type Env } from "../config/env";
import { safeFetch, type SafeFetchPolicy, type SafeFetchPort, type SafeFetchResult, type SafeRequestOptions } from "./safe-fetch";

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
    return {
      allowPrivateTargets: this.env.ALLOW_PRIVATE_TARGETS,
      maxRedirects: this.env.MAX_REDIRECTS,
      timeoutMs: this.env.REQUEST_TIMEOUT_MS,
      maxResponseBytes: this.env.MAX_RESPONSE_BYTES,
    };
  }

  get(url: string, options: { headers?: Record<string, string> } = {}): Promise<SafeFetchResult> {
    return safeFetch(url, this.policy, options);
  }

  request(url: string, options: SafeRequestOptions): Promise<SafeFetchResult> {
    return safeFetch(url, this.policy, options);
  }
}
