import { randomUUID } from "node:crypto";
import { Inject } from "@nestjs/common";
import { CommandHandler, type ICommand, type ICommandHandler } from "@nestjs/cqrs";

import { CLOCK, type ClockPort } from "@/shared/clock/clock.port";
import { generateOpaqueToken, hashOpaqueToken, tokenPreview } from "@/shared/crypto/opaque-token";
import { API_TOKEN_REPOSITORY, type ApiTokenRepositoryPort } from "../../domain/ports";

export class IssueApiTokenCommand implements ICommand {
  constructor(readonly organizationId: string, readonly name: string, readonly createdBy: string) {}
}

/**
 * Mints a service credential for CI.
 *
 * The plaintext is returned **once**, from this call, and never stored — only its SHA-256 and a
 * six-character preview so an operator can tell two tokens apart in a list. A product that can
 * show you a token you created last month is a product whose database dump is a set of live
 * credentials.
 */
@CommandHandler(IssueApiTokenCommand)
export class IssueApiTokenHandler implements ICommandHandler<IssueApiTokenCommand, { id: string; token: string; preview: string }> {
  constructor(
    @Inject(API_TOKEN_REPOSITORY) private readonly tokens: ApiTokenRepositoryPort,
    @Inject(CLOCK) private readonly clock: ClockPort,
  ) {}

  async execute(command: IssueApiTokenCommand) {
    // Prefixed so a leaked token is recognisable in a log or a public repository by automated
    // secret scanners, and by whoever finds it.
    const token = `eqt_${generateOpaqueToken()}`;
    const id = randomUUID();
    await this.tokens.save({
      id,
      organizationId: command.organizationId,
      name: command.name.trim() || "Token de CI",
      tokenHash: hashOpaqueToken(token),
      preview: tokenPreview(token),
      createdBy: command.createdBy,
      createdAt: this.clock.now(),
      lastUsedAt: null,
      revokedAt: null,
    });
    return { id, token, preview: tokenPreview(token) };
  }
}
