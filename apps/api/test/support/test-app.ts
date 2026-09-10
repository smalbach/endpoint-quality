/**
 * The whole application, wired to in-memory adapters.
 *
 * This is not a mock of the API: it is the API — the same controllers, the same global guards,
 * the same validation pipe, the same Problem Details filter, the same command and query buses.
 * Only the six repository ports and the clock are substituted, which is exactly the boundary
 * the ports were introduced for.
 *
 * What that buys is that the tests below check the things that actually break in production and
 * that unit tests of a handler cannot see: whether a route is protected at all, whether a
 * missing `@Public()` locks out login, whether the guard runs before the pipe, whether an error
 * leaves as Problem Details. Those are properties of the wiring.
 *
 * What it does not cover is SQL — the migrations and tenant isolation at the database level get
 * their own suite, against a real Postgres.
 */
import { HttpStatus, ValidationPipe } from "@nestjs/common";
import { APP_FILTER, APP_GUARD } from "@nestjs/core";
import { CqrsModule } from "@nestjs/cqrs";
import { JwtModule } from "@nestjs/jwt";
import { Test } from "@nestjs/testing";
import type { INestApplication } from "@nestjs/common";
import cookieParser from "cookie-parser";

import { ENV, type Env, loadEnv } from "@/shared/config/env";
import { CLOCK, FixedClock } from "@/shared/clock/clock.port";
import { PASSWORD_HASHER, FastTestPasswordHasher } from "@/shared/crypto/password-hasher";
import { ProblemDetailsFilter } from "@/shared/errors/problem-details.filter";
import { ACCESS_TOKEN_SERVICE } from "@/modules/auth/domain/access-token";
import { API_TOKEN_REPOSITORY, REFRESH_TOKEN_REPOSITORY, USER_REPOSITORY } from "@/modules/auth/domain/ports";
import { JwtAccessTokenService } from "@/modules/auth/infrastructure/jwt-access-token.service";
import { AuthGuard } from "@/modules/auth/infrastructure/guards/auth.guard";
import { AuthController } from "@/modules/auth/presentation/auth.controller";
import { AUTH_COMMAND_HANDLERS, AUTH_QUERY_HANDLERS } from "@/modules/auth/auth.module";
import { INVITATION_REPOSITORY, MEMBERSHIP_REPOSITORY, ORGANIZATION_REPOSITORY } from "@/modules/iam/domain/ports";
import { OrganizationsController } from "@/modules/iam/presentation/organizations.controller";
import { IAM_COMMAND_HANDLERS, IAM_QUERY_HANDLERS } from "@/modules/iam/iam.module";
import {
  InMemoryApiTokenRepository,
  InMemoryInvitationRepository,
  InMemoryMembershipRepository,
  InMemoryOrganizationRepository,
  InMemoryRefreshTokenRepository,
  InMemoryUserRepository,
} from "./in-memory-repositories";

export const TEST_ENV: NodeJS.ProcessEnv = {
  NODE_ENV: "test",
  DATABASE_URL: "postgres://unused/unused",
  JWT_ACCESS_SECRET: "a".repeat(48),
  JWT_REFRESH_SECRET: "b".repeat(48),
  ACCESS_TOKEN_TTL: "15m",
  REFRESH_TOKEN_TTL_DAYS: "30",
};

export type TestContext = {
  app: INestApplication;
  clock: FixedClock;
  env: Env;
  repositories: {
    users: InMemoryUserRepository;
    refreshTokens: InMemoryRefreshTokenRepository;
    apiTokens: InMemoryApiTokenRepository;
    organizations: InMemoryOrganizationRepository;
    memberships: InMemoryMembershipRepository;
    invitations: InMemoryInvitationRepository;
  };
  close(): Promise<void>;
};

export async function createTestApp(): Promise<TestContext> {
  const env = loadEnv(TEST_ENV);
  const clock = new FixedClock(new Date("2026-03-01T10:00:00.000Z"));
  const repositories = {
    users: new InMemoryUserRepository(),
    refreshTokens: new InMemoryRefreshTokenRepository(),
    apiTokens: new InMemoryApiTokenRepository(),
    organizations: new InMemoryOrganizationRepository(),
    memberships: new InMemoryMembershipRepository(),
    invitations: new InMemoryInvitationRepository(),
  };

  const moduleRef = await Test.createTestingModule({
    imports: [CqrsModule.forRoot(), JwtModule.register({})],
    controllers: [AuthController, OrganizationsController],
    providers: [
      { provide: ENV, useValue: env },
      { provide: CLOCK, useValue: clock },
      { provide: PASSWORD_HASHER, useClass: FastTestPasswordHasher },
      { provide: ACCESS_TOKEN_SERVICE, useClass: JwtAccessTokenService },
      { provide: USER_REPOSITORY, useValue: repositories.users },
      { provide: REFRESH_TOKEN_REPOSITORY, useValue: repositories.refreshTokens },
      { provide: API_TOKEN_REPOSITORY, useValue: repositories.apiTokens },
      { provide: ORGANIZATION_REPOSITORY, useValue: repositories.organizations },
      { provide: MEMBERSHIP_REPOSITORY, useValue: repositories.memberships },
      { provide: INVITATION_REPOSITORY, useValue: repositories.invitations },
      ...AUTH_COMMAND_HANDLERS,
      ...AUTH_QUERY_HANDLERS,
      ...IAM_COMMAND_HANDLERS,
      ...IAM_QUERY_HANDLERS,
      // The global guard and filter are registered exactly as `AppModule` does, because half of
      // what these tests check is that the wiring protects what it should. Throttling is left
      // out: it is the one piece whose behaviour is a rate, and asserting it here would make
      // every other test's result depend on how many requests ran before it.
      { provide: APP_GUARD, useClass: AuthGuard },
      { provide: APP_FILTER, useClass: ProblemDetailsFilter },
      AuthGuard,
    ],
  }).compile();

  const app = moduleRef.createNestApplication({ logger: false });
  app.use(cookieParser());
  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true, errorHttpStatusCode: HttpStatus.UNPROCESSABLE_ENTITY }),
  );
  await app.init();

  return { app, clock, env, repositories, close: () => app.close() };
}
