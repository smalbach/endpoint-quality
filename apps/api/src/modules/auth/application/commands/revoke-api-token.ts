import { Inject } from "@nestjs/common";
import { CommandHandler, type ICommand, type ICommandHandler } from "@nestjs/cqrs";

import { NotFoundError } from "@/shared/errors/domain-error";
import { CLOCK, type ClockPort } from "@/shared/clock/clock.port";
import { API_TOKEN_REPOSITORY, type ApiTokenRepositoryPort } from "../../domain/ports";

export class RevokeApiTokenCommand implements ICommand {
  constructor(
    readonly organizationId: string,
    readonly tokenId: string,
  ) {}
}

@CommandHandler(RevokeApiTokenCommand)
export class RevokeApiTokenHandler implements ICommandHandler<RevokeApiTokenCommand, void> {
  constructor(
    @Inject(API_TOKEN_REPOSITORY) private readonly tokens: ApiTokenRepositoryPort,
    @Inject(CLOCK) private readonly clock: ClockPort,
  ) {}

  async execute(command: RevokeApiTokenCommand): Promise<void> {
    const token = await this.tokens.findById(command.tokenId);
    // The organization check is inside the 404 rather than beside it: answering 403 for a token
    // that belongs to someone else confirms the id exists, which is a membership oracle across
    // tenants. To this caller it does not exist.
    if (!token || token.organizationId !== command.organizationId)
      throw new NotFoundError("El token no existe", "api-token-not-found");
    if (token.revokedAt) return;
    await this.tokens.save({ ...token, revokedAt: this.clock.now() });
  }
}
