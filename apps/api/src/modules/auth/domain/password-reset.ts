/**
 * A «forgot my password» link, as stored.
 *
 * Its own table and not two columns on `users`: a person can ask twice before the first mail
 * arrives, and both links have to stop working the moment either is used. With one column the
 * second request would silently invalidate the first — which is the one in the inbox.
 *
 * Only the SHA-256 of the token is kept, the same as a refresh token: a database dump must not
 * hand over a link that sets somebody's password.
 */
export type PasswordResetToken = {
  id: string;
  userId: string;
  tokenHash: string;
  createdAt: Date;
  expiresAt: Date;
  usedAt: Date | null;
};

/** One hour. Long enough for a mail to arrive and be read; short enough that an old mailbox is
 * not a stash of working links. */
export const PASSWORD_RESET_TTL_MS = 60 * 60 * 1000;

export function resetTokenUsable(token: PasswordResetToken, now: Date): boolean {
  return token.usedAt === null && token.expiresAt.getTime() > now.getTime();
}

export const PASSWORD_RESET_REPOSITORY = Symbol("PASSWORD_RESET_REPOSITORY");

export interface PasswordResetRepositoryPort {
  save(token: PasswordResetToken): Promise<void>;
  findByHash(hash: string): Promise<PasswordResetToken | null>;
  /** Spends every outstanding link of a user at once: using one closes the others. */
  spendAllForUser(userId: string, at: Date): Promise<void>;
}
