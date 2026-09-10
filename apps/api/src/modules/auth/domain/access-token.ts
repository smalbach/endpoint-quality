/** What a signed access token carries. Deliberately small: an id, and nothing that goes stale.
 * Roles are **not** in here — a membership revoked thirty seconds ago must not keep working for
 * the rest of the token's life, so authorization is resolved per request against the database. */
export type AccessTokenClaims = {
  sub: string;
  email: string;
};

export const ACCESS_TOKEN_SERVICE = Symbol("ACCESS_TOKEN_SERVICE");

export interface AccessTokenServicePort {
  sign(claims: AccessTokenClaims): Promise<string>;
  verify(token: string): Promise<AccessTokenClaims>;
  /** Seconds until the signed token expires, so the client can schedule a refresh instead of
   * discovering the expiry as a failed request. */
  ttlSeconds(): number;
}
