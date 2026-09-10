"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.TEST_ENV = void 0;
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
const in_memory_repositories_1 = require("./in-memory-repositories");
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
    };
    const moduleRef = await testing_1.Test.createTestingModule({
        imports: [cqrs_1.CqrsModule.forRoot(), jwt_1.JwtModule.register({})],
        controllers: [auth_controller_1.AuthController, organizations_controller_1.OrganizationsController],
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
            ...auth_module_1.AUTH_COMMAND_HANDLERS,
            ...auth_module_1.AUTH_QUERY_HANDLERS,
            ...iam_module_1.IAM_COMMAND_HANDLERS,
            ...iam_module_1.IAM_QUERY_HANDLERS,
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
    app.useGlobalPipes(new common_1.ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true, errorHttpStatusCode: common_1.HttpStatus.UNPROCESSABLE_ENTITY }));
    await app.init();
    return { app, clock, env, repositories, close: () => app.close() };
}
//# sourceMappingURL=test-app.js.map