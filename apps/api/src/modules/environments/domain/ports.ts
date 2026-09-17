import type { Cookie } from "@eq/runner-core";
import type { Credential, CredentialRole, Environment } from "./model";
import type { SessionToken } from "./session-token";

export const ENVIRONMENT_REPOSITORY = Symbol("ENVIRONMENT_REPOSITORY");

export interface EnvironmentRepositoryPort {
  findById(id: string): Promise<Environment | null>;
  findByName(projectId: string, name: string): Promise<Environment | null>;
  listForProject(projectId: string): Promise<Environment[]>;
  save(environment: Environment): Promise<void>;
  remove(id: string): Promise<void>;

  listCredentials(environmentId: string): Promise<Credential[]>;
  findCredential(environmentId: string, role: CredentialRole): Promise<Credential | null>;
  saveCredential(credential: Credential): Promise<void>;
  removeCredential(environmentId: string, role: CredentialRole): Promise<void>;
}

export const SESSION_TOKEN_REPOSITORY = Symbol("SESSION_TOKEN_REPOSITORY");

export interface SessionTokenRepositoryPort {
  find(actorId: string, projectId: string): Promise<SessionToken | null>;
  save(token: SessionToken): Promise<void>;
  remove(actorId: string, projectId: string): Promise<void>;
}

export const COOKIE_JAR_REPOSITORY = Symbol("COOKIE_JAR_REPOSITORY");

/**
 * El tarro de cookies de una persona en un proyecto.
 *
 * Por persona, como el token de sesión: la cookie que consigue quien está probando es su sesión, y
 * compartirla entre los miembros de una organización sería darles la sesión de otro.
 */
export interface CookieJarRepositoryPort {
  list(actorId: string, projectId: string): Promise<Cookie[]>;
  save(actorId: string, projectId: string, jar: Cookie[]): Promise<void>;
  remove(actorId: string, projectId: string, keys: Pick<Cookie, "domain" | "path" | "name">[]): Promise<void>;
  clear(actorId: string, projectId: string): Promise<void>;
  purgeExpired(actorId: string, projectId: string, now: Date): Promise<void>;
}
