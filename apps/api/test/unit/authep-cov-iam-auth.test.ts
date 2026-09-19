/**
 * Los manejadores de identidad y de miembros, a pelo.
 *
 * Por HTTP, `OrgRoleGuard` corta casi todo antes de que el manejador lo vea: un `viewer` nunca llega
 * a `ChangeMemberRole`. Pero el manejador no puede fiarse de que siempre lo llame un controlador
 * con el guardia puesto, y sus propias negativas son las que quedan cuando el guardia cambia. Aquí
 * se prueban esas, y las de la sesión que dependen de estados difíciles de fabricar desde fuera: un
 * usuario borrado entre dos peticiones, un correo que no sale, un slug ocupado mil veces.
 */
import "reflect-metadata";
import { beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { Logger, type ExecutionContext } from "@nestjs/common";
import { ROUTE_ARGS_METADATA } from "@nestjs/common/constants";
import type { Reflector } from "@nestjs/core";

import { FixedClock } from "@/shared/clock/clock.port";
import { loadEnv } from "@/shared/config/env";
import { DomainError } from "@/shared/errors/domain-error";
import { FastTestPasswordHasher } from "@/shared/crypto/password-hasher";
import { generateOpaqueToken, hashOpaqueToken } from "@/shared/crypto/opaque-token";
import type { MailerPort } from "@/shared/mail/mailer";
import { RecordingMailer } from "@/shared/mail/mailer";
import type { User } from "@/modules/auth/domain/model";
import type { Role } from "@/modules/iam/domain/model";
import { CurrentRole, CurrentUser, OrgRoleGuard } from "@/modules/auth/infrastructure/guards/auth.guard";
import { ChangePasswordCommand, ChangePasswordHandler } from "@/modules/auth/application/commands/change-password";
import { RegisterUserCommand, RegisterUserHandler } from "@/modules/auth/application/commands/register-user";
import { RevokeApiTokenCommand, RevokeApiTokenHandler } from "@/modules/auth/application/commands/revoke-api-token";
import {
  RequestPasswordResetCommand,
  RequestPasswordResetHandler,
} from "@/modules/auth/application/commands/request-password-reset";
import { SendWelcomeMailHandler } from "@/modules/auth/application/events/send-welcome-mail";
import { UserRegisteredEvent } from "@/modules/auth/application/events/user-registered.event";
import {
  GetAuthContextHandler,
  GetAuthContextQuery,
  GetCurrentUserHandler,
  GetCurrentUserQuery,
} from "@/modules/auth/application/queries/get-current-user";
import { AcceptInvitationCommand, AcceptInvitationHandler } from "@/modules/iam/application/commands/accept-invitation";
import { ChangeMemberRoleCommand, ChangeMemberRoleHandler } from "@/modules/iam/application/commands/change-member-role";
import { CreateOrganizationCommand, CreateOrganizationHandler } from "@/modules/iam/application/commands/create-organization";
import { InviteMemberCommand, InviteMemberHandler } from "@/modules/iam/application/commands/invite-member";
import { RemoveMemberCommand, RemoveMemberHandler } from "@/modules/iam/application/commands/remove-member";
import { ListMembersHandler, ListMembersQuery } from "@/modules/iam/application/queries/list-members";

import {
  InMemoryApiTokenRepository,
  InMemoryInvitationRepository,
  InMemoryMembershipRepository,
  InMemoryOrganizationRepository,
  InMemoryRefreshTokenRepository,
  InMemoryUserRepository,
} from "../support/in-memory-repositories";
import { InMemoryPasswordResetRepository } from "../support/in-memory-password-resets";

// Los manejadores que registran un fallo lo hacen con el Logger de Nest; aquí sobra el ruido.
Logger.overrideLogger(false);

const NOW = new Date("2026-03-01T10:00:00.000Z");
const env = loadEnv({
  NODE_ENV: "test",
  DATABASE_URL: "postgres://unused/unused",
  JWT_ACCESS_SECRET: "a".repeat(48),
  JWT_REFRESH_SECRET: "b".repeat(48),
  APP_URL: "https://app.example.com/",
});

async function rejectsWith(promise: Promise<unknown>, kind: string, code?: string): Promise<DomainError> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof DomainError, `se esperaba un DomainError y llegó ${String(error)}`);
    assert.equal(error.kind, kind);
    if (code !== undefined) assert.equal(error.code, code);
    return error;
  }
  assert.fail("se esperaba un error");
}

