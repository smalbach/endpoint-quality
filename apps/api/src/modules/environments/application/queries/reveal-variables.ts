import { Inject } from "@nestjs/common";
import { QueryHandler, type IQuery, type IQueryHandler } from "@nestjs/cqrs";

import { SECRET_CIPHER, type SecretCipherPort } from "@/shared/crypto/secret-cipher";
import { PROJECT_REPOSITORY, type ProjectRepositoryPort } from "@/modules/projects/domain/ports";
import { ENVIRONMENT_REPOSITORY, type EnvironmentRepositoryPort } from "../../domain/ports";
import { ownedEnvironment } from "../commands/manage-environment";

/**
 * The secrets of one environment, in the clear, on purpose.
 *
 * Somebody has to be able to check what a variable actually holds — that is the difference between
 * a secret and a value nobody can ever verify again. So this exists, and everything about it is
 * arranged so that using it is a decision:
 *
 * - **its own request**, not a `?reveal=true` on the list. A flag on the list means the ordinary
 *   read and the sensitive one are the same line in a log, and it makes «reveal everything in
 *   every environment» a single character away from a page load;
 * - **`admin`**, the same rung as storing a credential, because it answers the same question;
 * - **only the sensitive ones**, since the rest are already in the list.
 */
export class RevealVariablesQuery implements IQuery {
  constructor(
    readonly organizationId: string,
    readonly projectId: string,
    readonly environmentId: string,
  ) {}
}

@QueryHandler(RevealVariablesQuery)
export class RevealVariablesHandler implements IQueryHandler<RevealVariablesQuery, Record<string, string>> {
  constructor(
    @Inject(PROJECT_REPOSITORY) private readonly projects: ProjectRepositoryPort,
    @Inject(ENVIRONMENT_REPOSITORY) private readonly environments: EnvironmentRepositoryPort,
    @Inject(SECRET_CIPHER) private readonly cipher: SecretCipherPort,
  ) {}

  async execute(query: RevealVariablesQuery): Promise<Record<string, string>> {
    const environment = await ownedEnvironment(
      this.projects,
      this.environments,
      query.organizationId,
      query.projectId,
      query.environmentId,
    );
    const revealed: Record<string, string> = {};
    for (const [name, variable] of [
      ...Object.entries(environment.variables),
      ...Object.entries(environment.disabledVariables),
    ]) {
      if (!variable.sensitive) continue;
      const stored = variable.current || variable.initial;
      revealed[name] = stored ? this.cipher.decrypt(stored) : "";
    }
    return revealed;
  }
}
