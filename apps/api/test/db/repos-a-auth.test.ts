/**
 * The auth adapters against a real Postgres (an isolated schema): lower-cased emails, the
 * one-statement revocations and what they leave alone, and the api-token listing per organization.
 */
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import {
  ApiTokenEntity,
  PasswordResetTokenEntity,
  RefreshTokenEntity,
  UserEntity,
} from "@/shared/database/entities";
import {
  TypeOrmApiTokenRepository,
  TypeOrmRefreshTokenRepository,
  TypeOrmUserRepository,
} from "@/modules/auth/infrastructure/persistence/typeorm-repositories";
import { TypeOrmPasswordResetRepository } from "@/modules/auth/infrastructure/persistence/typeorm-password-reset.repository";
import type { ApiToken, RefreshToken, User } from "@/modules/auth/domain/model";
import type { PasswordResetToken } from "@/modules/auth/domain/password-reset";
import { dbSkip, openIsolatedDb, type IsolatedDb } from "@test/support/isolated-db";
import { insertOrganization, insertUser } from "@test/support/repos-seed";

const hash = () => randomUUID().replace(/-/g, "");
const at = (iso: string) => new Date(iso);

describe("auth persistence adapters", { skip: dbSkip }, () => {
  let db: IsolatedDb;
  before(async () => {
    db = await openIsolatedDb();
  });
  after(async () => db?.drop());

  describe("TypeOrmUserRepository", () => {
    const repo = () => new TypeOrmUserRepository(db.dataSource.getRepository(UserEntity));
    const user = (overrides: Partial<User> = {}): User => ({
      id: randomUUID(),
      email: `Mixed.${randomUUID().slice(0, 6)}@Example.TEST`,
      name: "Ada",
      passwordDigest: "argon2$x",
      status: "active",
      createdAt: at("2026-01-02T03:04:05.678Z"),
      failedLoginAttempts: 0,
      lockedUntil: null,
      ...overrides,
    });

    test("save lower-cases the email and findById round-trips every field", async () => {
      const u = user({ status: "invited", failedLoginAttempts: 3, lockedUntil: at("2026-05-05T00:00:00Z") });
      await repo().save(u);
      const found = await repo().findById(u.id);
      assert.deepEqual(found, { ...u, email: u.email.toLowerCase() });
    });

    test("findByEmail matches whatever capitalisation is typed", async () => {
      const u = user();
      await repo().save(u);
      assert.equal((await repo().findByEmail(u.email.toUpperCase()))?.id, u.id);
      assert.equal((await repo().findByEmail(u.email.toLowerCase()))?.id, u.id);
    });

    test("not found is null, by id and by email", async () => {
      assert.equal(await repo().findById(randomUUID()), null);
      assert.equal(await repo().findByEmail("nobody@example.test"), null);
    });

    test("save of an existing id updates it in place", async () => {
      const u = user();
      await repo().save(u);
      await repo().save({ ...u, name: "Grace", status: "disabled", failedLoginAttempts: 5 });
      const found = await repo().findById(u.id);
      assert.equal(found?.name, "Grace");
      assert.equal(found?.status, "disabled");
      assert.equal(found?.failedLoginAttempts, 5);
    });

    test("two accounts differing only in case collide on the unique email", async () => {
      const u = user({ email: "twin@example.test" });
      await repo().save(u);
      await assert.rejects(repo().save(user({ email: "TWIN@example.test" })), /duplicate key|unique/i);
    });
  });

  describe("TypeOrmRefreshTokenRepository", () => {
    const repo = () => new TypeOrmRefreshTokenRepository(db.dataSource.getRepository(RefreshTokenEntity));
    const token = (userId: string, sessionId: string, overrides: Partial<RefreshToken> = {}): RefreshToken => ({
      id: randomUUID(),
      userId,
      sessionId,
      tokenHash: hash(),
      expiresAt: at("2030-01-01T00:00:00Z"),
      createdAt: at("2026-01-01T00:00:00Z"),
      usedAt: null,
      revokedAt: null,
      replacedByHash: null,
      ...overrides,
    });

    test("save/findByHash round-trip, and an unknown hash is null", async () => {
      const userId = await insertUser(db.dataSource);
      const t = token(userId, randomUUID());
      await repo().save(t);
      assert.deepEqual(await repo().findByHash(t.tokenHash), t);
      assert.equal(await repo().findByHash(hash()), null);
    });

    test("markUsed stamps usedAt and the hash of its replacement", async () => {
      const userId = await insertUser(db.dataSource);
      const t = token(userId, randomUUID());
      await repo().save(t);
      const replacement = hash();
      await repo().markUsed(t.id, at("2026-02-02T00:00:00Z"), replacement);
      const found = await repo().findByHash(t.tokenHash);
      assert.deepEqual(found?.usedAt, at("2026-02-02T00:00:00Z"));
      assert.equal(found?.replacedByHash, replacement);
    });

    test("revokeSession closes that session only, and keeps an earlier revocation date", async () => {
      const userId = await insertUser(db.dataSource);
      const session = randomUUID();
      const other = randomUUID();
      const early = at("2026-01-10T00:00:00Z");
      const a = token(userId, session);
      const b = token(userId, session, { revokedAt: early });
      const c = token(userId, other);
      for (const t of [a, b, c]) await repo().save(t);

      await repo().revokeSession(session, at("2026-03-03T00:00:00Z"));

      assert.deepEqual((await repo().findByHash(a.tokenHash))?.revokedAt, at("2026-03-03T00:00:00Z"));
      assert.deepEqual((await repo().findByHash(b.tokenHash))?.revokedAt, early);
      assert.equal((await repo().findByHash(c.tokenHash))?.revokedAt, null);
    });

    test("revokeAllForUser closes every live session of that user and nobody else's", async () => {
      const userId = await insertUser(db.dataSource);
      const otherUser = await insertUser(db.dataSource);
      const a = token(userId, randomUUID());
      const b = token(userId, randomUUID());
      const c = token(otherUser, randomUUID());
      for (const t of [a, b, c]) await repo().save(t);

      await repo().revokeAllForUser(userId, at("2026-04-04T00:00:00Z"));

      assert.deepEqual((await repo().findByHash(a.tokenHash))?.revokedAt, at("2026-04-04T00:00:00Z"));
      assert.deepEqual((await repo().findByHash(b.tokenHash))?.revokedAt, at("2026-04-04T00:00:00Z"));
      assert.equal((await repo().findByHash(c.tokenHash))?.revokedAt, null);
    });

    test("a token for a user that does not exist violates the foreign key", async () => {
      await assert.rejects(repo().save(token(randomUUID(), randomUUID())), /foreign key/i);
    });
  });

  describe("TypeOrmApiTokenRepository", () => {
    const repo = () => new TypeOrmApiTokenRepository(db.dataSource.getRepository(ApiTokenEntity));
    const token = (organizationId: string, overrides: Partial<ApiToken> = {}): ApiToken => ({
      id: randomUUID(),
      organizationId,
      name: "ci",
      tokenHash: hash(),
      preview: "eq_abc…",
      createdBy: randomUUID(),
      createdAt: at("2026-01-01T00:00:00Z"),
      lastUsedAt: null,
      revokedAt: null,
      ...overrides,
    });

    test("findByHash and findById round-trip; unknown ones are null", async () => {
      const org = await insertOrganization(db.dataSource);
      const t = token(org, { revokedAt: at("2026-06-01T00:00:00Z") });
      await repo().save(t);
      assert.deepEqual(await repo().findByHash(t.tokenHash), t);
      assert.deepEqual(await repo().findById(t.id), t);
      assert.equal(await repo().findByHash(hash()), null);
      assert.equal(await repo().findById(randomUUID()), null);
    });

    test("listForOrganization is newest first and never shows another organization's tokens", async () => {
      const org = await insertOrganization(db.dataSource);
      const other = await insertOrganization(db.dataSource);
      const older = token(org, { name: "older", createdAt: at("2026-01-01T00:00:00Z") });
      const newer = token(org, { name: "newer", createdAt: at("2026-02-01T00:00:00Z") });
      const foreign = token(other, { name: "foreign" });
      for (const t of [older, newer, foreign]) await repo().save(t);

      const listed = await repo().listForOrganization(org);
      assert.deepEqual(
        listed.map((t) => t.name),
        ["newer", "older"],
      );
      assert.deepEqual(await repo().listForOrganization(randomUUID()), []);
    });

    test("touch records the last use without changing anything else", async () => {
      const org = await insertOrganization(db.dataSource);
      const t = token(org);
      await repo().save(t);
      await repo().touch(t.id, at("2026-07-07T07:07:07Z"));
      assert.deepEqual(await repo().findById(t.id), { ...t, lastUsedAt: at("2026-07-07T07:07:07Z") });
    });
  });

  describe("TypeOrmPasswordResetRepository", () => {
    const repo = () => new TypeOrmPasswordResetRepository(db.dataSource.getRepository(PasswordResetTokenEntity));
    const token = (userId: string, overrides: Partial<PasswordResetToken> = {}): PasswordResetToken => ({
      id: randomUUID(),
      userId,
      tokenHash: hash(),
      createdAt: at("2026-01-01T00:00:00Z"),
      expiresAt: at("2026-01-01T01:00:00Z"),
      usedAt: null,
      ...overrides,
    });

    test("save/findByHash round-trip; an unknown hash is null", async () => {
      const userId = await insertUser(db.dataSource);
      const t = token(userId);
      await repo().save(t);
      assert.deepEqual(await repo().findByHash(t.tokenHash), t);
      assert.equal(await repo().findByHash(hash()), null);
    });

    test("spendAllForUser spends every unused link of that user, keeps earlier spends, and leaves others", async () => {
      const userId = await insertUser(db.dataSource);
      const otherUser = await insertUser(db.dataSource);
      const earlier = at("2026-01-01T00:30:00Z");
      const a = token(userId);
      const b = token(userId, { usedAt: earlier });
      const c = token(otherUser);
      for (const t of [a, b, c]) await repo().save(t);

      await repo().spendAllForUser(userId, at("2026-01-01T00:45:00Z"));

      assert.deepEqual((await repo().findByHash(a.tokenHash))?.usedAt, at("2026-01-01T00:45:00Z"));
      assert.deepEqual((await repo().findByHash(b.tokenHash))?.usedAt, earlier);
      assert.equal((await repo().findByHash(c.tokenHash))?.usedAt, null);
    });

    test("a reset link goes with its user (cascade)", async () => {
      const userId = await insertUser(db.dataSource);
      const t = token(userId);
      await repo().save(t);
      await db.dataSource.query(`DELETE FROM "users" WHERE "id" = $1`, [userId]);
      assert.equal(await repo().findByHash(t.tokenHash), null);
    });
  });
});
