import { Module } from "@nestjs/common";
import { CqrsModule } from "@nestjs/cqrs";
import { JwtModule } from "@nestjs/jwt";
import { TypeOrmModule } from "@nestjs/typeorm";

import { ApiTokenEntity, RefreshTokenEntity, UserEntity } from "@/shared/database/entities";
import { PASSWORD_HASHER, ScryptPasswordHasher } from "@/shared/crypto/password-hasher";
import { IamModule } from "@/modules/iam/iam.module";
import { ACCESS_TOKEN_SERVICE } from "./domain/access-token";
import { API_TOKEN_REPOSITORY, REFRESH_TOKEN_REPOSITORY, USER_REPOSITORY } from "./domain/ports";
import { JwtAccessTokenService } from "./infrastructure/jwt-access-token.service";
import { TypeOrmApiTokenRepository, TypeOrmRefreshTokenRepository, TypeOrmUserRepository } from "./infrastructure/persistence/typeorm-repositories";
import { AuthGuard } from "./infrastructure/guards/auth.guard";
import { RegisterUserHandler } from "./application/commands/register-user";
import { LoginUserHandler } from "./application/commands/login-user";
import { RefreshSessionHandler } from "./application/commands/refresh-session";
import { LogoutUserHandler } from "./application/commands/logout-user";
import { ChangePasswordHandler } from "./application/commands/change-password";
import { IssueApiTokenHandler } from "./application/commands/issue-api-token";
import { RevokeApiTokenHandler } from "./application/commands/revoke-api-token";
import { GetAuthContextHandler, GetCurrentUserHandler } from "./application/queries/get-current-user";
import { ListApiTokensHandler } from "./application/queries/list-api-tokens";
import { AuthController } from "./presentation/auth.controller";

export const AUTH_COMMAND_HANDLERS = [
  RegisterUserHandler, LoginUserHandler, RefreshSessionHandler, LogoutUserHandler,
  ChangePasswordHandler, IssueApiTokenHandler, RevokeApiTokenHandler,
];
export const AUTH_QUERY_HANDLERS = [GetCurrentUserHandler, GetAuthContextHandler, ListApiTokensHandler];

/**
 * The ports are bound to Postgres adapters *here*, and only here. Every test that needs
 * different adapters overrides these three tokens and leaves the handlers untouched — which is
 * the practical reason the ports exist at all.
 */
export const AUTH_ADAPTERS = [
  { provide: USER_REPOSITORY, useClass: TypeOrmUserRepository },
  { provide: REFRESH_TOKEN_REPOSITORY, useClass: TypeOrmRefreshTokenRepository },
  { provide: API_TOKEN_REPOSITORY, useClass: TypeOrmApiTokenRepository },
  { provide: PASSWORD_HASHER, useClass: ScryptPasswordHasher },
  { provide: ACCESS_TOKEN_SERVICE, useClass: JwtAccessTokenService },
];

@Module({
  imports: [CqrsModule, JwtModule.register({}), TypeOrmModule.forFeature([UserEntity, RefreshTokenEntity, ApiTokenEntity]), IamModule],
  controllers: [AuthController],
  providers: [...AUTH_ADAPTERS, ...AUTH_COMMAND_HANDLERS, ...AUTH_QUERY_HANDLERS, AuthGuard],
  exports: [ACCESS_TOKEN_SERVICE, USER_REPOSITORY, API_TOKEN_REPOSITORY, PASSWORD_HASHER, AuthGuard],
})
export class AuthModule {}
