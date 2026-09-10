/**
 * The auth domain: who a user is, and the two kinds of long-lived credential they hold.
 *
 * No TypeORM, no Nest, no HTTP. These types are what the handlers reason about; the columns
 * that store them live in `infrastructure/persistence` and are free to look different.
 */

export type UserStatus = "active" | "invited" | "disabled";

export type User = {
  id: string;
  email: string;
  name: string;
  passwordDigest: string;
  status: UserStatus;
  createdAt: Date;
};

/**
 * A refresh token, and the session it belongs to.
 *
 * `sessionId` is the part that does the work. Rotation alone does not stop a stolen token: the
 * thief refreshes, gets a new pair, and the legitimate user's next refresh presents a token that
 * was already spent. Grouping every rotation of one login under a session id makes that second
 * refresh **detectable** — an already-used token being presented again means two parties hold
 * the chain, and the whole session is revoked rather than the one token.
 *
 * That is why `usedAt` is kept instead of deleting the row: a token that is gone is
 * indistinguishable from a token that never existed, and the reuse signal disappears with it.
 */
export type RefreshToken = {
  id: string;
  userId: string;
  sessionId: string;
  tokenHash: string;
  expiresAt: Date;
  createdAt: Date;
  usedAt: Date | null;
  revokedAt: Date | null;
  /** The token this one was rotated into, so an operator can walk the chain of a session. */
  replacedByHash: string | null;
};

/** A service credential, scoped to one organization, for launching runs from CI. */
export type ApiToken = {
  id: string;
  organizationId: string;
  name: string;
  tokenHash: string;
  preview: string;
  createdBy: string;
  createdAt: Date;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
};

export function isActive(user: User): boolean {
  return user.status === "active";
}

/**
 * Whether a refresh token can be spent right now, and why not when it cannot.
 *
 * `reused` is separated from `expired` and `revoked` on purpose: the first is an attack signal
 * that must revoke the session, the other two are ordinary ends of life that must not.
 */
export type RefreshVerdict = { usable: true } | { usable: false; reason: "expired" | "revoked" | "reused" };

export function verifyRefreshToken(token: RefreshToken, now: Date): RefreshVerdict {
  if (token.usedAt) return { usable: false, reason: "reused" };
  if (token.revokedAt) return { usable: false, reason: "revoked" };
  if (token.expiresAt.getTime() <= now.getTime()) return { usable: false, reason: "expired" };
  return { usable: true };
}

/** Emails are compared case-insensitively and stored as entered, trimmed. Two accounts that
 * differ only in capitalisation are one account to every user who ever types one of them. */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}
