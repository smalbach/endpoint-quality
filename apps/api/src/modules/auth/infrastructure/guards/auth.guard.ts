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
import { CanActivate, ExecutionContext, Inject, Injectable, SetMetadata, createParamDecorator } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { Request } from "express";

import { ForbiddenError, UnauthenticatedError } from "@/shared/errors/domain-error";
import { CLOCK, type ClockPort } from "@/shared/clock/clock.port";
import { hashOpaqueToken } from "@/shared/crypto/opaque-token";
import { atLeast, type Role } from "@/modules/iam/domain/model";
import { MEMBERSHIP_REPOSITORY, type MembershipRepositoryPort } from "@/modules/iam/domain/ports";
import { ACCESS_TOKEN_SERVICE, type AccessTokenServicePort } from "../../domain/access-token";
import {
  API_TOKEN_REPOSITORY,
  USER_REPOSITORY,
  type ApiTokenRepositoryPort,
  type UserRepositoryPort,
} from "../../domain/ports";
import { isActive } from "../../domain/model";

export const IS_PUBLIC = "auth:public";
/** Marks a route as reachable without a credential. Opt-*out*, never opt-in: the guard is global,
 * so a new controller is protected by default and a forgotten decorator closes a door rather
 * than opening one. */
export const Public = () => SetMetadata(IS_PUBLIC, true);

export const REQUIRED_ROLE = "auth:role";
export const RequireRole = (role: Role) => SetMetadata(REQUIRED_ROLE, role);

export type Principal =
  | { kind: "user"; userId: string; email: string }
  /** A CI credential. It is bound to one organization and cannot act outside it, which is why
   * `organizationId` is part of the principal rather than read from the URL. */
  | { kind: "api-token"; organizationId: string; tokenId: string };

/**
 * The request, once a guard has established who is calling.
 *
 * A local type rather than a `declare module` augmentation of Express: augmenting the global
 * `Request` puts `principal?: Principal` on *every* request object in the process, including the
 * ones no guard has touched, and the optionality then reads as "may be absent" instead of "not
 * established yet". Here the absence is explicit and the narrowing is local.
 */
export type AuthenticatedRequest = Request & {
  principal?: Principal;
  membershipRole?: Role;
};

export const CurrentUser = createParamDecorator((_data: unknown, context: ExecutionContext): Principal => {
  const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
  if (!request.principal) throw new UnauthenticatedError();
  return request.principal;
});

/** The role the caller holds in the organization this route addresses, resolved by `OrgRoleGuard`. */
export const CurrentRole = createParamDecorator(
  (_data: unknown, context: ExecutionContext): Role | undefined =>
    context.switchToHttp().getRequest<AuthenticatedRequest>().membershipRole,
);

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    @Inject(ACCESS_TOKEN_SERVICE) private readonly accessTokens: AccessTokenServicePort,
    @Inject(USER_REPOSITORY) private readonly users: UserRepositoryPort,
    @Inject(API_TOKEN_REPOSITORY) private readonly apiTokens: ApiTokenRepositoryPort,
    @Inject(CLOCK) private readonly clock: ClockPort,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [context.getHandler(), context.getClass()])) return true;

    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const header = request.headers.authorization;
    if (!header?.startsWith("Bearer ")) throw new UnauthenticatedError("Falta la credencial");
    const credential = header.slice("Bearer ".length).trim();

    request.principal = credential.startsWith("eqt_")
      ? await this.principalFromApiToken(credential)
      : await this.principalFromAccessToken(credential);
    return true;
  }

  private async principalFromAccessToken(token: string): Promise<Principal> {
    let claims: { sub: string; email: string };
    try {
      claims = await this.accessTokens.verify(token);
    } catch {
      throw new UnauthenticatedError("La credencial no es válida");
    }
    const user = await this.users.findById(claims.sub);
    // A signature that verifies is not the same as an account that still exists and is enabled.
    if (!user || !isActive(user)) throw new UnauthenticatedError("La credencial no es válida");
    return { kind: "user", userId: user.id, email: user.email };
  }

  private async principalFromApiToken(token: string): Promise<Principal> {
    const stored = await this.apiTokens.findByHash(hashOpaqueToken(token));
    if (!stored || stored.revokedAt) throw new UnauthenticatedError("La credencial no es válida");
    // Recorded so an operator can see which CI tokens are still in use before revoking one, and
    // so an unused token is visible as unused.
    await this.apiTokens.touch(stored.id, this.clock.now());
    return { kind: "api-token", organizationId: stored.organizationId, tokenId: stored.id };
  }
}

/**
 * Authorization inside one organization.
 *
 * The organization is taken from the route (`:organizationId`), which means a caller can *ask*
 * about any organization — and gets a 403 unless they are a member of that one. That is the
 * whole tenant boundary, and it is one lookup: no membership, no access, whatever the id in the
 * URL happens to be.
 */
@Injectable()
export class OrgRoleGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    @Inject(MEMBERSHIP_REPOSITORY) private readonly memberships: MembershipRepositoryPort,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const required = this.reflector.getAllAndOverride<Role>(REQUIRED_ROLE, [context.getHandler(), context.getClass()]);
    if (!required) return true;

    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const principal = request.principal;
    if (!principal) throw new UnauthenticatedError();

    // Express types a route parameter as `string | string[]`: a path with the same name twice
    // yields an array, and comparing that to a stored id would never match while also never
    // failing loudly. Rejected instead.
    const organizationId = request.params?.organizationId;
    if (typeof organizationId !== "string" || !organizationId)
      throw new ForbiddenError("La ruta no identifica una organización");

    if (principal.kind === "api-token") {
      // A CI token acts only inside the organization it was minted for, and at a fixed level:
      // it can launch runs and read, and it cannot manage members or credentials. A token that
      // could invite an owner would turn a leaked CI secret into a full account takeover.
      if (principal.organizationId !== organizationId)
        throw new ForbiddenError("Este token no pertenece a la organización");
      if (!atLeast("editor", required))
        throw new ForbiddenError("Un token de servicio no alcanza para esta operación", "api-token-role");
      request.membershipRole = "editor";
      return true;
    }

    const membership = await this.memberships.find(organizationId, principal.userId);
    if (!membership) throw new ForbiddenError("No perteneces a esta organización");
    if (!atLeast(membership.role, required))
      throw new ForbiddenError(`Esta operación requiere el rol ${required}`, "insufficient-role");

    request.membershipRole = membership.role;
    return true;
  }
}
