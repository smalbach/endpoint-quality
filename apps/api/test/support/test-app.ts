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
import type { NestExpressApplication } from "@nestjs/platform-express";

import { MAX_JSON_BODY } from "@/shared/http/body-limits";

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
import { PROJECT_REPOSITORY } from "@/modules/projects/domain/ports";
import { ProjectsController } from "@/modules/projects/presentation/projects.controller";
import { PROJECT_COMMAND_HANDLERS, PROJECT_QUERY_HANDLERS } from "@/modules/projects/projects.module";
import { SPEC_REPOSITORY } from "@/modules/specs/domain/ports";
import { SPEC_COMMAND_HANDLERS, SPEC_QUERY_HANDLERS } from "@/modules/specs/specs.module";
import { SAFE_FETCH, type SafeFetchPort, type SafeFetchResult } from "@/shared/http/safe-fetch";
import { SECRET_CIPHER, AesGcmSecretCipher } from "@/shared/crypto/secret-cipher";
import { ENVIRONMENT_REPOSITORY } from "@/modules/environments/domain/ports";
import { EnvironmentsController } from "@/modules/environments/presentation/environments.controller";
import { ENVIRONMENT_COMMAND_HANDLERS, ENVIRONMENT_QUERY_HANDLERS } from "@/modules/environments/environments.module";
import { CONFIG_REPOSITORY } from "@/modules/config/domain/ports";
import {
  InMemoryApiTokenRepository,
  InMemoryInvitationRepository,
  InMemoryMembershipRepository,
  InMemoryOrganizationRepository,
  InMemoryRefreshTokenRepository,
  InMemoryConfigRepository,
  InMemoryEnvironmentRepository,
  InMemoryProjectRepository,
  InMemorySpecRepository,
  InMemoryUserRepository,
} from "./in-memory-repositories";

/**
 * A stand-in for the network.
 *
 * The SSRF guard has its own suite against a real loopback server; here what matters is that the
 * import command asks for a URL and gets a document back. Registering responses by URL keeps the
 * HTTP tests from depending on anything being reachable.
 */
export class StubSafeFetch implements SafeFetchPort {
  readonly responses = new Map<string, { status: number; body: string }>();
  readonly requested: string[] = [];

  reply(url: string, body: string, status = 200) {
    this.responses.set(url, { status, body });
  }

  async get(url: string): Promise<SafeFetchResult> {
    this.requested.push(url);
    const stored = this.responses.get(url);
    if (!stored) throw new Error(`El destino ${url} está bloqueado: sin respuesta registrada en la prueba`);
    return { status: stored.status, headers: { "content-type": "application/yaml" }, body: stored.body, finalUrl: url, durationMs: 1 };
  }
}

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
    projects: InMemoryProjectRepository;
    specs: InMemorySpecRepository;
    environments: InMemoryEnvironmentRepository;
    config: InMemoryConfigRepository;
  };
  http: StubSafeFetch;
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
    projects: new InMemoryProjectRepository(),
    specs: new InMemorySpecRepository(),
    environments: new InMemoryEnvironmentRepository(),
    config: new InMemoryConfigRepository(),
  };
  const http = new StubSafeFetch();

  const moduleRef = await Test.createTestingModule({
    imports: [CqrsModule.forRoot(), JwtModule.register({})],
    controllers: [AuthController, OrganizationsController, ProjectsController, EnvironmentsController],
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
      { provide: PROJECT_REPOSITORY, useValue: repositories.projects },
      { provide: SPEC_REPOSITORY, useValue: repositories.specs },
      { provide: SAFE_FETCH, useValue: http },
      { provide: ENVIRONMENT_REPOSITORY, useValue: repositories.environments },
      { provide: CONFIG_REPOSITORY, useValue: repositories.config },
      // A real cipher with a throwaway key, not a fake: the tests assert that what lands in the
      // repository is ciphertext, and a pass-through would make that assertion meaningless.
      { provide: SECRET_CIPHER, useValue: new AesGcmSecretCipher(Buffer.alloc(32, 9).toString("base64")) },
      ...AUTH_COMMAND_HANDLERS,
      ...AUTH_QUERY_HANDLERS,
      ...IAM_COMMAND_HANDLERS,
      ...IAM_QUERY_HANDLERS,
      ...PROJECT_COMMAND_HANDLERS,
      ...PROJECT_QUERY_HANDLERS,
      ...SPEC_COMMAND_HANDLERS,
      ...SPEC_QUERY_HANDLERS,
      ...ENVIRONMENT_COMMAND_HANDLERS,
      ...ENVIRONMENT_QUERY_HANDLERS,
      // The global guard and filter are registered exactly as `AppModule` does, because half of
      // what these tests check is that the wiring protects what it should. Throttling is left
      // out: it is the one piece whose behaviour is a rate, and asserting it here would make
      // every other test's result depend on how many requests ran before it.
      { provide: APP_GUARD, useClass: AuthGuard },
      { provide: APP_FILTER, useClass: ProblemDetailsFilter },
      AuthGuard,
    ],
  }).compile();

  const app = moduleRef.createNestApplication<NestExpressApplication>({ logger: false });
  app.use(cookieParser());
  // Set through the same call `main.ts` uses, against the same constant. If the two drifted, a
  // contract that imports in production would fail here — or, worse, the other way round.
  app.useBodyParser("json", { limit: MAX_JSON_BODY });
  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true, errorHttpStatusCode: HttpStatus.UNPROCESSABLE_ENTITY }),
  );
  await app.init();

  return { app, clock, env, repositories, http, close: () => app.close() };
}
