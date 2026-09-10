"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.AuthModule = exports.AUTH_ADAPTERS = exports.AUTH_QUERY_HANDLERS = exports.AUTH_COMMAND_HANDLERS = void 0;
const common_1 = require("@nestjs/common");
const cqrs_1 = require("@nestjs/cqrs");
const jwt_1 = require("@nestjs/jwt");
const typeorm_1 = require("@nestjs/typeorm");
const entities_1 = require("../../shared/database/entities");
const password_hasher_1 = require("../../shared/crypto/password-hasher");
const iam_module_1 = require("../iam/iam.module");
const access_token_1 = require("./domain/access-token");
const ports_1 = require("./domain/ports");
const jwt_access_token_service_1 = require("./infrastructure/jwt-access-token.service");
const typeorm_repositories_1 = require("./infrastructure/persistence/typeorm-repositories");
const auth_guard_1 = require("./infrastructure/guards/auth.guard");
const register_user_1 = require("./application/commands/register-user");
const login_user_1 = require("./application/commands/login-user");
const refresh_session_1 = require("./application/commands/refresh-session");
const logout_user_1 = require("./application/commands/logout-user");
const change_password_1 = require("./application/commands/change-password");
const issue_api_token_1 = require("./application/commands/issue-api-token");
const revoke_api_token_1 = require("./application/commands/revoke-api-token");
const get_current_user_1 = require("./application/queries/get-current-user");
const list_api_tokens_1 = require("./application/queries/list-api-tokens");
const auth_controller_1 = require("./presentation/auth.controller");
exports.AUTH_COMMAND_HANDLERS = [
    register_user_1.RegisterUserHandler, login_user_1.LoginUserHandler, refresh_session_1.RefreshSessionHandler, logout_user_1.LogoutUserHandler,
    change_password_1.ChangePasswordHandler, issue_api_token_1.IssueApiTokenHandler, revoke_api_token_1.RevokeApiTokenHandler,
];
exports.AUTH_QUERY_HANDLERS = [get_current_user_1.GetCurrentUserHandler, list_api_tokens_1.ListApiTokensHandler];
/**
 * The ports are bound to Postgres adapters *here*, and only here. Every test that needs
 * different adapters overrides these three tokens and leaves the handlers untouched — which is
 * the practical reason the ports exist at all.
 */
exports.AUTH_ADAPTERS = [
    { provide: ports_1.USER_REPOSITORY, useClass: typeorm_repositories_1.TypeOrmUserRepository },
    { provide: ports_1.REFRESH_TOKEN_REPOSITORY, useClass: typeorm_repositories_1.TypeOrmRefreshTokenRepository },
    { provide: ports_1.API_TOKEN_REPOSITORY, useClass: typeorm_repositories_1.TypeOrmApiTokenRepository },
    { provide: password_hasher_1.PASSWORD_HASHER, useClass: password_hasher_1.ScryptPasswordHasher },
    { provide: access_token_1.ACCESS_TOKEN_SERVICE, useClass: jwt_access_token_service_1.JwtAccessTokenService },
];
let AuthModule = class AuthModule {
};
exports.AuthModule = AuthModule;
exports.AuthModule = AuthModule = __decorate([
    (0, common_1.Module)({
        imports: [cqrs_1.CqrsModule, jwt_1.JwtModule.register({}), typeorm_1.TypeOrmModule.forFeature([entities_1.UserEntity, entities_1.RefreshTokenEntity, entities_1.ApiTokenEntity]), iam_module_1.IamModule],
        controllers: [auth_controller_1.AuthController],
        providers: [...exports.AUTH_ADAPTERS, ...exports.AUTH_COMMAND_HANDLERS, ...exports.AUTH_QUERY_HANDLERS, auth_guard_1.AuthGuard],
        exports: [access_token_1.ACCESS_TOKEN_SERVICE, ports_1.USER_REPOSITORY, ports_1.API_TOKEN_REPOSITORY, password_hasher_1.PASSWORD_HASHER, auth_guard_1.AuthGuard],
    })
], AuthModule);
//# sourceMappingURL=auth.module.js.map