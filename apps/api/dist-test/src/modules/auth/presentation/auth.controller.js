"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var __metadata = (this && this.__metadata) || function (k, v) {
    if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(k, v);
};
var __param = (this && this.__param) || function (paramIndex, decorator) {
    return function (target, key) { decorator(target, key, paramIndex); }
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.AuthController = void 0;
/**
 * The HTTP surface of a session.
 *
 * The refresh token travels as an **httpOnly, SameSite=Strict cookie** and is also accepted in
 * the body. That is not indecision:
 *
 * - a browser must not be able to read it from JavaScript, or any XSS on the dashboard hands
 *   over a thirty-day credential — so httpOnly, and the SPA never sees it;
 * - a CLI, a CI job or a test has no cookie jar, and forcing one on them means reimplementing
 *   cookie parsing to call an API.
 *
 * The access token is returned in the body instead, and deliberately not as a cookie: it is
 * meant to be held in memory by the SPA and sent as `Authorization`, which is what makes CSRF
 * structurally impossible against the authenticated routes — a forged cross-site request can
 * carry cookies, but it cannot set that header.
 */
const common_1 = require("@nestjs/common");
const cqrs_1 = require("@nestjs/cqrs");
const throttler_1 = require("@nestjs/throttler");
const env_1 = require("../../../shared/config/env");
const common_2 = require("@nestjs/common");
const domain_error_1 = require("../../../shared/errors/domain-error");
const register_user_1 = require("../application/commands/register-user");
const login_user_1 = require("../application/commands/login-user");
const refresh_session_1 = require("../application/commands/refresh-session");
const logout_user_1 = require("../application/commands/logout-user");
const change_password_1 = require("../application/commands/change-password");
const get_current_user_1 = require("../application/queries/get-current-user");
const auth_guard_1 = require("../infrastructure/guards/auth.guard");
const auth_dto_1 = require("./dto/auth.dto");
const REFRESH_COOKIE = "eq_refresh";
let AuthController = class AuthController {
    commandBus;
    queryBus;
    env;
    constructor(commandBus, queryBus, env) {
        this.commandBus = commandBus;
        this.queryBus = queryBus;
        this.env = env;
    }
    async register(body) {
        return this.commandBus.execute(new register_user_1.RegisterUserCommand(body.email, body.password, body.name, body.organizationName));
    }
    async login(body, response) {
        const session = await this.commandBus.execute(new login_user_1.LoginUserCommand(body.email, body.password));
        return this.respondWithSession(session, response);
    }
    async refresh(body, request, response) {
        const token = body.refreshToken ?? request.cookies?.[REFRESH_COOKIE];
        if (!token)
            throw new domain_error_1.UnauthenticatedError("Falta el refresh token");
        const session = await this.commandBus.execute(new refresh_session_1.RefreshSessionCommand(token));
        return this.respondWithSession(session, response);
    }
    async logout(body, request, response, principal) {
        if (principal.kind !== "user")
            throw new domain_error_1.UnauthenticatedError("Un token de servicio no tiene sesión que cerrar");
        const token = body.refreshToken ?? request.cookies?.[REFRESH_COOKIE];
        await this.commandBus.execute(new logout_user_1.LogoutUserCommand(token, body.everywhere ?? false, principal.userId));
        // Cleared with the same attributes it was set with, or the browser keeps the old one and the
        // next refresh presents a token the server has already revoked.
        response.clearCookie(REFRESH_COOKIE, this.cookieOptions());
    }
    async changePassword(body, response, principal) {
        if (principal.kind !== "user")
            throw new domain_error_1.UnauthenticatedError("Un token de servicio no tiene contraseña");
        await this.commandBus.execute(new change_password_1.ChangePasswordCommand(principal.userId, body.currentPassword, body.newPassword));
        // Changing the password logs every session out, including this one. Leaving the cookie in
        // place would leave the browser holding a credential the server has just revoked.
        response.clearCookie(REFRESH_COOKIE, this.cookieOptions());
    }
    async me(principal) {
        if (principal.kind !== "user")
            throw new domain_error_1.UnauthenticatedError("Un token de servicio no representa a una persona");
        return this.queryBus.execute(new get_current_user_1.GetCurrentUserQuery(principal.userId));
    }
    respondWithSession(session, response) {
        response.cookie(REFRESH_COOKIE, session.refreshToken, {
            ...this.cookieOptions(),
            expires: session.refreshExpiresAt,
        });
        // The refresh token is *also* in the body, for callers with no cookie jar. The browser
        // client ignores it and lets the cookie do the work.
        return {
            userId: session.userId,
            accessToken: session.accessToken,
            expiresIn: session.expiresIn,
            refreshToken: session.refreshToken,
        };
    }
    cookieOptions() {
        return {
            httpOnly: true,
            // Strict rather than Lax: this cookie is only ever sent by our own front end, never as
            // part of a navigation, so there is nothing to relax it for.
            sameSite: "strict",
            secure: this.env.NODE_ENV === "production",
            // `/` and not `/auth`.
            //
            // The narrow path looked tidier and was wrong: the API is normally served under a prefix —
            // `/api` through nginx in the compose file, the same through Vite in development — so the
            // browser sees `/api/auth/refresh`, which `path=/auth` does not match. The cookie was
            // never sent, refresh always failed, and the session died on every page reload. It failed
            // silently, because the app simply showed the login screen.
            //
            // What the narrow path bought was small: httpOnly and SameSite=Strict are what actually
            // protect this cookie, and neither depends on the path.
            path: "/",
            ...(this.env.COOKIE_DOMAIN ? { domain: this.env.COOKIE_DOMAIN } : {}),
        };
    }
};
exports.AuthController = AuthController;
__decorate([
    (0, auth_guard_1.Public)()
    // Registration is rate limited as tightly as login: it writes a row and runs the KDF, so it is
    // both a spam vector and a way to make the server do expensive work for free.
    ,
    (0, throttler_1.Throttle)({ default: { limit: 5, ttl: 60_000 } }),
    (0, common_1.Post)("register"),
    __param(0, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [auth_dto_1.RegisterDto]),
    __metadata("design:returntype", Promise)
], AuthController.prototype, "register", null);
__decorate([
    (0, auth_guard_1.Public)(),
    (0, throttler_1.Throttle)({ default: { limit: 10, ttl: 60_000 } }),
    (0, common_1.HttpCode)(200),
    (0, common_1.Post)("login"),
    __param(0, (0, common_1.Body)()),
    __param(1, (0, common_1.Res)({ passthrough: true })),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [auth_dto_1.LoginDto, Object]),
    __metadata("design:returntype", Promise)
], AuthController.prototype, "login", null);
__decorate([
    (0, auth_guard_1.Public)(),
    (0, throttler_1.Throttle)({ default: { limit: 30, ttl: 60_000 } }),
    (0, common_1.HttpCode)(200),
    (0, common_1.Post)("refresh"),
    __param(0, (0, common_1.Body)()),
    __param(1, (0, common_1.Req)()),
    __param(2, (0, common_1.Res)({ passthrough: true })),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [auth_dto_1.RefreshDto, Object, Object]),
    __metadata("design:returntype", Promise)
], AuthController.prototype, "refresh", null);
__decorate([
    (0, common_1.HttpCode)(204),
    (0, common_1.Post)("logout"),
    __param(0, (0, common_1.Body)()),
    __param(1, (0, common_1.Req)()),
    __param(2, (0, common_1.Res)({ passthrough: true })),
    __param(3, (0, auth_guard_1.CurrentUser)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [auth_dto_1.LogoutDto, Object, Object, Object]),
    __metadata("design:returntype", Promise)
], AuthController.prototype, "logout", null);
__decorate([
    (0, common_1.HttpCode)(204),
    (0, common_1.Post)("change-password"),
    __param(0, (0, common_1.Body)()),
    __param(1, (0, common_1.Res)({ passthrough: true })),
    __param(2, (0, auth_guard_1.CurrentUser)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [auth_dto_1.ChangePasswordDto, Object, Object]),
    __metadata("design:returntype", Promise)
], AuthController.prototype, "changePassword", null);
__decorate([
    (0, common_1.Get)("me"),
    __param(0, (0, auth_guard_1.CurrentUser)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object]),
    __metadata("design:returntype", Promise)
], AuthController.prototype, "me", null);
exports.AuthController = AuthController = __decorate([
    (0, common_1.Controller)("auth"),
    __param(2, (0, common_2.Inject)(env_1.ENV)),
    __metadata("design:paramtypes", [cqrs_1.CommandBus,
        cqrs_1.QueryBus, Object])
], AuthController);
//# sourceMappingURL=auth.controller.js.map