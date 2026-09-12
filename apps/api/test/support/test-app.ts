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
import { AUTH_COMMAND_HANDLERS, AUTH_EVENT_HANDLERS, AUTH_QUERY_HANDLERS } from "@/modules/auth/auth.module";
import { PASSWORD_RESET_REPOSITORY } from "@/modules/auth/domain/password-reset";
import { MAILER, RecordingMailer } from "@/shared/mail/mailer";
import { InMemoryPasswordResetRepository } from "./in-memory-password-resets";
import { InMemoryEndpointRepository } from "./in-memory-endpoints";
import { ENDPOINT_REPOSITORY } from "@/modules/endpoints/domain/ports";
import { EndpointsController } from "@/modules/endpoints/presentation/endpoints.controller";
import {
  ENDPOINT_COMMAND_HANDLERS,
  ENDPOINT_EVENT_HANDLERS,
  ENDPOINT_QUERY_HANDLERS,
} from "@/modules/endpoints/endpoints.module";
import { INVITATION_REPOSITORY, MEMBERSHIP_REPOSITORY, ORGANIZATION_REPOSITORY } from "@/modules/iam/domain/ports";
import { OrganizationsController } from "@/modules/iam/presentation/organizations.controller";
import { IAM_COMMAND_HANDLERS, IAM_QUERY_HANDLERS } from "@/modules/iam/iam.module";
import { PROJECT_REPOSITORY } from "@/modules/projects/domain/ports";
import { ProjectsController } from "@/modules/projects/presentation/projects.controller";
import { PROJECT_COMMAND_HANDLERS, PROJECT_QUERY_HANDLERS } from "@/modules/projects/projects.module";
import { SPEC_REPOSITORY } from "@/modules/specs/domain/ports";
import { SPEC_COMMAND_HANDLERS, SPEC_QUERY_HANDLERS } from "@/modules/specs/specs.module";
import {
  SAFE_FETCH,
  safeFetch,
  type SafeFetchPolicy,
  type SafeFetchPort,
  type SafeFetchResult,
  type SafeRequestOptions,
} from "@/shared/http/safe-fetch";
import { SECRET_CIPHER, AesGcmSecretCipher } from "@/shared/crypto/secret-cipher";
import { ENVIRONMENT_REPOSITORY } from "@/modules/environments/domain/ports";
import { EnvironmentsController } from "@/modules/environments/presentation/environments.controller";
import { ENVIRONMENT_COMMAND_HANDLERS, ENVIRONMENT_QUERY_HANDLERS } from "@/modules/environments/environments.module";
import { CONFIG_REPOSITORY } from "@/modules/config/domain/ports";
import { CONFIG_COMMAND_HANDLERS, CONFIG_QUERY_HANDLERS } from "@/modules/config/config.module";
import { ProjectConfigController } from "@/modules/config/presentation/config.controller";
import { WORKFLOW_REPOSITORY } from "@/modules/workflows/domain/ports";
import { WORKFLOW_COMMAND_HANDLERS, WORKFLOW_QUERY_HANDLERS } from "@/modules/workflows/workflows.module";
import { WorkflowsController } from "@/modules/workflows/presentation/workflows.controller";
import { REQUEST_PREVIEWER, RUN_QUEUE, RUN_REPOSITORY } from "@/modules/runs/domain/ports";
import { PROGRESS_RELAY } from "@/modules/runs/domain/progress";
import { InProcessRelay } from "@/modules/runs/infrastructure/progress/in-process-relay";
import { RunsController } from "@/modules/runs/presentation/runs.controller";
import { RequestPreviewController } from "@/modules/runs/presentation/request-preview.controller";
import { RUN_COMMAND_HANDLERS, RUN_PROJECTORS, RUN_QUERY_HANDLERS } from "@/modules/runs/runs.module";
import { CaseExecutor } from "@/modules/runs/infrastructure/case-executor";
import { ExecutionContextFactory } from "@/modules/runs/infrastructure/execution-context";
import { RequestPreviewer } from "@/modules/runs/infrastructure/request-previewer";
import { RunOrchestrator } from "@/modules/runs/infrastructure/run-orchestrator";
import { RunProgressStream } from "@/modules/runs/infrastructure/run-progress.stream";
import { InMemoryRunQueue } from "@/modules/runs/infrastructure/queue/in-memory-queue";
import {
  InMemoryApiTokenRepository,
  InMemoryInvitationRepository,
  InMemoryMembershipRepository,
  InMemoryOrganizationRepository,
  InMemoryRefreshTokenRepository,
  InMemoryConfigRepository,
  InMemoryWorkflowRepository,
  InMemoryEnvironmentRepository,
  InMemoryProjectRepository,
  InMemoryRunRepository,
  InMemorySpecRepository,
  InMemoryUserRepository,
} from "./in-memory-repositories";

