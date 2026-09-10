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
exports.OrgRoleGuard = exports.AuthGuard = exports.CurrentRole = exports.CurrentUser = exports.RequireRole = exports.REQUIRED_ROLE = exports.Public = exports.IS_PUBLIC = void 0;
/**
 * Who is calling, and whether they may.
 *
 * Two guards, in this order, because they answer two different questions and conflating them is
 * how tenant isolation gets lost:
 *
 * - `AuthGuard` establishes **identity** — a signed access token, or an organization API token
 *   for CI. It says nothing about permissions.
 * - `OrgRoleGuard` establishes **authorization inside one organization**, resolved against the
 *   database on every request.
 *
 * Roles are deliberately absent from the access token. Putting them in the JWT saves a query and
 * costs correctness: a membership revoked thirty seconds ago would keep working for the rest of
 * the token's lifetime, and revocation that takes effect "in about fifteen minutes" is not
 * revocation.
 */
const common_1 = require("@nestjs/common");
const core_1 = require("@nestjs/core");
const domain_error_1 = require("../../../../shared/errors/domain-error");
const clock_port_1 = require("../../../../shared/clock/clock.port");
const opaque_token_1 = require("../../../../shared/crypto/opaque-token");
const model_1 = require("../../../iam/domain/model");
const ports_1 = require("../../../iam/domain/ports");
const access_token_1 = require("../../domain/access-token");
const ports_2 = require("../../domain/ports");
const model_2 = require("../../domain/model");
exports.IS_PUBLIC = "auth:public";
/** Marks a route as reachable without a credential. Opt-*out*, never opt-in: the guard is global,
 * so a new controller is protected by default and a forgotten decorator closes a door rather
 * than opening one. */
const Public = () => (0, common_1.SetMetadata)(exports.IS_PUBLIC, true);
exports.Public = Public;
exports.REQUIRED_ROLE = "auth:role";
const RequireRole = (role) => (0, common_1.SetMetadata)(exports.REQUIRED_ROLE, role);
exports.RequireRole = RequireRole;
exports.CurrentUser = (0, common_1.createParamDecorator)((_data, context) => {
    const request = context.switchToHttp().getRequest();
    if (!request.principal)
        throw new domain_error_1.UnauthenticatedError();
    return request.principal;
});
/** The role the caller holds in the organization this route addresses, resolved by `OrgRoleGuard`. */
exports.CurrentRole = (0, common_1.createParamDecorator)((_data, context) => context.switchToHttp().getRequest().membershipRole);
let AuthGuard = class AuthGuard {
    reflector;
    accessTokens;
    users;
    apiTokens;
    clock;
    constructor(reflector, accessTokens, users, apiTokens, clock) {
        this.reflector = reflector;
        this.accessTokens = accessTokens;
        this.users = users;
        this.apiTokens = apiTokens;
        this.clock = clock;
    }
    async canActivate(context) {
        if (this.reflector.getAllAndOverride(exports.IS_PUBLIC, [context.getHandler(), context.getClass()]))
            return true;
        const request = context.switchToHttp().getRequest();
        const header = request.headers.authorization;
        if (!header?.startsWith("Bearer "))
            throw new domain_error_1.UnauthenticatedError("Falta la credencial");
        const credential = header.slice("Bearer ".length).trim();
        request.principal = credential.startsWith("eqt_")
            ? await this.principalFromApiToken(credential)
            : await this.principalFromAccessToken(credential);
        return true;
    }
    async principalFromAccessToken(token) {
        let claims;
        try {
            claims = await this.accessTokens.verify(token);
        }
        catch {
            throw new domain_error_1.UnauthenticatedError("La credencial no es válida");
        }
        const user = await this.users.findById(claims.sub);
        // A signature that verifies is not the same as an account that still exists and is enabled.
        if (!user || !(0, model_2.isActive)(user))
            throw new domain_error_1.UnauthenticatedError("La credencial no es válida");
        return { kind: "user", userId: user.id, email: user.email };
    }
    async principalFromApiToken(token) {
        const stored = await this.apiTokens.findByHash((0, opaque_token_1.hashOpaqueToken)(token));
        if (!stored || stored.revokedAt)
            throw new domain_error_1.UnauthenticatedError("La credencial no es válida");
        // Recorded so an operator can see which CI tokens are still in use before revoking one, and
        // so an unused token is visible as unused.
        await this.apiTokens.touch(stored.id, this.clock.now());
        return { kind: "api-token", organizationId: stored.organizationId, tokenId: stored.id };
    }
};
exports.AuthGuard = AuthGuard;
exports.AuthGuard = AuthGuard = __decorate([
    (0, common_1.Injectable)(),
    __param(1, (0, common_1.Inject)(access_token_1.ACCESS_TOKEN_SERVICE)),
    __param(2, (0, common_1.Inject)(ports_2.USER_REPOSITORY)),
    __param(3, (0, common_1.Inject)(ports_2.API_TOKEN_REPOSITORY)),
    __param(4, (0, common_1.Inject)(clock_port_1.CLOCK)),
    __metadata("design:paramtypes", [core_1.Reflector, Object, Object, Object, Object])
], AuthGuard);
/**
 * Authorization inside one organization.
 *
 * The organization is taken from the route (`:organizationId`), which means a caller can *ask*
 * about any organization — and gets a 403 unless they are a member of that one. That is the
 * whole tenant boundary, and it is one lookup: no membership, no access, whatever the id in the
 * URL happens to be.
 */
