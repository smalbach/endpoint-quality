"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.TEST_ENV = exports.StubSafeFetch = void 0;
exports.createTestApp = createTestApp;
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
const common_1 = require("@nestjs/common");
const core_1 = require("@nestjs/core");
const cqrs_1 = require("@nestjs/cqrs");
const jwt_1 = require("@nestjs/jwt");
const testing_1 = require("@nestjs/testing");
const cookie_parser_1 = __importDefault(require("cookie-parser"));
const body_limits_1 = require("../../src/shared/http/body-limits");
const env_1 = require("../../src/shared/config/env");
const clock_port_1 = require("../../src/shared/clock/clock.port");
const password_hasher_1 = require("../../src/shared/crypto/password-hasher");
const problem_details_filter_1 = require("../../src/shared/errors/problem-details.filter");
const access_token_1 = require("../../src/modules/auth/domain/access-token");
const ports_1 = require("../../src/modules/auth/domain/ports");
const jwt_access_token_service_1 = require("../../src/modules/auth/infrastructure/jwt-access-token.service");
const auth_guard_1 = require("../../src/modules/auth/infrastructure/guards/auth.guard");
const auth_controller_1 = require("../../src/modules/auth/presentation/auth.controller");
const auth_module_1 = require("../../src/modules/auth/auth.module");
const ports_2 = require("../../src/modules/iam/domain/ports");
const organizations_controller_1 = require("../../src/modules/iam/presentation/organizations.controller");
const iam_module_1 = require("../../src/modules/iam/iam.module");
const ports_3 = require("../../src/modules/projects/domain/ports");
const projects_controller_1 = require("../../src/modules/projects/presentation/projects.controller");
const projects_module_1 = require("../../src/modules/projects/projects.module");
const ports_4 = require("../../src/modules/specs/domain/ports");
const specs_module_1 = require("../../src/modules/specs/specs.module");
const safe_fetch_1 = require("../../src/shared/http/safe-fetch");
const secret_cipher_1 = require("../../src/shared/crypto/secret-cipher");
const ports_5 = require("../../src/modules/environments/domain/ports");
const environments_controller_1 = require("../../src/modules/environments/presentation/environments.controller");
const environments_module_1 = require("../../src/modules/environments/environments.module");
const ports_6 = require("../../src/modules/config/domain/ports");
const ports_7 = require("../../src/modules/runs/domain/ports");
const runs_controller_1 = require("../../src/modules/runs/presentation/runs.controller");
const runs_module_1 = require("../../src/modules/runs/runs.module");
const case_executor_1 = require("../../src/modules/runs/infrastructure/case-executor");
const run_orchestrator_1 = require("../../src/modules/runs/infrastructure/run-orchestrator");
const run_progress_stream_1 = require("../../src/modules/runs/infrastructure/run-progress.stream");
const in_memory_queue_1 = require("../../src/modules/runs/infrastructure/queue/in-memory-queue");
const in_memory_repositories_1 = require("./in-memory-repositories");
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
class StubSafeFetch {
    policy;
    responses = new Map();
    requested = [];
    constructor(policy) {
        this.policy = policy;
    }
    reply(url, body, status = 200) {
        this.responses.set(url, { status, body });
    }
    async get(url, options = {}) {
        return this.request(url, { method: "GET", ...options });
    }
    async request(url, options) {
        this.requested.push(url);
        const stored = this.responses.get(url);
        if (stored) {
            return { status: stored.status, headers: { "content-type": "application/yaml" }, body: stored.body, finalUrl: url, durationMs: 1 };
        }
        return (0, safe_fetch_1.safeFetch)(url, this.policy, options);
    }
}
exports.StubSafeFetch = StubSafeFetch;
exports.TEST_ENV = {
    NODE_ENV: "test",
    DATABASE_URL: "postgres://unused/unused",
    JWT_ACCESS_SECRET: "a".repeat(48),
    JWT_REFRESH_SECRET: "b".repeat(48),
    ACCESS_TOKEN_TTL: "15m",
    REFRESH_TOKEN_TTL_DAYS: "30",
};
async function createTestApp() {
    const env = (0, env_1.loadEnv)(exports.TEST_ENV);
    const clock = new clock_port_1.FixedClock(new Date("2026-03-01T10:00:00.000Z"));
    const repositories = {
        users: new in_memory_repositories_1.InMemoryUserRepository(),
        refreshTokens: new in_memory_repositories_1.InMemoryRefreshTokenRepository(),
        apiTokens: new in_memory_repositories_1.InMemoryApiTokenRepository(),
        organizations: new in_memory_repositories_1.InMemoryOrganizationRepository(),
        memberships: new in_memory_repositories_1.InMemoryMembershipRepository(),
        invitations: new in_memory_repositories_1.InMemoryInvitationRepository(),
        projects: new in_memory_repositories_1.InMemoryProjectRepository(),
        specs: new in_memory_repositories_1.InMemorySpecRepository(),
        environments: new in_memory_repositories_1.InMemoryEnvironmentRepository(),
        config: new in_memory_repositories_1.InMemoryConfigRepository(),
        runs: new in_memory_repositories_1.InMemoryRunRepository(),
    };
    // Loopback is allowed here because the run tests point the engine at a stub server on
    // 127.0.0.1, which is also the ordinary self-hosted case.
    const http = new StubSafeFetch({ allowPrivateTargets: true, maxRedirects: env.MAX_REDIRECTS, timeoutMs: 5_000, maxResponseBytes: env.MAX_RESPONSE_BYTES });
    const queue = new in_memory_queue_1.InMemoryRunQueue();
    const moduleRef = await testing_1.Test.createTestingModule({
        imports: [cqrs_1.CqrsModule.forRoot(), jwt_1.JwtModule.register({})],
        controllers: [auth_controller_1.AuthController, organizations_controller_1.OrganizationsController, projects_controller_1.ProjectsController, environments_controller_1.EnvironmentsController, runs_controller_1.RunsController],
        providers: [
            { provide: env_1.ENV, useValue: env },
            { provide: clock_port_1.CLOCK, useValue: clock },
            { provide: password_hasher_1.PASSWORD_HASHER, useClass: password_hasher_1.FastTestPasswordHasher },
            { provide: access_token_1.ACCESS_TOKEN_SERVICE, useClass: jwt_access_token_service_1.JwtAccessTokenService },
            { provide: ports_1.USER_REPOSITORY, useValue: repositories.users },
            { provide: ports_1.REFRESH_TOKEN_REPOSITORY, useValue: repositories.refreshTokens },
            { provide: ports_1.API_TOKEN_REPOSITORY, useValue: repositories.apiTokens },
            { provide: ports_2.ORGANIZATION_REPOSITORY, useValue: repositories.organizations },
            { provide: ports_2.MEMBERSHIP_REPOSITORY, useValue: repositories.memberships },
            { provide: ports_2.INVITATION_REPOSITORY, useValue: repositories.invitations },
            { provide: ports_3.PROJECT_REPOSITORY, useValue: repositories.projects },
            { provide: ports_4.SPEC_REPOSITORY, useValue: repositories.specs },
            { provide: safe_fetch_1.SAFE_FETCH, useValue: http },
            { provide: ports_7.RUN_REPOSITORY, useValue: repositories.runs },
            { provide: ports_7.RUN_QUEUE, useValue: queue },
            case_executor_1.CaseExecutor,
            run_orchestrator_1.RunOrchestrator,
            run_progress_stream_1.RunProgressStream,
            ...runs_module_1.RUN_PROJECTORS,
            { provide: ports_5.ENVIRONMENT_REPOSITORY, useValue: repositories.environments },
            { provide: ports_6.CONFIG_REPOSITORY, useValue: repositories.config },
            // A real cipher with a throwaway key, not a fake: the tests assert that what lands in the
            // repository is ciphertext, and a pass-through would make that assertion meaningless.
            { provide: secret_cipher_1.SECRET_CIPHER, useValue: new secret_cipher_1.AesGcmSecretCipher(Buffer.alloc(32, 9).toString("base64")) },
            ...auth_module_1.AUTH_COMMAND_HANDLERS,
            ...auth_module_1.AUTH_QUERY_HANDLERS,
            ...iam_module_1.IAM_COMMAND_HANDLERS,
            ...iam_module_1.IAM_QUERY_HANDLERS,
            ...projects_module_1.PROJECT_COMMAND_HANDLERS,
            ...projects_module_1.PROJECT_QUERY_HANDLERS,
            ...specs_module_1.SPEC_COMMAND_HANDLERS,
            ...specs_module_1.SPEC_QUERY_HANDLERS,
            ...environments_module_1.ENVIRONMENT_COMMAND_HANDLERS,
            ...environments_module_1.ENVIRONMENT_QUERY_HANDLERS,
            ...runs_module_1.RUN_COMMAND_HANDLERS,
            ...runs_module_1.RUN_QUERY_HANDLERS,
            // The global guard and filter are registered exactly as `AppModule` does, because half of
            // what these tests check is that the wiring protects what it should. Throttling is left
            // out: it is the one piece whose behaviour is a rate, and asserting it here would make
            // every other test's result depend on how many requests ran before it.
            { provide: core_1.APP_GUARD, useClass: auth_guard_1.AuthGuard },
            { provide: core_1.APP_FILTER, useClass: problem_details_filter_1.ProblemDetailsFilter },
            auth_guard_1.AuthGuard,
        ],
    }).compile();
    const app = moduleRef.createNestApplication({ logger: false });
    app.use((0, cookie_parser_1.default)());
    // Set through the same call `main.ts` uses, against the same constant. If the two drifted, a
    // contract that imports in production would fail here — or, worse, the other way round.
    app.useBodyParser("json", { limit: body_limits_1.MAX_JSON_BODY });
    app.useGlobalPipes(new common_1.ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true, errorHttpStatusCode: common_1.HttpStatus.UNPROCESSABLE_ENTITY }));
    await app.init();
    // The worker starts listening exactly as `RunsModule.onApplicationBootstrap` does.
    moduleRef.get(run_orchestrator_1.RunOrchestrator).listen();
    return { app, clock, env, repositories, http, queue, close: () => app.close() };
}
//# sourceMappingURL=test-app.js.map