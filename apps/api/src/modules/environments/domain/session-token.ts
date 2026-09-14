/**
 * The token a person is working with in a project, captured rather than configured.
 *
 * Two ways it arrives, the two the analyzer had: the project's login endpoint answered with one,
 * or a post-response script set a variable called `token`. It is **one person's**, because two
 * people testing the same API as two different users is the ordinary case, and it is kept
 * encrypted on the server instead of in the browser's memory, where a reload lost it.
 */
export const SESSION_TOKEN_SOURCES = ["login", "script"] as const;
export type SessionTokenSource = (typeof SESSION_TOKEN_SOURCES)[number];

export type SessionToken = {
  /** The user, or the API token, that captured it. */
  actorId: string;
  projectId: string;
  tokenCiphertext: string;
  claims: Record<string, unknown> | null;
  expiresAt: Date | null;
  capturedAt: Date;
  source: SessionTokenSource;
};

export type SessionTokenView = {
  source: SessionTokenSource;
  capturedAt: Date;
  expiresAt: Date | null;
  expired: boolean;
  /** Every claim. Which ones are worth showing is the screen's call. */
  claims: Record<string, unknown> | null;
  /** Enough to recognise it, not enough to use it. */
  preview: string;
};

/**
 * The payload of a JWT, when it is one. Not verified — there is no key to verify it with, and it
 * is only read to say who the token is and when it runs out.
 */
export function decodeJwtClaims(token: string): Record<string, unknown> | null {
  const parts = token.split(".");
  if (parts.length !== 3 || !parts[1]) return null;
  try {
    const payload: unknown = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    return payload && typeof payload === "object" && !Array.isArray(payload)
      ? (payload as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

export function expiryOf(claims: Record<string, unknown> | null): Date | null {
  return claims && typeof claims.exp === "number" && Number.isFinite(claims.exp) ? new Date(claims.exp * 1000) : null;
}

export function isExpired(token: Pick<SessionToken, "expiresAt">, now: Date): boolean {
  return token.expiresAt !== null && token.expiresAt.getTime() <= now.getTime();
}

export function viewSessionToken(token: SessionToken, plain: string, now: Date): SessionTokenView {
  return {
    source: token.source,
    capturedAt: token.capturedAt,
    expiresAt: token.expiresAt,
    expired: isExpired(token, now),
    claims: token.claims,
    preview: plain.length > 16 ? `${plain.slice(0, 10)}…${plain.slice(-4)}` : "••••••••",
  };
}
