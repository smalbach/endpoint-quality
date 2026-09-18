/**
 * Everything a request needs before it can be sent: the contract, the configuration, and the
 * environment resolved into a target.
 *
 * It was `RunOrchestrator.prepare` until a second caller appeared. A matrix of 311 cases and a
 * single request sent from the editor have to be set up identically — the same `writesAllowed`,
 * the same decrypted variables, the same document dereferenced once — because the editor exists
 * to explain what a run did. Two copies of this would agree right up until somebody changed one,
 * and the symptom would be a request that passes in the editor and fails in the run.
 *
 * The document is fetched **per context**, which for a run means once at the start. Re-reading it
 * mid-run would have the last case asserting against a contract the first one never saw, which is
 * the exact drift this product detects and therefore cannot also be how it operates.
 */
import { Inject, Injectable } from "@nestjs/common";
import {
  dereference,
  resolveOperations,
  withEnvironmentNamespace,
  type Operation,
  type ProjectConfig,
  type ResolvedOperation,
} from "@eq/runner-core";

import { SAFE_FETCH, type SafeFetchPort } from "@/shared/http/safe-fetch";
import { SECRET_CIPHER, type SecretCipherPort } from "@/shared/crypto/secret-cipher";
import { PROJECT_REPOSITORY, type ProjectRepositoryPort } from "@/modules/projects/domain/ports";
import { SPEC_REPOSITORY, type SpecRepositoryPort } from "@/modules/specs/domain/ports";
import { ENVIRONMENT_REPOSITORY, type EnvironmentRepositoryPort } from "@/modules/environments/domain/ports";
import { resolveVariables } from "@/modules/environments/domain/model";
import { CONFIG_REPOSITORY, type ConfigRepositoryPort } from "@/modules/config/domain/ports";
import { assembleProjectConfig } from "@/modules/config/application/queries/get-project-config";
import type { ExecutionTarget } from "./case-executor";

export type ExecutionContext = {
  config: ProjectConfig;
  resolved: ResolvedOperation[];
  target: ExecutionTarget;
  authEnabled: boolean;
};

@Injectable()
export class ExecutionContextFactory {
  constructor(
    @Inject(PROJECT_REPOSITORY) private readonly projects: ProjectRepositoryPort,
    @Inject(SPEC_REPOSITORY) private readonly specs: SpecRepositoryPort,
    @Inject(ENVIRONMENT_REPOSITORY) private readonly environments: EnvironmentRepositoryPort,
    @Inject(CONFIG_REPOSITORY) private readonly config: ConfigRepositoryPort,
    @Inject(SECRET_CIPHER) private readonly cipher: SecretCipherPort,
    @Inject(SAFE_FETCH) private readonly http: SafeFetchPort,
  ) {}

  async build(input: {
    projectId: string;
    environmentId: string | null;
    /** Null on a run that reads no operation (see `Run.specVersionId`): nothing is resolved, and the
     * live contract is not fetched either — a channel run has no business calling `/openapi.json`. */
    specVersionId: string | null;
  }): Promise<ExecutionContext> {
    const project = await this.projects.findById(input.projectId);
    if (!project) throw new Error("El proyecto ya no existe");

    const environment = input.environmentId ? await this.environments.findById(input.environmentId) : null;
    if (!environment) throw new Error("Hace falta un entorno con URL base");

    const stored = input.specVersionId ? await this.specs.listOperations(input.specVersionId) : [];
    if (input.specVersionId && stored.length === 0) throw new Error("La versión del contrato no tiene operaciones");

    const config = await assembleProjectConfig(this.config, project.id);
    const operations: Operation[] = stored.map(
      ({ rowId, specVersionId, position, derivedId, security, ...operation }) => operation,
    );
    const resolved = resolveOperations(operations, config);

    const plain = resolveVariables(environment.variables, (payload) => this.cipher.decrypt(payload));
    const target: ExecutionTarget = {
      baseUrl: environment.baseUrl,
      writesAllowed: environment.writesAllowed,
      credentials: await this.environments.listCredentials(environment.id),
      // Resolved, not copied: `current` over `initial`, and a sensitive one decrypted here so that
      // nothing further down has to know the concept exists.
      variables: withEnvironmentNamespace(plain),
      // …except what a script prints, which is redacted against these before it is stored.
      secrets: Object.entries(environment.variables)
        .filter(([, variable]) => variable.sensitive)
        .map(([name]) => plain[name])
        .filter((value): value is string => Boolean(value)),
      // Nothing has logged in yet. A flow step may publish one while walking.
      session: null,
      // Y el tarro empieza vacío: lo llena el primer `Set-Cookie` de la corrida.
      cookies: [],
      ...(input.specVersionId
        ? await this.loadSpec(environment.specUrl ?? `${environment.baseUrl}/openapi.json`)
        : { spec: null, specError: "La corrida no usa el contrato del proyecto" }),
    };

    return { config, resolved, target, authEnabled: environment.authEnforced };
  }

  /**
   * The document the schema assertion reads.
   *
   * A failure here is **not** fatal: whatever is being executed continues and falls back to the
   * envelope check, saying so in its detail. A target that does not publish its contract is worth
   * testing with what is available rather than not at all — and the operator is told which
   * assertion they are not getting.
   */
  private async loadSpec(specUrl: string): Promise<{ spec: Record<string, unknown> | null; specError: string | null }> {
    try {
      const response = await this.http.get(specUrl);
      if (response.status >= 400) return { spec: null, specError: `El contrato en vivo respondió ${response.status}` };
      const parsed = JSON.parse(response.body) as Record<string, unknown>;
      // Dereferenced once: resolving `$ref` per case over a 3 000-line document is the same work
      // done 311 times.
      return { spec: dereference(parsed, parsed) as Record<string, unknown>, specError: null };
    } catch (error) {
      return { spec: null, specError: error instanceof Error ? error.message : "No se pudo leer el contrato en vivo" };
    }
  }
}
