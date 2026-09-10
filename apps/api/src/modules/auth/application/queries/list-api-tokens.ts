import type { ApiTokenViewOf } from "@eq/contracts";

import { Inject } from "@nestjs/common";
import { QueryHandler, type IQuery, type IQueryHandler } from "@nestjs/cqrs";

import { API_TOKEN_REPOSITORY, type ApiTokenRepositoryPort } from "../../domain/ports";

export class ListApiTokensQuery implements IQuery {
  constructor(readonly organizationId: string) {}
}

export type ApiTokenView = ApiTokenViewOf<Date>;

/** The token list an operator sees. `tokenHash` never appears in it — the hash is not the secret,
 * but publishing it turns an offline check of a guessed token into a free oracle. */
@QueryHandler(ListApiTokensQuery)
export class ListApiTokensHandler implements IQueryHandler<ListApiTokensQuery, ApiTokenView[]> {
  constructor(@Inject(API_TOKEN_REPOSITORY) private readonly tokens: ApiTokenRepositoryPort) {}

  async execute(query: ListApiTokensQuery): Promise<ApiTokenView[]> {
    return (await this.tokens.listForOrganization(query.organizationId)).map((token) => ({
      id: token.id,
      name: token.name,
      preview: token.preview,
      createdAt: token.createdAt,
      lastUsedAt: token.lastUsedAt,
      revokedAt: token.revokedAt,
    }));
  }
}