/**
 * The network, with a hole for the tests to reach through.
 *
 * A URL a test registered is answered from the map; **anything else goes out through the real
 * guard**, unchanged. That split is deliberate: the spec-import tests want a document without
 * depending on anything being reachable, and the run tests drive a genuine HTTP server on
 * loopback — swapping the network out for those would leave the whole point of the execution
 * engine untested.
 *
 * One token, not two. A second `SAFE_FETCH`-like provider for "the real one" would be a second
 * place where the SSRF policy is decided.
 */
export class StubSafeFetch implements SafeFetchPort {
  readonly responses = new Map<
    string,
    { status: number; body: string; requires?: { header: string; value: string } }
  >();
  readonly requested: string[] = [];
  /** What was sent, headers included. `requested` keeps only the URLs, and a credential that
   * travels in a header is invisible in a list of URLs. */
  readonly calls: { url: string; headers: Record<string, string> }[] = [];

  constructor(private readonly policy: SafeFetchPolicy) {}

  reply(url: string, body: string, status = 200) {
    this.responses.set(url, { status, body });
  }

  /** A contract behind authentication: 401 unless the header arrives with the expected value. */
  replyBehindAuth(url: string, body: string, header: string, value: string) {
    this.responses.set(url, { status: 200, body, requires: { header: header.toLowerCase(), value } });
  }

  async get(url: string, options: { headers?: Record<string, string> } = {}): Promise<SafeFetchResult> {
    return this.request(url, { method: "GET", ...options });
  }

