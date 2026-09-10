import { Inject, Injectable } from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";

import { ENV, type Env } from "@/shared/config/env";
import type { AccessTokenClaims, AccessTokenServicePort } from "../domain/access-token";

/**
 * The signed half of a session.
 *
 * Short-lived on purpose: an access token cannot be revoked, so its lifetime *is* the revocation
 * window. Fifteen minutes is the default, and the refresh chain — which is revocable — carries
 * the long-lived part.
 */
@Injectable()
export class JwtAccessTokenService implements AccessTokenServicePort {
  constructor(private readonly jwt: JwtService, @Inject(ENV) private readonly env: Env) {}

  async sign(claims: AccessTokenClaims): Promise<string> {
    // Seconds rather than the raw "15m": the string form is typed against `ms` and a value that
    // fails to parse would silently mint a token that never expires.
    return this.jwt.signAsync(claims, { secret: this.env.JWT_ACCESS_SECRET, expiresIn: this.ttlSeconds() });
  }

  async verify(token: string): Promise<AccessTokenClaims> {
    // `verifyAsync` and not `decode`: decoding parses the payload without checking the
    // signature, which accepts anything the caller cares to write.
    const payload = await this.jwt.verifyAsync<AccessTokenClaims>(token, { secret: this.env.JWT_ACCESS_SECRET });
    return { sub: payload.sub, email: payload.email };
  }

  ttlSeconds(): number {
    return parseDuration(this.env.ACCESS_TOKEN_TTL);
  }
}

/** `15m`, `2h`, `900`. Returned in the login response so the client can schedule a refresh
 * rather than discovering the expiry as a failed request. */
export function parseDuration(value: string): number {
  const match = /^(\d+)([smhd])?$/.exec(value.trim());
  if (!match) return 900;
  const amount = Number(match[1]);
  const unit = match[2] ?? "s";
  return amount * { s: 1, m: 60, h: 3600, d: 86400 }[unit as "s" | "m" | "h" | "d"];
}
