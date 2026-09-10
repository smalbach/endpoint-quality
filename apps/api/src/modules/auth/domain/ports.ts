/**
 * What the auth handlers need from the outside world, as interfaces they own.
 *
 * The direction of the dependency is the point: the application layer declares what persistence
 * must provide, and `infrastructure` implements it. Nothing here knows that the answer is
 * Postgres, and the unit tests substitute in-memory maps without a container running.
 */
import type { ApiToken, RefreshToken, User } from "./model";

export const USER_REPOSITORY = Symbol("USER_REPOSITORY");
export const REFRESH_TOKEN_REPOSITORY = Symbol("REFRESH_TOKEN_REPOSITORY");
export const API_TOKEN_REPOSITORY = Symbol("API_TOKEN_REPOSITORY");

export interface UserRepositoryPort {
  findById(id: string): Promise<User | null>;
  findByEmail(email: string): Promise<User | null>;
  save(user: User): Promise<void>;
}

export interface RefreshTokenRepositoryPort {
  findByHash(hash: string): Promise<RefreshToken | null>;
  save(token: RefreshToken): Promise<void>;
  markUsed(id: string, at: Date, replacedByHash: string): Promise<void>;
  /** Revokes every token of one session in a single statement. Reuse detection has to close the
   * whole chain, and doing it row by row leaves a window in which the thief refreshes again. */
  revokeSession(sessionId: string, at: Date): Promise<void>;
  revokeAllForUser(userId: string, at: Date): Promise<void>;
}

export interface ApiTokenRepositoryPort {
  findByHash(hash: string): Promise<ApiToken | null>;
  findById(id: string): Promise<ApiToken | null>;
  listForOrganization(organizationId: string): Promise<ApiToken[]>;
  save(token: ApiToken): Promise<void>;
  touch(id: string, at: Date): Promise<void>;
}