const user = (id: string, fields: Partial<User> = {}): User => ({
  id,
  email: `${id}@example.com`,
  name: id,
  passwordDigest: "",
  status: "active",
  createdAt: NOW,
  failedLoginAttempts: 0,
  lockedUntil: null,
  ...fields,
});

class FailingMailer implements MailerPort {
  attempts = 0;
  async send(): Promise<void> {
    this.attempts += 1;
    throw new Error("SMTP caído");
  }
}

let clock: FixedClock;
let users: InMemoryUserRepository;
let memberships: InMemoryMembershipRepository;
let organizations: InMemoryOrganizationRepository;
let invitations: InMemoryInvitationRepository;

async function member(userId: string, role: Role, organizationId = "o1") {
  await memberships.save({ organizationId, userId, role, createdAt: NOW });
}

beforeEach(async () => {
  clock = new FixedClock(NOW);
  users = new InMemoryUserRepository();
  memberships = new InMemoryMembershipRepository();
  organizations = new InMemoryOrganizationRepository();
  invitations = new InMemoryInvitationRepository();
  await organizations.save({ id: "o1", name: "Acme", slug: "acme", createdAt: NOW });
});

describe("OrgRoleGuard y los decoradores de parámetro, fuera de la tubería", () => {
  const context = (request: Record<string, unknown>) =>
    ({
      switchToHttp: () => ({ getRequest: () => request }),
      getHandler: () => () => undefined,
      getClass: () => class {},
    }) as unknown as ExecutionContext;
  const reflector = (required: Role | undefined) => ({ getAllAndOverride: () => required }) as unknown as Reflector;

  test("sin identidad establecida es un 401; sin organización en la ruta, un 403", async () => {
    const guard = new OrgRoleGuard(reflector("viewer"), memberships);
    await rejectsWith(guard.canActivate(context({ params: { organizationId: "o1" } })), "unauthenticated");
    const principal = { kind: "user", userId: "u1", email: "u1@example.com" };
    await rejectsWith(guard.canActivate(context({ principal, params: {} })), "forbidden");
    await rejectsWith(guard.canActivate(context({ principal, params: { organizationId: ["o1", "o2"] } })), "forbidden");
    await rejectsWith(guard.canActivate(context({ principal })), "forbidden");
  });

  test("una ruta sin rol requerido pasa sin mirar nada", async () => {
    const guard = new OrgRoleGuard(reflector(undefined), memberships);
    assert.equal(await guard.canActivate(context({})), true);
  });

  /** El `factory` que Nest guarda para un decorador de parámetro, sacado de sus metadatos. */
  function factoryOf(decorator: () => ParameterDecorator) {
    class Target {
      method(_value: unknown) {}
    }
    decorator()(Target.prototype, "method", 0);
    const metadata = Reflect.getMetadata(ROUTE_ARGS_METADATA, Target, "method") as Record<string, { factory: (...args: unknown[]) => unknown }>;
    return Object.values(metadata)[0].factory as (data: unknown, context: ExecutionContext) => unknown;
  }

  test("@CurrentUser sin identidad es un 401; @CurrentRole devuelve el rol resuelto, o nada", () => {
    const currentUser = factoryOf(CurrentUser);
    assert.throws(() => currentUser(undefined, context({})), (error: unknown) => error instanceof DomainError && error.kind === "unauthenticated");
    const principal = { kind: "user", userId: "u1", email: "e" };
    assert.deepEqual(currentUser(undefined, context({ principal })), principal);

    const currentRole = factoryOf(CurrentRole);
    assert.equal(currentRole(undefined, context({ membershipRole: "admin" })), "admin");
    assert.equal(currentRole(undefined, context({})), undefined);
  });
});