let OrgRoleGuard = class OrgRoleGuard {
    reflector;
    memberships;
    constructor(reflector, memberships) {
        this.reflector = reflector;
        this.memberships = memberships;
    }
    async canActivate(context) {
        const required = this.reflector.getAllAndOverride(exports.REQUIRED_ROLE, [context.getHandler(), context.getClass()]);
        if (!required)
            return true;
        const request = context.switchToHttp().getRequest();
        const principal = request.principal;
        if (!principal)
            throw new domain_error_1.UnauthenticatedError();
        // Express types a route parameter as `string | string[]`: a path with the same name twice
        // yields an array, and comparing that to a stored id would never match while also never
        // failing loudly. Rejected instead.
        const organizationId = request.params?.organizationId;
        if (typeof organizationId !== "string" || !organizationId)
            throw new domain_error_1.ForbiddenError("La ruta no identifica una organización");
        if (principal.kind === "api-token") {
            // A CI token acts only inside the organization it was minted for, and at a fixed level:
            // it can launch runs and read, and it cannot manage members or credentials. A token that
            // could invite an owner would turn a leaked CI secret into a full account takeover.
            if (principal.organizationId !== organizationId)
                throw new domain_error_1.ForbiddenError("Este token no pertenece a la organización");
            if (!(0, model_1.atLeast)("editor", required))
                throw new domain_error_1.ForbiddenError("Un token de servicio no alcanza para esta operación", "api-token-role");
            request.membershipRole = "editor";
            return true;
        }
        const membership = await this.memberships.find(organizationId, principal.userId);
        if (!membership)
            throw new domain_error_1.ForbiddenError("No perteneces a esta organización");
        if (!(0, model_1.atLeast)(membership.role, required))
            throw new domain_error_1.ForbiddenError(`Esta operación requiere el rol ${required}`, "insufficient-role");
        request.membershipRole = membership.role;
        return true;
    }
};
exports.OrgRoleGuard = OrgRoleGuard;
exports.OrgRoleGuard = OrgRoleGuard = __decorate([
    (0, common_1.Injectable)(),
    __param(1, (0, common_1.Inject)(ports_1.MEMBERSHIP_REPOSITORY)),
    __metadata("design:paramtypes", [core_1.Reflector, Object])
], OrgRoleGuard);
//# sourceMappingURL=auth.guard.js.map