  async request(url: string, options: SafeRequestOptions): Promise<SafeFetchResult> {
    this.requested.push(url);
    const headers = Object.fromEntries(
      Object.entries(options.headers ?? {}).map(([name, value]) => [name.toLowerCase(), value]),
    );
    this.calls.push({ url, headers });
    const stored = this.responses.get(url);
    if (stored) {
      const reply = {
        headers: { "content-type": "application/yaml" },
        finalUrl: url,
        durationMs: 1,
        timing: { dnsMs: 0, ttfbMs: 1, downloadMs: 0 },
      };
      if (stored.requires && headers[stored.requires.header] !== stored.requires.value) {
        return { ...reply, status: 401, body: "no autorizado" };
      }
      return { ...reply, status: stored.status, body: stored.body };
    }
    return safeFetch(url, this.policy, options);
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
    workflows: InMemoryWorkflowRepository;
    runs: InMemoryRunRepository;
    passwordResets: InMemoryPasswordResetRepository;
    endpoints: InMemoryEndpointRepository;
  };
  http: StubSafeFetch;
  /** Every mail the application sent. The reset link is only reachable through here. */
  mailer: RecordingMailer;
  /** Lets a test await the queue instead of polling for a run to finish. */
  queue: InMemoryRunQueue;
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
    workflows: new InMemoryWorkflowRepository(),
    runs: new InMemoryRunRepository(),
    passwordResets: new InMemoryPasswordResetRepository(),
    endpoints: new InMemoryEndpointRepository(),
  };
  const mailer = new RecordingMailer();
  // Loopback is allowed here because the run tests point the engine at a stub server on
  // 127.0.0.1, which is also the ordinary self-hosted case.
  const http = new StubSafeFetch({
    allowPrivateTargets: true,
    maxRedirects: env.MAX_REDIRECTS,
    timeoutMs: 5_000,
    maxResponseBytes: env.MAX_RESPONSE_BYTES,
  });
  const queue = new InMemoryRunQueue();

  const moduleRef = await Test.createTestingModule({
    imports: [CqrsModule.forRoot(), JwtModule.register({})],
    controllers: [
      AuthController,
      OrganizationsController,
      ProjectsController,
      EnvironmentsController,
      ProjectConfigController,
      WorkflowsController,
      RunsController,
      RequestPreviewController,
      EndpointsController,
    ],
    providers: [
      { provide: ENV, useValue: env },
      { provide: CLOCK, useValue: clock },
      { provide: PASSWORD_HASHER, useClass: FastTestPasswordHasher },
      { provide: ACCESS_TOKEN_SERVICE, useClass: JwtAccessTokenService },
      { provide: USER_REPOSITORY, useValue: repositories.users },
      { provide: REFRESH_TOKEN_REPOSITORY, useValue: repositories.refreshTokens },
      { provide: PASSWORD_RESET_REPOSITORY, useValue: repositories.passwordResets },
      { provide: MAILER, useValue: mailer },
      { provide: API_TOKEN_REPOSITORY, useValue: repositories.apiTokens },
      { provide: ORGANIZATION_REPOSITORY, useValue: repositories.organizations },
      { provide: MEMBERSHIP_REPOSITORY, useValue: repositories.memberships },
      { provide: INVITATION_REPOSITORY, useValue: repositories.invitations },
      { provide: PROJECT_REPOSITORY, useValue: repositories.projects },
      { provide: SPEC_REPOSITORY, useValue: repositories.specs },
      { provide: SAFE_FETCH, useValue: http },
      { provide: RUN_REPOSITORY, useValue: repositories.runs },
      { provide: RUN_QUEUE, useValue: queue },
      // El relé de un solo proceso, que es el que corre la suite: no hace nada, y no hacer nada
      // es lo correcto cuando el sujeto en memoria ya alcanza a todos los seguidores que hay.
      { provide: PROGRESS_RELAY, useClass: InProcessRelay },
      CaseExecutor,
      ExecutionContextFactory,
      { provide: REQUEST_PREVIEWER, useClass: RequestPreviewer },
      RunOrchestrator,
      RunProgressStream,
      ...RUN_PROJECTORS,
      { provide: ENVIRONMENT_REPOSITORY, useValue: repositories.environments },
      { provide: CONFIG_REPOSITORY, useValue: repositories.config },
      { provide: WORKFLOW_REPOSITORY, useValue: repositories.workflows },
      { provide: ENDPOINT_REPOSITORY, useValue: repositories.endpoints },
      // A real cipher with a throwaway key, not a fake: the tests assert that what lands in the
      // repository is ciphertext, and a pass-through would make that assertion meaningless.
      { provide: SECRET_CIPHER, useValue: new AesGcmSecretCipher(Buffer.alloc(32, 9).toString("base64")) },
      ...AUTH_COMMAND_HANDLERS,
      ...AUTH_QUERY_HANDLERS,
      ...AUTH_EVENT_HANDLERS,
      ...IAM_COMMAND_HANDLERS,
      ...IAM_QUERY_HANDLERS,
      ...PROJECT_COMMAND_HANDLERS,
      ...PROJECT_QUERY_HANDLERS,
      ...SPEC_COMMAND_HANDLERS,
      ...SPEC_QUERY_HANDLERS,
      ...ENVIRONMENT_COMMAND_HANDLERS,
      ...ENVIRONMENT_QUERY_HANDLERS,
      ...CONFIG_COMMAND_HANDLERS,
      ...CONFIG_QUERY_HANDLERS,
      ...WORKFLOW_COMMAND_HANDLERS,
      ...WORKFLOW_QUERY_HANDLERS,
      ...RUN_COMMAND_HANDLERS,
      ...RUN_QUERY_HANDLERS,
      ...ENDPOINT_COMMAND_HANDLERS,
      ...ENDPOINT_QUERY_HANDLERS,
      ...ENDPOINT_EVENT_HANDLERS,
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
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      errorHttpStatusCode: HttpStatus.UNPROCESSABLE_ENTITY,
    }),
  );
  // Listening once, on `127.0.0.1`, is load-bearing — it is not a shortcut for `init()`.
  //
  // Supertest only binds a port itself when the server it is handed has no address yet. With a
  // merely initialised app that was every single request: `listen(0)` before it, `close()` after
  // it, hundreds of times per file. And `listen(0)` with no host binds the IPv6 wildcard `::`,
  // while supertest then composes the URL against the literal `127.0.0.1`. Those are two
  // different addresses, so the kernel hands out an ephemeral port for `::` without knowing that
  // some other process already holds the same number on `127.0.0.1` — a sibling test file's
  // `StubTarget`, which binds `127.0.0.1` explicitly, or any unrelated server on the developer's
  // machine. When the numbers met, the request left for a stranger and came back as whatever
  // that stranger answers: a bare 404, a 401 with `{"error":"Unauthorized"}`, a 400 reading
  // "WebSockets request was expected". That is the whole of the intermittent failure that made
  // roughly one run in three red, always on a different line, and never reproducible alone —
  // with the files running in parallel the collision needed a neighbour to exist.
  //
  // Binding `127.0.0.1` up front closes it: the address we bind is the address supertest dials,
  // so a successful bind is now an actual reservation, and a genuine clash would be a loud
  // `EADDRINUSE` at startup instead of a wrong answer in the middle of an assertion.
  await app.listen(0, "127.0.0.1");

  // The worker starts listening exactly as `RunsModule.onApplicationBootstrap` does.
  moduleRef.get(RunOrchestrator).listen();

  return {
    app,
    clock,
    env,
    repositories,
    http,
    mailer,
    queue,
    close: async () => {
      // Superagent leaves keep-alive sockets behind, and `close()` waits for connections to end.
      // Dropping them first is what keeps a finished suite from hanging at exit.
      app.getHttpServer().closeAllConnections();
      await app.close();
    },
  };
}