describe("quién soy", () => {
  test("/me: un usuario que ya no existe es un 404; una organización borrada no se lista", async () => {
    const handler = new GetCurrentUserHandler(users, memberships, organizations);
    await rejectsWith(handler.execute(new GetCurrentUserQuery("fantasma")), "not-found", "user-not-found");

    await users.save(user("u1"));
    await member("u1", "owner");
    await member("u1", "viewer", "o-borrada");
    const view = await handler.execute(new GetCurrentUserQuery("u1"));
    assert.deepEqual(view.organizations, [{ id: "o1", name: "Acme", slug: "acme", role: "owner" }]);
  });

  test("/context: un token ve su organización como editor; sin organización es un 404", async () => {
    const handler = new GetAuthContextHandler(users, memberships, organizations);
    assert.deepEqual(await handler.execute(new GetAuthContextQuery({ kind: "api-token", organizationId: "o1", tokenId: "t1" })), {
      principal: "api-token",
      user: null,
      organizations: [{ id: "o1", name: "Acme", slug: "acme", role: "editor" }],
    });
    await rejectsWith(
      handler.execute(new GetAuthContextQuery({ kind: "api-token", organizationId: "no-existe", tokenId: "t1" })),
      "not-found",
      "organization-not-found",
    );
  });

  test("/context: un usuario con sus organizaciones vivas; uno que no existe es un 404", async () => {
    const handler = new GetAuthContextHandler(users, memberships, organizations);
    await rejectsWith(handler.execute(new GetAuthContextQuery({ kind: "user", userId: "nadie" })), "not-found", "user-not-found");
    await users.save(user("u1", { name: "Ana" }));
    await member("u1", "admin");
    await member("u1", "viewer", "o-borrada");
    assert.deepEqual(await handler.execute(new GetAuthContextQuery({ kind: "user", userId: "u1" })), {
      principal: "user",
      user: { id: "u1", email: "u1@example.com", name: "Ana" },
      organizations: [{ id: "o1", name: "Acme", slug: "acme", role: "admin" }],
    });
  });
});

