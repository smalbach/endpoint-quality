import type { Cookie } from "@eq/runner-core";
import type { LifecycleState } from "@/shared/lifecycle/lifecycle";
import type { Credential, CredentialRole, Environment } from "./model";
import type { SessionToken } from "./session-token";

export const ENVIRONMENT_REPOSITORY = Symbol("ENVIRONMENT_REPOSITORY");

export interface EnvironmentRepositoryPort {
  /**
   * El entorno, **solo si está vivo**.
   *
   * Por aquí entran todos los ejecutores —una corrida, un monitor, una prueba de carga, un envío
   * suelto—, así que un entorno archivado o eliminado deja de poder ejecutarse en el mismo momento
   * en que sale de la lista. Es lo contrario de lo que pasaba antes: la fila se borraba de verdad y
   * el monitor que la nombraba fallaba cada noche sin decir por qué.
   */
  findById(id: string): Promise<Environment | null>;
  /** El entorno **en cualquier estado**, para archivarlo, restaurarlo o mirarlo en la papelera. */
  findAnyById(id: string): Promise<Environment | null>;
  /** Por nombre, **solo entre los vivos**: el nombre de un entorno eliminado queda libre. */
  findByName(projectId: string, name: string): Promise<Environment | null>;
  /** Los de ese estado. Sin estado, los activos. */
  listForProject(projectId: string, state?: LifecycleState): Promise<Environment[]>;
  save(environment: Environment): Promise<void>;
  /** El borrado de verdad, con sus credenciales por cascada. Solo «eliminar para siempre». */
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
