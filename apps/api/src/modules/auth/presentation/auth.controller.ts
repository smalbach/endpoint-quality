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
import { Body, Controller, Get, HttpCode, Post, Req, Res } from "@nestjs/common";
import { CommandBus, QueryBus } from "@nestjs/cqrs";
import { Throttle } from "@nestjs/throttler";
import type { Request, Response } from "express";

import { ENV, type Env } from "@/shared/config/env";
import { Inject } from "@nestjs/common";
import { UnauthenticatedError } from "@/shared/errors/domain-error";
import { RegisterUserCommand, type RegisterUserResult } from "../application/commands/register-user";
import { LoginUserCommand, type SessionTokens } from "../application/commands/login-user";
import { RefreshSessionCommand } from "../application/commands/refresh-session";
import { LogoutUserCommand } from "../application/commands/logout-user";
import { ChangePasswordCommand } from "../application/commands/change-password";
import { GetAuthContextQuery, GetCurrentUserQuery, type AuthContextView, type CurrentUserView } from "../application/queries/get-current-user";
import { CurrentUser, Public, type Principal } from "../infrastructure/guards/auth.guard";
import { ChangePasswordDto, LoginDto, LogoutDto, RefreshDto, RegisterDto } from "./dto/auth.dto";

const REFRESH_COOKIE = "eq_refresh";

@Controller("auth")
export class AuthController {
  constructor(
    private readonly commandBus: CommandBus,
    private readonly queryBus: QueryBus,
    @Inject(ENV) private readonly env: Env,
  ) {}

  @Public()
  // Registration is rate limited as tightly as login: it writes a row and runs the KDF, so it is
  // both a spam vector and a way to make the server do expensive work for free.
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post("register")
  async register(@Body() body: RegisterDto): Promise<RegisterUserResult> {
    return this.commandBus.execute(new RegisterUserCommand(body.email, body.password, body.name, body.organizationName));
  }

  @Public()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @HttpCode(200)
  @Post("login")
  async login(@Body() body: LoginDto, @Res({ passthrough: true }) response: Response) {
    const session = await this.commandBus.execute<LoginUserCommand, SessionTokens>(new LoginUserCommand(body.email, body.password));
    return this.respondWithSession(session, response);
  }

  @Public()
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @HttpCode(200)
  @Post("refresh")
  async refresh(@Body() body: RefreshDto, @Req() request: Request, @Res({ passthrough: true }) response: Response) {
    const token = body.refreshToken ?? (request.cookies?.[REFRESH_COOKIE] as string | undefined);
    if (!token) throw new UnauthenticatedError("Falta el refresh token");
    const session = await this.commandBus.execute<RefreshSessionCommand, SessionTokens>(new RefreshSessionCommand(token));
    return this.respondWithSession(session, response);
  }

  @HttpCode(204)
  @Post("logout")
  async logout(@Body() body: LogoutDto, @Req() request: Request, @Res({ passthrough: true }) response: Response, @CurrentUser() principal: Principal): Promise<void> {
    if (principal.kind !== "user") throw new UnauthenticatedError("Un token de servicio no tiene sesión que cerrar");
    const token = body.refreshToken ?? (request.cookies?.[REFRESH_COOKIE] as string | undefined);
    await this.commandBus.execute(new LogoutUserCommand(token, body.everywhere ?? false, principal.userId));
    // Cleared with the same attributes it was set with, or the browser keeps the old one and the
    // next refresh presents a token the server has already revoked.
    response.clearCookie(REFRESH_COOKIE, this.cookieOptions());
  }

  @HttpCode(204)
  @Post("change-password")
  async changePassword(@Body() body: ChangePasswordDto, @Res({ passthrough: true }) response: Response, @CurrentUser() principal: Principal): Promise<void> {
    if (principal.kind !== "user") throw new UnauthenticatedError("Un token de servicio no tiene contraseña");
    await this.commandBus.execute(new ChangePasswordCommand(principal.userId, body.currentPassword, body.newPassword));
    // Changing the password logs every session out, including this one. Leaving the cookie in
    // place would leave the browser holding a credential the server has just revoked.
    response.clearCookie(REFRESH_COOKIE, this.cookieOptions());
  }

  @Get("me")
  async me(@CurrentUser() principal: Principal): Promise<CurrentUserView> {
    if (principal.kind !== "user") throw new UnauthenticatedError("Un token de servicio no representa a una persona");
    return this.queryBus.execute(new GetCurrentUserQuery(principal.userId));
  }

  /**
   * The same question as `/auth/me`, asked in a way a service token can answer.
   *
   * `/auth/me` is about a person and stays that way. This is about *where the caller can act*,
   * which is what a client actually needs to build a URL — and a token that cannot find out its
   * own organization is a credential that works and cannot be used.
   */
  @Get("context")
  async context(@CurrentUser() principal: Principal): Promise<AuthContextView> {
    return this.queryBus.execute(new GetAuthContextQuery(principal));
  }

  private respondWithSession(session: SessionTokens, response: Response) {
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

  private cookieOptions() {
    return {
      httpOnly: true,
      // Strict rather than Lax: this cookie is only ever sent by our own front end, never as
      // part of a navigation, so there is nothing to relax it for.
      sameSite: "strict" as const,
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
}