describe("la cuenta", () => {
  test("cambiar la contraseña de un usuario que ya no existe es un 401", async () => {
    const handler = new ChangePasswordHandler(users, new InMemoryRefreshTokenRepository(), new FastTestPasswordHasher(), clock);
    await rejectsWith(handler.execute(new ChangePasswordCommand("nadie", "x", "Una-contraseña-larga-2")), "unauthenticated");
  });

  test("registrarse con un correo sin @ es un 422 que nombra el campo", async () => {
    const handler = new RegisterUserHandler(users, new FastTestPasswordHasher(), clock, {} as never, {} as never);
    const error = await rejectsWith(handler.execute(new RegisterUserCommand("sin-arroba", "Una-contraseña-larga-1", "x")), "invalid");
    assert.deepEqual(error.fields.map((field) => field.field), ["email"]);
    assert.equal((await users.findByEmail("sin-arroba")) ?? null, null);
  });

  test("sin nombre, la cuenta se llama como la parte local del correo y la organización también", async () => {
    const executed: unknown[] = [];
    const published: unknown[] = [];
    const commandBus = { execute: async (command: unknown) => (executed.push(command), { organizationId: "o-nueva" }) };
    const eventBus = { publish: (event: unknown) => published.push(event) };
    const handler = new RegisterUserHandler(users, new FastTestPasswordHasher(), clock, commandBus as never, eventBus as never);
    const result = await handler.execute(new RegisterUserCommand("Marta@Example.com", "Una-contraseña-larga-1", "   ", "  "));
    assert.equal(result.organizationId, "o-nueva");
    const stored = await users.findById(result.userId);
    assert.equal(stored?.name, "marta");
    assert.equal((executed[0] as CreateOrganizationCommand).name, "marta");
    assert.ok(published[0] instanceof UserRegisteredEvent);
  });

  test("revocar un token ya revocado no lo vuelve a tocar", async () => {
    const tokens = new InMemoryApiTokenRepository();
    const revokedAt = new Date("2026-01-01T00:00:00Z");
    await tokens.save({
      id: "t1",
      organizationId: "o1",
      name: "ci",
      tokenHash: "h",
      preview: "eqt_ab",
      createdBy: "u1",
      createdAt: revokedAt,
      lastUsedAt: null,
      revokedAt,
    });
    const handler = new RevokeApiTokenHandler(tokens, clock);
    await handler.execute(new RevokeApiTokenCommand("o1", "t1"));
    assert.equal((await tokens.findById("t1"))?.revokedAt?.getTime(), revokedAt.getTime());
    await rejectsWith(handler.execute(new RevokeApiTokenCommand("otra", "t1")), "not-found", "api-token-not-found");
  });

  test("el correo de restablecer que no sale no rompe nada: la respuesta es la misma", async () => {
    await users.save(user("u1"));
    const mailer = new FailingMailer();
    const resets = new InMemoryPasswordResetRepository();
    const handler = new RequestPasswordResetHandler(users, resets, mailer, clock, env);
    await handler.execute(new RequestPasswordResetCommand("U1@example.com"));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(mailer.attempts, 1);
  });

  test("la bienvenida: sin usuario usa el correo como nombre; un fallo del correo se traga", async () => {
    const mailer = new RecordingMailer();
    await new SendWelcomeMailHandler(users, mailer, env).handle(new UserRegisteredEvent("nadie", "nadie@example.com", "o1", NOW));
    assert.equal(mailer.sent.length, 1);
    assert.equal(mailer.sent[0].to, "nadie@example.com");
    assert.match(mailer.sent[0].text, /nadie@example\.com/);
    assert.match(mailer.sent[0].text, /https:\/\/app\.example\.com\/login/);

    const failing = new FailingMailer();
    await new SendWelcomeMailHandler(users, failing, env).handle(new UserRegisteredEvent("nadie", "nadie@example.com", "o1", NOW));
    assert.equal(failing.attempts, 1);
  });
});

describe("miembros", () => {
  beforeEach(async () => {
    for (const id of ["owner", "admin", "editor", "viewer"]) await users.save(user(id));
    await member("owner", "owner");
    await member("admin", "admin");
    await member("editor", "editor");
  });

  test("cambiar un rol: quien no es admin, quien sube por encima de sí, un no miembro y un superior", async () => {
    const handler = new ChangeMemberRoleHandler(memberships);
    // (organización, a quién, qué rol, quién lo pide)
    await rejectsWith(handler.execute(new ChangeMemberRoleCommand("o1", "admin", "viewer", "editor")), "forbidden");
    await rejectsWith(handler.execute(new ChangeMemberRoleCommand("o1", "admin", "viewer", "nadie")), "forbidden");
    await rejectsWith(handler.execute(new ChangeMemberRoleCommand("o1", "editor", "owner", "admin")), "forbidden", "role-escalation");
    await rejectsWith(handler.execute(new ChangeMemberRoleCommand("o1", "nadie", "viewer", "admin")), "not-found", "membership-not-found");
    await rejectsWith(handler.execute(new ChangeMemberRoleCommand("o1", "owner", "viewer", "admin")), "forbidden", "role-escalation");
    assert.equal((await memberships.find("o1", "owner"))?.role, "owner");
  });

  test("expulsar: quien no pertenece, un no miembro, quien no es admin y un superior", async () => {
    const handler = new RemoveMemberHandler(memberships);
    // (organización, a quién, quién lo pide)
    await rejectsWith(handler.execute(new RemoveMemberCommand("o1", "admin", "nadie")), "forbidden");
    await rejectsWith(handler.execute(new RemoveMemberCommand("o1", "nadie", "admin")), "not-found", "membership-not-found");
    await rejectsWith(handler.execute(new RemoveMemberCommand("o1", "owner", "editor")), "forbidden");
    await rejectsWith(handler.execute(new RemoveMemberCommand("o1", "owner", "admin")), "forbidden", "role-escalation");
    // Irse uno mismo sí, siendo solo editor.
    await handler.execute(new RemoveMemberCommand("o1", "editor", "editor"));
    assert.equal(await memberships.find("o1", "editor"), null);
  });

  test("invitar: quien no es admin, con rol superior, una invitación pendiente; y el correo que falla no rompe", async () => {
    const recording = new RecordingMailer();
    const handler = new InviteMemberHandler(invitations, memberships, organizations, recording, clock, env);
    await rejectsWith(handler.execute(new InviteMemberCommand("o1", "x@example.com", "viewer", "editor")), "forbidden");
    await rejectsWith(handler.execute(new InviteMemberCommand("o1", "x@example.com", "owner", "admin")), "forbidden", "role-escalation");

    await handler.execute(new InviteMemberCommand("o1", "X@Example.com", "viewer", "admin"));
    await rejectsWith(handler.execute(new InviteMemberCommand("o1", "x@example.com ", "editor", "admin")), "conflict", "invitation-pending");
    assert.match(recording.sent[0].text, /Acme/);
    assert.match(recording.sent[0].text, /https:\/\/app\.example\.com\/register\?invitation=/);

    // Una organización sin fila se nombra «tu equipo», y el correo que no sale solo se registra.
    const failing = new FailingMailer();
    await member("admin", "admin", "o-sin-fila");
    const other = new InviteMemberHandler(invitations, memberships, organizations, failing, clock, env);
    const result = await other.execute(new InviteMemberCommand("o-sin-fila", "y@example.com", "viewer", "admin"));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(failing.attempts, 1);
    assert.ok(result.invitationId);
  });

  test("aceptar: una invitación caducada y un usuario que no existe son 404", async () => {
    const token = generateOpaqueToken();
    await invitations.save({
      id: "i1",
      organizationId: "o1",
      email: "viewer@example.com",
      role: "viewer",
      tokenHash: hashOpaqueToken(token),
      invitedBy: "admin",
      createdAt: NOW,
      expiresAt: new Date(NOW.getTime() + 1000),
      acceptedAt: null,
      revokedAt: null,
    });
    const handler = new AcceptInvitationHandler(invitations, memberships, users, clock);
    await rejectsWith(handler.execute(new AcceptInvitationCommand(token, "nadie")), "not-found", "user-not-found");
    clock.advance(1000);
    await rejectsWith(handler.execute(new AcceptInvitationCommand(token, "viewer")), "not-found", "invitation-expired");
    assert.equal(await memberships.find("o1", "viewer"), null);
  });

  test("la lista de miembros omite a quien ya no tiene cuenta", async () => {
    await member("borrado", "viewer");
    const view = await new ListMembersHandler(memberships, invitations, users).execute(new ListMembersQuery("o1"));
    assert.deepEqual(view.members.map((row) => row.userId).sort(), ["admin", "editor", "owner"]);
  });

  test("con el slug y sus 998 sucesores ocupados, el sufijo es aleatorio", async () => {
    const taken = {
      findBySlug: async () => ({ id: "x" }),
      save: async () => undefined,
    };
    const handler = new CreateOrganizationHandler(taken as never, memberships, clock);
    const result = await handler.execute(new CreateOrganizationCommand("Acme", "owner"));
    assert.match(result.slug, /^acme-[0-9a-f]{8}$/);
  });
});
